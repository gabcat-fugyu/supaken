// member.supaken.com の入口。
//
//   /api/discord/login     Discord のログイン画面へ
//   /api/discord/callback  Discord から戻ってきたところ。メン限ロールを確認してログイン
//   /api/me, /api/logout   ログイン状態
//   /api/data/...          戦績データ(R2 の members/...)。ログインした人だけ
//   それ以外                site/member の画面ファイル
//
// 使うもの(wrangler.toml / secret):
//   DB    … D1(sessions / discord_users)
//   DATA  … R2(戦績データ)
//   DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET … Discord のアプリの合鍵
//   DISCORD_GUILD_ID, DISCORD_MEMBER_ROLE_ID … どのサーバーのどのロールを持っていれば入れるか
//   DISCORD_EXTRA_IDS … ロールが無くても入れる人の Discord ユーザーID(カンマ区切り)

const SESSION_DAYS = 30;   // メンバーシップをやめた人が残り続けないよう、ひと月で入り直し
const DISCORD = "https://discord.com/api";

// ---- 小物 ----
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
const fail = (status, message) => json({ error: message }, status);
const now = () => Math.floor(Date.now() / 1000);
const redirect = (location, cookies = []) => {
  const h = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(null, { status: 302, headers: h });
};

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function readCookie(request, name) {
  const m = (request.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}
const cookie = (name, value, maxAge) =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

// ---- セッション ----
// sessions.tag に "d:<DiscordユーザーID>" を入れる
async function currentUserId(request, env) {
  const sid = readCookie(request, "sid");
  if (!sid) return null;
  const row = await env.DB.prepare("SELECT tag FROM sessions WHERE token = ? AND expires_at > ?").bind(sid, now()).first();
  return row && row.tag.startsWith("d:") ? row.tag.slice(2) : null;
}

async function startSession(env, discordId) {
  const token = randomHex(32);
  const maxAge = SESSION_DAYS * 86400;
  await env.DB.prepare("INSERT INTO sessions (token, tag, expires_at) VALUES (?, ?, ?)")
    .bind(token, "d:" + discordId, now() + maxAge).run();
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now()).run();
  return cookie("sid", token, maxAge);
}

async function me(env, id) {
  const row = await env.DB.prepare("SELECT id, name, avatar, tag FROM discord_users WHERE id = ?").bind(id).first();
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar ? `https://cdn.discordapp.com/avatars/${row.id}/${row.avatar}.png?size=64` : null,
    tag: row.tag || null,
  };
}

// ---- Discord ログイン ----
function discordLogin(request, env) {
  const url = new URL(request.url);
  const state = randomHex(16);
  const q = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    response_type: "code",
    redirect_uri: `${url.origin}/api/discord/callback`,
    scope: "identify guilds.members.read",
    state,
    prompt: "none",
  });
  return redirect(`https://discord.com/oauth2/authorize?${q}`, [cookie("oauth_state", state, 600)]);
}

async function discordCallback(request, env) {
  const url = new URL(request.url);
  const clear = cookie("oauth_state", "", 0);
  const back = (reason) => redirect(`/?login=${reason}`, [clear]);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code) return back("cancel");                       // 「キャンセル」を押した
  if (!state || state !== readCookie(request, "oauth_state")) return back("expired");

  // 合言葉(code)を、Discord のアクセス用の鍵に替える
  const tokenRes = await fetch(`${DISCORD}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: `${url.origin}/api/discord/callback`,
    }),
  });
  if (!tokenRes.ok) return back("error");
  const { access_token } = await tokenRes.json();
  const auth = { Authorization: `Bearer ${access_token}` };

  const userRes = await fetch(`${DISCORD}/users/@me`, { headers: auth });
  if (!userRes.ok) return back("error");
  const user = await userRes.json();

  // そのサーバーでの自分のロール(サーバーに入っていなければ 404)
  const extra = String(env.DISCORD_EXTRA_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  let allowed = extra.includes(user.id);
  let nick = null;
  if (!allowed) {
    const memRes = await fetch(`${DISCORD}/users/@me/guilds/${env.DISCORD_GUILD_ID}/member`, { headers: auth });
    if (memRes.status === 404) return back("guild");
    if (!memRes.ok) return back("error");
    const member = await memRes.json();
    nick = member.nick;
    allowed = (member.roles || []).includes(env.DISCORD_MEMBER_ROLE_ID);
  }
  if (!allowed) return back("role");

  const name = nick || user.global_name || user.username;
  const ts = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO discord_users (id, name, avatar, created_at, last_login) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, avatar = excluded.avatar, last_login = excluded.last_login`
  ).bind(user.id, name, user.avatar || null, ts, ts).run();

  return redirect("/", [clear, await startSession(env, user.id)]);
}

async function logout(request, env) {
  const sid = readCookie(request, "sid");
  if (sid) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(sid).run();
  return json({ ok: true }, 200, { "set-cookie": cookie("sid", "", 0) });
}

async function data(request, env, url) {
  if (!(await currentUserId(request, env))) return fail(401, "ログインしてください");
  const rel = decodeURIComponent(url.pathname.slice("/api/data/".length));
  if (!rel || rel.includes("..") || rel.startsWith("/")) return fail(400, "bad path");
  const obj = await env.DATA.get("members/" + rel);
  if (!obj) return fail(404, "not found");
  return new Response(obj.body, {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p.startsWith("/api/data/")) return await data(request, env, url);
      if (p === "/api/me") {
        const id = await currentUserId(request, env);
        const user = id && await me(env, id);
        return user ? json(user) : fail(401, "ログインしていません");
      }
      if (p === "/api/discord/login") return discordLogin(request, env);
      if (p === "/api/discord/callback") return await discordCallback(request, env);
      if (p === "/api/logout" && request.method === "POST") return await logout(request, env);
      if (p.startsWith("/api/")) return fail(404, "not found");
    } catch (e) {
      return fail(500, "サーバーでエラーが起きました: " + (e && e.message || e));
    }
    return env.ASSETS.fetch(request);
  },
};
