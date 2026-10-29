// supaken.com の入口。
//
// 画面(site/ フォルダ)
//   /            トップ(スパ研便利ツール)。誰でも
//   /ranking/    スパーキーランキング。誰でも
//   /member/     メン限ページ。中身のデータはログインした人だけ
//   member.supaken.com は /member/ へ転送する(前のリンク用)
//
// API
//   /api/discord/login, /api/discord/callback   Discord でログイン(メン限ロールを確認)
//   /api/me, /api/logout                         ログイン状態
//   /api/profile                                 表示名と、結びつけたゲームアカウント
//   /api/accounts/start, /finish                 ゲームアカウントを追加(デッキに指定のカードを入れて本人確認)
//   /api/accounts/remove, /main                  外す・メインにする
//   /api/data/...                                戦績データ(R2 の members/...)
//
// 使うもの(wrangler.toml / secret):
//   DB    … D1(sessions / discord_users / profiles / game_accounts / link_challenges)
//   DATA  … R2(戦績データ。members/roster.json にアカウントの結びつきを書き出す)
//   DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_GUILD_ID, DISCORD_MEMBER_ROLE_ID, DISCORD_EXTRA_IDS
//   CR_API_TOKEN … クラロワAPI(本人確認でプロフィールを見る)

const SESSION_DAYS = 30;          // メンバーシップをやめた人が残り続けないよう、ひと月で入り直し
const CHALLENGE_MINUTES = 30;     // 本人確認の有効時間
const MAX_SUBS = 2;               // サブアカウントの上限(メインは1つ)
const DISCORD = "https://discord.com/api";
const CR_API = "https://proxy.royaleapi.dev/v1";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const MAIN_HOST = "supaken.com";

// ---- 小物 ----
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
const fail = (status, message) => json({ error: message }, status);
const now = () => Math.floor(Date.now() / 1000);
const cleanTag = (t) => String(t || "").toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g, "0");
const redirect = (location, cookies = [], status = 302) => {
  const h = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(null, { status, headers: h });
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

async function readBody(request) {
  try { return await request.json(); } catch { return {}; }
}

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
  const row = await env.DB.prepare(
    `SELECT u.id, u.name, u.avatar, p.display_name FROM discord_users u
     LEFT JOIN profiles p ON p.discord_id = u.id WHERE u.id = ?`
  ).bind(id).first();
  if (!row) return null;
  return {
    id: row.id,
    name: row.display_name || row.name,
    discordName: row.name,
    avatar: row.avatar ? `https://cdn.discordapp.com/avatars/${row.id}/${row.avatar}.png?size=64` : null,
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
  const back = (reason) => redirect(`/member/?login=${reason}`, [clear]);

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

  return redirect("/member/", [clear, await startSession(env, user.id)]);
}

async function logout(request, env) {
  const sid = readCookie(request, "sid");
  if (sid) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(sid).run();
  return json({ ok: true }, 200, { "set-cookie": cookie("sid", "", 0) });
}

// ---- プロフィールとゲームアカウント ----
async function myAccounts(env, id) {
  const { results } = await env.DB.prepare(
    "SELECT tag, role, name, added_at FROM game_accounts WHERE discord_id = ? ORDER BY role = 'main' DESC, added_at"
  ).bind(id).all();
  return results || [];
}

// 全員分の結びつきを R2 に書き出す。収集(collect.py)と順位表がこれを読む
async function writeRoster(env) {
  const { results } = await env.DB.prepare(
    `SELECT g.tag, g.discord_id, g.role, g.name, g.added_at, p.display_name, u.name AS discord_name
     FROM game_accounts g
     LEFT JOIN profiles p ON p.discord_id = g.discord_id
     LEFT JOIN discord_users u ON u.id = g.discord_id
     ORDER BY g.discord_id, g.role = 'main' DESC, g.added_at`
  ).all();
  const users = new Map();
  for (const r of results || []) {
    if (!users.has(r.discord_id)) {
      users.set(r.discord_id, { id: r.discord_id, displayName: r.display_name || r.discord_name || null, accounts: [] });
    }
    users.get(r.discord_id).accounts.push({ tag: r.tag, role: r.role, name: r.name });
  }
  const roster = { updatedAt: new Date().toISOString(), users: [...users.values()] };
  await env.DATA.put("members/roster.json", JSON.stringify(roster), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

async function profile(env, id) {
  return { me: await me(env, id), accounts: await myAccounts(env, id) };
}

async function setProfile(request, env, id) {
  const name = String((await readBody(request)).displayName || "").trim();
  if (!name) return fail(400, "表示名を入れてください");
  if ([...name].length > 16) return fail(400, "表示名は16文字までです");
  await env.DB.prepare(
    `INSERT INTO profiles (discord_id, display_name, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(discord_id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at`
  ).bind(id, name, new Date().toISOString()).run();
  await writeRoster(env);
  return json(await profile(env, id));
}

async function crPlayer(env, tag) {
  const res = await fetch(`${CR_API}/players/%23${tag}`, {
    headers: { Authorization: `Bearer ${env.CR_API_TOKEN}`, Accept: "application/json", "User-Agent": UA },
  });
  if (!res.ok) return null;
  return res.json();
}

// 追加してよいか(メイン1+サブ2まで、他の人のアカウントは不可)
async function checkAdd(env, id, tag, role) {
  const owner = await env.DB.prepare("SELECT discord_id FROM game_accounts WHERE tag = ?").bind(tag).first();
  if (owner && owner.discord_id === id) return "このアカウントはもう登録しています";
  if (owner) return "このアカウントは他の人が登録しています";
  const mine = await myAccounts(env, id);
  if (mine.length >= 1 + MAX_SUBS) return `登録できるのはメイン1つとサブ${MAX_SUBS}つまでです`;
  // メインを追加したときは今のメインがサブに回る。合計3つまでなので、サブも2つに収まる
  const subs = mine.filter((a) => a.role === "sub").length;
  if (role === "sub" && subs >= MAX_SUBS) return `サブは${MAX_SUBS}つまでです`;
  return null;
}

async function accountStart(request, env, id) {
  const body = await readBody(request);
  const tag = cleanTag(body.tag);
  let role = body.role === "main" ? "main" : "sub";
  if (!tag) return fail(400, "タグを入れてください");
  const mine = await myAccounts(env, id);
  if (!mine.some((a) => a.role === "main")) role = "main";      // 最初の1つは必ずメイン
  const problem = await checkAdd(env, id, tag, role);
  if (problem) return fail(400, problem);

  const player = await crPlayer(env, tag);
  if (!player) return fail(404, "プレイヤーが見つかりませんでした。タグを確かめてください");
  // 本人確認: 今のデッキに入っていない手持ちのカードを1枚選び、デッキに入れてもらう。
  // (お気に入りカードはゲーム側が自動で決めるので変えられない)
  // チャンピオンは1枚しか入らず入れ替えが面倒なので外す
  const inDeck = new Set((player.currentDeck || []).map((c) => c.id));
  const pool = (player.cards || []).filter((c) =>
    !inDeck.has(c.id) && c.iconUrls?.medium && String(c.rarity || "").toLowerCase() !== "champion");
  if (!pool.length) return fail(500, "カードの情報が取れませんでした");
  const card = pool[Math.floor(Math.random() * pool.length)];

  await env.DB.prepare(
    `INSERT OR REPLACE INTO link_challenges (discord_id, tag, role, card_id, card_name, card_icon, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, tag, role, card.id, card.name, card.iconUrls.medium, now() + CHALLENGE_MINUTES * 60).run();

  return json({ tag, role, playerName: player.name, card: { name: card.name, icon: card.iconUrls.medium } });
}

async function accountFinish(request, env, id) {
  const ch = await env.DB.prepare("SELECT * FROM link_challenges WHERE discord_id = ?").bind(id).first();
  if (!ch || ch.expires_at < now()) return fail(400, "時間切れです。もう一度はじめからやってください");
  const problem = await checkAdd(env, id, ch.tag, ch.role);
  if (problem) return fail(400, problem);

  const player = await crPlayer(env, ch.tag);
  if (!player) return fail(502, "クラロワのプロフィールが取れませんでした。少し待ってもう一度押してください");
  if (!(player.currentDeck || []).some((c) => c.id === ch.card_id)) {
    return fail(400, `まだデッキに ${ch.card_name} が入っていません。入れたばかりなら、1〜2分待ってからもう一度押してください`);
  }

  const ts = new Date().toISOString();
  const stmts = [];
  if (ch.role === "main") {
    stmts.push(env.DB.prepare("UPDATE game_accounts SET role = 'sub' WHERE discord_id = ? AND role = 'main'").bind(id));
  }
  stmts.push(env.DB.prepare("INSERT INTO game_accounts (tag, discord_id, role, name, added_at) VALUES (?, ?, ?, ?, ?)")
    .bind(ch.tag, id, ch.role, player.name, ts));
  stmts.push(env.DB.prepare("DELETE FROM link_challenges WHERE discord_id = ?").bind(id));
  await env.DB.batch(stmts);
  await writeRoster(env);
  return json(await profile(env, id));
}

async function accountRemove(request, env, id) {
  const tag = cleanTag((await readBody(request)).tag);
  const row = await env.DB.prepare("SELECT role FROM game_accounts WHERE tag = ? AND discord_id = ?").bind(tag, id).first();
  if (!row) return fail(404, "そのアカウントは登録されていません");
  await env.DB.prepare("DELETE FROM game_accounts WHERE tag = ?").bind(tag).run();
  // メインを外したら、一番古いサブをメインにする
  if (row.role === "main") {
    const next = (await myAccounts(env, id))[0];
    if (next) await env.DB.prepare("UPDATE game_accounts SET role = 'main' WHERE tag = ?").bind(next.tag).run();
  }
  await writeRoster(env);
  return json(await profile(env, id));
}

async function accountMain(request, env, id) {
  const tag = cleanTag((await readBody(request)).tag);
  const row = await env.DB.prepare("SELECT role FROM game_accounts WHERE tag = ? AND discord_id = ?").bind(tag, id).first();
  if (!row) return fail(404, "そのアカウントは登録されていません");
  await env.DB.batch([
    env.DB.prepare("UPDATE game_accounts SET role = 'sub' WHERE discord_id = ?").bind(id),
    env.DB.prepare("UPDATE game_accounts SET role = 'main' WHERE tag = ?").bind(tag),
  ]);
  await writeRoster(env);
  return json(await profile(env, id));
}

// ---- 戦績データ ----
async function data(env, url) {
  const rel = decodeURIComponent(url.pathname.slice("/api/data/".length));
  if (!rel || rel.includes("..") || rel.startsWith("/")) return fail(400, "bad path");
  const obj = await env.DATA.get("members/" + rel);
  if (!obj) {
    if (rel === "roster.json") return json({ users: [] });      // まだ誰も登録していない
    return fail(404, "not found");
  }
  return new Response(obj.body, {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const post = request.method === "POST";

    // 前のリンク(member.supaken.com)はメン限ページへ
    if (url.hostname !== MAIN_HOST && !p.startsWith("/api/")) {
      return redirect(`https://${MAIN_HOST}/member/`, [], 301);
    }

    try {
      if (p === "/api/discord/login") return discordLogin(request, env);
      if (p === "/api/discord/callback") return await discordCallback(request, env);
      if (p === "/api/logout" && post) return await logout(request, env);

      if (p.startsWith("/api/")) {
        // ここから先はログインした人だけ
        const id = await currentUserId(request, env);
        if (!id) return fail(401, "ログインしてください");
        if (p.startsWith("/api/data/")) return await data(env, url);
        if (p === "/api/me") {
          const user = await me(env, id);
          return user ? json(user) : fail(401, "ログインしてください");
        }
        if (p === "/api/profile") return post ? await setProfile(request, env, id) : json(await profile(env, id));
        if (p === "/api/accounts/start" && post) return await accountStart(request, env, id);
        if (p === "/api/accounts/finish" && post) return await accountFinish(request, env, id);
        if (p === "/api/accounts/remove" && post) return await accountRemove(request, env, id);
        if (p === "/api/accounts/main" && post) return await accountMain(request, env, id);
        return fail(404, "not found");
      }
    } catch (e) {
      return fail(500, "サーバーでエラーが起きました: " + (e && e.message || e));
    }
    return env.ASSETS.fetch(request);
  },
};
