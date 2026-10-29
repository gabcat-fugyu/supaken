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
//   /api/accounts/add, /remove, /main            ゲームアカウントを追加・外す・メインにする
//   /api/titles, /api/titles/equip               持っている称号と、上下に付ける称号
//   /api/admin/accounts, /api/admin/remove       管理人: 全員の登録を見る・外す
//   /api/admin/titles, /grant, /revoke           管理人: ユニーク称号を付ける・外す
//   /api/admin/guests, /add, /remove             管理人: メン限ロールが無くても入れる人
//   /api/data/...                                戦績データ(R2 の members/...)
//
// 使うもの(wrangler.toml / secret):
//   DB    … D1(sessions / discord_users / profiles / game_accounts / title_grants / title_equips)
//   DATA  … R2(戦績データ。members/roster.json にアカウントの結びつきを書き出す)
//   DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_GUILD_ID, DISCORD_MEMBER_ROLE_ID, DISCORD_EXTRA_IDS
//   ADMIN_DISCORD_IDS … 管理人の Discord ユーザーID(カンマ区切り)
//   CR_API_TOKEN … クラロワAPI(登録するタグが本当にあるか確かめる)

const SESSION_DAYS = 30;          // メンバーシップをやめた人が残り続けないよう、ひと月で入り直し
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

const isAdmin = (env, id) =>
  String(env.ADMIN_DISCORD_IDS || "").split(",").map((s) => s.trim()).filter(Boolean).includes(id);

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
    admin: isAdmin(env, row.id),
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
  // 管理人が許可した人は、ロールが無くても(サーバーに入っていなくても)入れる。
  // 許可はユーザーID か ユーザー名(@の後ろ)。名前で許可した人は、初めて入ったときにIDに置き換える
  const uname = String(user.username || "").toLowerCase();
  let allowed = extra.includes(user.id)
    || !!(await env.DB.prepare("SELECT id FROM allowed_users WHERE id = ?").bind(user.id).first());
  if (!allowed && uname) {
    const byName = await env.DB.prepare("SELECT id, name FROM allowed_users WHERE id = ?").bind(uname).first();
    if (byName) {
      allowed = true;
      await env.DB.batch([
        env.DB.prepare("INSERT OR IGNORE INTO allowed_users (id, name, added_at) VALUES (?, ?, ?)")
          .bind(user.id, byName.name || "@" + uname, new Date().toISOString()),
        env.DB.prepare("DELETE FROM allowed_users WHERE id = ?").bind(uname),
      ]);
    }
  }
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
  const ts = new Date().toISOString();

  const name = nick || user.global_name || user.username;
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
  // 付けている称号と、管理人が付けた称号
  const equips = (await env.DB.prepare("SELECT discord_id, slot, title_id, shape FROM title_equips").all()).results || [];
  for (const e of equips) {
    const u = users.get(e.discord_id);
    if (!u) continue;
    u.equip = u.equip || {};
    u.equip[e.slot] = e.title_id ? { id: e.title_id, shape: e.shape || "" } : null;
  }
  const grants = (await env.DB.prepare("SELECT * FROM title_grants ORDER BY id").all()).results || [];
  for (const g of grants) {
    const u = users.get(g.discord_id);
    if (u) (u.grants = u.grants || []).push(grantItem(g));
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

// 登録は確認なし(入れるのはメン限ロールの人だけなので、身内の信用で十分)。
// 1つのアカウントは1人にしか登録できない。間違いは管理人が外せる
async function accountAdd(request, env, id) {
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

  const stmts = [];
  if (role === "main") {
    stmts.push(env.DB.prepare("UPDATE game_accounts SET role = 'sub' WHERE discord_id = ? AND role = 'main'").bind(id));
  }
  stmts.push(env.DB.prepare("INSERT INTO game_accounts (tag, discord_id, role, name, added_at) VALUES (?, ?, ?, ?, ?)")
    .bind(tag, id, role, player.name, new Date().toISOString()));
  await env.DB.batch(stmts);
  await writeRoster(env);
  return json(await profile(env, id));
}

// アカウントを外す。メインを外したら、その人の一番古いサブをメインにする
async function removeAccount(env, tag, owner) {
  const row = await env.DB.prepare("SELECT role, discord_id FROM game_accounts WHERE tag = ?").bind(tag).first();
  if (!row || (owner && row.discord_id !== owner)) return false;
  await env.DB.prepare("DELETE FROM game_accounts WHERE tag = ?").bind(tag).run();
  if (row.role === "main") {
    const next = (await myAccounts(env, row.discord_id))[0];
    if (next) await env.DB.prepare("UPDATE game_accounts SET role = 'main' WHERE tag = ?").bind(next.tag).run();
  }
  await writeRoster(env);
  return true;
}

async function accountRemove(request, env, id) {
  const tag = cleanTag((await readBody(request)).tag);
  if (!(await removeAccount(env, tag, id))) return fail(404, "そのアカウントは登録されていません");
  return json(await profile(env, id));
}

// ---- 称号 ----
// 自動の称号は収集(collect.py)が各アカウントの player.json の earned に書く。
// 管理人が付けた称号(ユニーク)は D1 の title_grants。
const USER_SHAPES = ["rect", "point", "notch", "ribbon", "blade"];   // 本人が選べる形(炎の枠は選べない)
const ALL_SHAPES = [...USER_SHAPES, "blaze"];
const DESIGN_IDS = ["normal", "rare", "super", "platinum", "diamond", "emerald", "champion",
  "zap", "flame", "ice", "rainbow", "abyss", "sakura", "cosmos", "thunder", "sunset", "std"];

const grantItem = (g) => ({
  id: "g" + g.id, label: g.label, sub: g.sub || "", year: g.year || "",
  design: g.design, shape: g.shape || "", rarity: "unique", at: g.granted_at,
});

// accounts を渡せば、アカウントの読み直しを省く。R2 と D1 は同時に読む
async function ownedTitles(env, id, accounts) {
  const accs = accounts || await myAccounts(env, id);
  const [players, grants] = await Promise.all([
    Promise.all(accs.map(async (a) => {
      const obj = await env.DATA.get(`members/${a.tag}/player.json`);
      try { return obj ? await obj.json() : null; } catch { return null; }
    })),
    env.DB.prepare("SELECT * FROM title_grants WHERE discord_id = ? ORDER BY id").bind(id).all(),
  ]);
  const owned = new Map();
  for (const p of players) for (const e of (p && p.earned) || []) if (e && e.id && !owned.has(e.id)) owned.set(e.id, e);
  for (const g of grants.results || []) owned.set("g" + g.id, grantItem(g));
  return [...owned.values()];
}

async function myEquip(env, id) {
  const { results } = await env.DB.prepare("SELECT slot, title_id, shape FROM title_equips WHERE discord_id = ?").bind(id).all();
  const equip = {};
  for (const e of results || []) equip[e.slot] = e.title_id ? { id: e.title_id, shape: e.shape || "" } : null;
  return equip;
}

// プロフィール画面に要るものを1回でまとめて返す(管理人なら管理の一覧も)
async function profileFull(env, id) {
  const [m, accounts] = await Promise.all([me(env, id), myAccounts(env, id)]);
  const [owned, equip, admin] = await Promise.all([
    ownedTitles(env, id, accounts),
    myEquip(env, id),
    m && m.admin
      ? Promise.all([adminAccountsData(env), adminTitlesData(env), adminGuestsData(env)])
      : null,
  ]);
  return {
    me: m, accounts, titles: { owned, equip },
    admin: admin ? { accounts: admin[0], titles: admin[1], guests: admin[2] } : null,
  };
}

async function titles(env, id) {
  const [owned, equip] = await Promise.all([ownedTitles(env, id), myEquip(env, id)]);
  return { owned, equip };
}

// { top: "auto" | null | {id, shape}, bottom: ... } を保存する
async function titlesEquip(request, env, id) {
  const body = await readBody(request);
  const owned = new Map((await ownedTitles(env, id)).map((t) => [t.id, t]));
  const ts = new Date().toISOString();
  const stmts = [];
  for (const slot of ["top", "bottom"]) {
    if (!(slot in body)) continue;
    const v = body[slot];
    if (v === "auto") {
      stmts.push(env.DB.prepare("DELETE FROM title_equips WHERE discord_id = ? AND slot = ?").bind(id, slot));
      continue;
    }
    let tid = "", shape = "";
    if (v && typeof v === "object") {
      tid = String(v.id || "");
      const t = owned.get(tid);
      if (!t) return fail(400, "持っていない称号は付けられません");
      shape = t.shape ? "" : String(v.shape || "rect");          // 形が決まっている称号はそのまま
      if (shape && !USER_SHAPES.includes(shape)) return fail(400, "その形は選べません");
    }
    stmts.push(env.DB.prepare(
      `INSERT INTO title_equips (discord_id, slot, title_id, shape, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(discord_id, slot) DO UPDATE SET title_id = excluded.title_id, shape = excluded.shape, updated_at = excluded.updated_at`
    ).bind(id, slot, tid, shape, ts));
  }
  if (stmts.length) await env.DB.batch(stmts);
  await writeRoster(env);
  return json(await titles(env, id));
}

// ---- 管理人 ----
async function adminTitles(env) { return json(await adminTitlesData(env)); }
async function adminTitlesData(env) {
  const grants = (await env.DB.prepare(
    `SELECT g.*, COALESCE(p.display_name, u.name) AS user_name FROM title_grants g
     LEFT JOIN profiles p ON p.discord_id = g.discord_id
     LEFT JOIN discord_users u ON u.id = g.discord_id ORDER BY g.id DESC`
  ).all()).results || [];
  const users = (await env.DB.prepare(
    `SELECT u.id, COALESCE(p.display_name, u.name) AS name FROM discord_users u
     LEFT JOIN profiles p ON p.discord_id = u.id ORDER BY name`
  ).all()).results || [];
  return { grants: grants.map((g) => ({ ...grantItem(g), userId: g.discord_id, userName: g.user_name })), users };
}

// ---- メン限ロールが無くても入れる人 ----
async function adminGuests(env) { return json(await adminGuestsData(env)); }
async function adminGuestsData(env) {
  // 一度でもログインしていれば Discord の名前(表示名)を出す
  const allowed = (await env.DB.prepare(
    `SELECT a.id, a.name AS memo, a.added_at, COALESCE(p.display_name, u.name) AS name, u.last_login
     FROM allowed_users a LEFT JOIN discord_users u ON u.id = a.id LEFT JOIN profiles p ON p.discord_id = a.id
     ORDER BY a.added_at DESC`
  ).all()).results || [];
  return { allowed: allowed.map((r) => ({ id: r.id, name: r.name, memo: r.memo, at: r.added_at, lastLogin: r.last_login })) };
}

async function adminGuestAdd(request, env) {
  const b = await readBody(request);
  // ユーザーID(数字) か ユーザー名(英小文字・数字・_ と .)
  const raw = String(b.id || "").trim().replace(/^@/, "");
  const gid = /^\d{15,21}$/.test(raw) ? raw : raw.toLowerCase();
  if (!/^\d{15,21}$/.test(gid) && !/^[a-z0-9_.]{2,32}$/.test(gid)) {
    return fail(400, "Discord のユーザー名かユーザーIDを入れてください");
  }
  const name = String(b.name || "").trim().slice(0, 32) || null;     // 覚え書き(誰か分かるように)
  await env.DB.prepare(
    `INSERT INTO allowed_users (id, name, added_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = COALESCE(excluded.name, allowed_users.name)`
  ).bind(gid, name, new Date().toISOString()).run();
  return adminGuests(env);
}

// 許可を取り消す。ログイン中なら追い出す(登録したアカウントや称号は残す)
async function adminGuestRemove(request, env) {
  const gid = String((await readBody(request)).id || "").trim();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM allowed_users WHERE id = ?").bind(gid),
    env.DB.prepare("DELETE FROM sessions WHERE tag = ?").bind("d:" + gid),
  ]);
  return adminGuests(env);
}

async function adminGrant(request, env) {
  const b = await readBody(request);
  const uid = String(b.discordId || "");
  const label = String(b.label || "").trim();
  if (!uid || !(await env.DB.prepare("SELECT id FROM discord_users WHERE id = ?").bind(uid).first())) {
    return fail(400, "付ける人を選んでください");
  }
  if (!label) return fail(400, "称号の文字を入れてください");
  if ([...label].length > 20) return fail(400, "称号の文字は20文字までです");
  const design = DESIGN_IDS.includes(b.design) ? b.design : "zap";
  const shape = ALL_SHAPES.includes(b.shape) ? b.shape : "";
  await env.DB.prepare(
    "INSERT INTO title_grants (discord_id, label, sub, year, design, shape, granted_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(uid, label, String(b.sub || "").trim().slice(0, 24), String(b.year || "").trim().slice(0, 8),
    design, shape, new Date().toISOString()).run();
  await writeRoster(env);
  return adminTitles(env);
}

async function adminRevoke(request, env) {
  const gid = Number(String((await readBody(request)).id || "").replace(/^g/, ""));
  if (!gid) return fail(400, "bad id");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM title_grants WHERE id = ?").bind(gid),
    env.DB.prepare("DELETE FROM title_equips WHERE title_id = ?").bind("g" + gid),
  ]);
  await writeRoster(env);
  return adminTitles(env);
}

async function adminAccounts(env) { return json(await adminAccountsData(env)); }
async function adminAccountsData(env) {
  const { results } = await env.DB.prepare(
    `SELECT g.tag, g.role, g.name, g.discord_id, g.added_at, p.display_name, u.name AS discord_name
     FROM game_accounts g
     LEFT JOIN profiles p ON p.discord_id = g.discord_id
     LEFT JOIN discord_users u ON u.id = g.discord_id
     ORDER BY COALESCE(p.display_name, u.name), g.role = 'main' DESC, g.added_at`
  ).all();
  return { accounts: results || [] };
}

async function adminRemove(request, env) {
  const tag = cleanTag((await readBody(request)).tag);
  if (!(await removeAccount(env, tag, null))) return fail(404, "そのアカウントは登録されていません");
  return adminAccounts(env);
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
        if (p === "/api/accounts/add" && post) return await accountAdd(request, env, id);
        if (p === "/api/accounts/remove" && post) return await accountRemove(request, env, id);
        if (p === "/api/accounts/main" && post) return await accountMain(request, env, id);
        if (p === "/api/titles") return json(await titles(env, id));
        if (p === "/api/profile/full") return json(await profileFull(env, id));
        if (p === "/api/titles/equip" && post) return await titlesEquip(request, env, id);
        if (p.startsWith("/api/admin/")) {
          if (!isAdmin(env, id)) return fail(403, "管理人だけが使えます");
          if (p === "/api/admin/accounts") return await adminAccounts(env);
          if (p === "/api/admin/remove" && post) return await adminRemove(request, env);
          if (p === "/api/admin/titles") return await adminTitles(env);
          if (p === "/api/admin/titles/grant" && post) return await adminGrant(request, env);
          if (p === "/api/admin/titles/revoke" && post) return await adminRevoke(request, env);
          if (p === "/api/admin/guests") return await adminGuests(env);
          if (p === "/api/admin/guests/add" && post) return await adminGuestAdd(request, env);
          if (p === "/api/admin/guests/remove" && post) return await adminGuestRemove(request, env);
        }
        return fail(404, "not found");
      }
    } catch (e) {
      return fail(500, "サーバーでエラーが起きました: " + (e && e.message || e));
    }
    return env.ASSETS.fetch(request);
  },
};
