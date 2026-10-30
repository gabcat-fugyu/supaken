// グループランキング(/app/)の API。Google でログインして、誰でも使える。
//
//   /api/google/login, /api/google/callback       Google でログイン
//   /api/app/me                                    自分の情報(アカウント・グループ・友達・招待・称号)まとめて
//   /api/app/profile                               表示名
//   /api/app/accounts/add|remove|main              クラロワのアカウント(メイン1+サブ2)
//   /api/app/titles/equip                          上下に付ける称号
//   /api/app/friends/request|accept|remove         友達(友達コードで申請)
//   /api/app/groups/create|join|info               グループを作る・入る(パスワード / 招待リンク)
//   /api/app/groups/<id>                           グループの中身(メンバー)
//   /api/app/groups/<id>/board                     グループのランキング(メンバーと戦績)
//   /api/app/groups/<id>/leave|kick|hide|role|settings|delete|invite
//   /api/app/invites/accept|decline                友達からの招待
//   /api/app/admin/titles, /grant, /revoke         サイトの管理人: ユニーク称号
//
// 使うもの: DB(D1), DATA(R2), GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, CR_API_TOKEN, ADMIN_APP_IDS

const SESSION_DAYS = 30;
const MAX_SUBS = 2;
const MAX_OWN_GROUPS = 10;        // 1人が作れるグループの数
const MAX_JOINED_GROUPS = 30;     // 1人が入れるグループの数
const MAX_GROUP_MEMBERS = 200;    // 1つのグループの人数
const JOIN_FAIL_LIMIT = 5;        // パスワード間違いがこの回数を超えたら、しばらく入れない
const JOIN_FAIL_WINDOW = 15 * 60; // (秒)
const PBKDF2_ROUNDS = 10000;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // 見間違えやすい 0/O/1/I を除く
const CR_API = "https://proxy.royaleapi.dev/v1";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ---- 小物 ----
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
const fail = (status, message) => json({ error: message }, status);
const nowSec = () => Math.floor(Date.now() / 1000);
const iso = () => new Date().toISOString();
const cleanTag = (t) => String(t || "").toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g, "0");
const cookie = (name, value, maxAge) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const readCookie = (request, name) => {
  const m = (request.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
};
const redirect = (location, cookies = []) => {
  const h = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(null, { status: 302, headers: h });
};
async function readBody(request) {
  try { return await request.json(); } catch { return {}; }
}
function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomCode(len) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return [...a].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
}
const cleanCode = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const textOk = (s, max) => { const t = String(s || "").trim(); return t && [...t].length <= max ? t : null; };

async function hashPassword(password, saltHex) {
  const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ROUNDS }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const sameText = (a, b) => {   // 時間で中身を推測されないよう、最後まで比べる
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

const isAdmin = (env, id) => String(env.ADMIN_APP_IDS || "").split(",").map((s) => s.trim()).filter(Boolean).includes(id);

// ---- ログイン(Google) ----
// sessions.tag に "u:<利用者ID>" を入れる(Discord のメン限ページは "d:...")
export async function currentAppUser(request, env) {
  const sid = readCookie(request, "sid");
  if (!sid) return null;
  const row = await env.DB.prepare("SELECT tag FROM sessions WHERE token = ? AND expires_at > ?").bind(sid, nowSec()).first();
  return row && row.tag.startsWith("u:") ? row.tag.slice(2) : null;
}

function googleLogin(request, env) {
  const url = new URL(request.url);
  if (!env.GOOGLE_CLIENT_ID) return fail(503, "Google ログインの準備がまだです");
  const state = randomHex(16);
  // ログインのあと戻る場所(/app/ の中だけ)
  const nextRaw = url.searchParams.get("next") || "/app/";
  const next = /^\/app\/[^\s]*$/.test(nextRaw) ? nextRaw : "/app/";
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${url.origin}/api/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  return redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`,
    [cookie("g_state", state, 600), cookie("g_next", encodeURIComponent(next), 600)]);
}

async function googleCallback(request, env) {
  const url = new URL(request.url);
  const next = readCookie(request, "g_next") || "/app/";
  const clear = [cookie("g_state", "", 0), cookie("g_next", "", 0)];
  const back = (reason) => redirect(`/app/?login=${reason}`, clear);
  const code = url.searchParams.get("code");
  if (!code) return back("cancel");
  if (url.searchParams.get("state") !== readCookie(request, "g_state")) return back("expired");

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      code, grant_type: "authorization_code", redirect_uri: `${url.origin}/api/google/callback`,
    }),
  });
  if (!tokenRes.ok) return back("error");
  const { access_token } = await tokenRes.json();
  const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${access_token}` } });
  if (!infoRes.ok) return back("error");
  const info = await infoRes.json();
  if (!info.sub) return back("error");

  const ts = iso();
  let user = await env.DB.prepare("SELECT id FROM app_users WHERE google_sub = ?").bind(info.sub).first();
  if (user) {
    await env.DB.prepare("UPDATE app_users SET email = ?, name = ?, avatar = ?, last_login = ? WHERE id = ?")
      .bind(info.email || null, info.name || null, info.picture || null, ts, user.id).run();
  } else {
    user = { id: randomHex(8) };
    // 友達コードは重ならないものが出るまで振り直す
    for (let i = 0; i < 5; i++) {
      const fc = randomCode(8);
      const r = await env.DB.prepare(
        `INSERT OR IGNORE INTO app_users (id, google_sub, email, name, avatar, display_name, friend_code, created_at, last_login)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`
      ).bind(user.id, info.sub, info.email || null, info.name || null, info.picture || null, fc, ts, ts).run();
      if (r.meta && r.meta.changes) break;
    }
  }
  const token = randomHex(32);
  const maxAge = SESSION_DAYS * 86400;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sessions (token, tag, expires_at) VALUES (?, ?, ?)").bind(token, "u:" + user.id, nowSec() + maxAge),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(nowSec()),
  ]);
  return redirect(decodeURIComponent(next), [...clear, cookie("sid", token, maxAge)]);
}

// ---- 自分 ----
async function userRow(env, id) {
  return env.DB.prepare("SELECT * FROM app_users WHERE id = ?").bind(id).first();
}
// ほかの人に見せる名前は、本人が決めた表示名だけ(Google の本名は出さない)
const NO_NAME = "名無しさん";
// Google のアイコンも本名の頭文字や顔写真のことがあるので、ほかの人には出さない(自分のマイページだけ)
const pubUser = (r) => r && {
  id: r.id, name: r.display_name || NO_NAME, avatar: null,
};
async function myTags(env, id) {
  const { results } = await env.DB.prepare(
    "SELECT tag, role, name, added_at FROM app_tags WHERE user_id = ? ORDER BY role = 'main' DESC, added_at"
  ).bind(id).all();
  return results || [];
}

async function myGroups(env, id) {
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.name, m.role, (SELECT COUNT(*) FROM app_group_members x WHERE x.group_id = g.id) AS members
     FROM app_group_members m JOIN app_groups g ON g.id = m.group_id WHERE m.user_id = ? ORDER BY m.joined_at`
  ).bind(id).all();
  return results || [];
}

async function myFriends(env, id) {
  const { results } = await env.DB.prepare(
    `SELECT f.*, u.id AS uid, u.name, u.display_name, u.avatar FROM app_friends f
     JOIN app_users u ON u.id = CASE WHEN f.user_a = ? THEN f.user_b ELSE f.user_a END
     WHERE f.user_a = ? OR f.user_b = ? ORDER BY f.created_at`
  ).bind(id, id, id).all();
  const friends = [], incoming = [], outgoing = [];
  for (const r of results || []) {
    const u = { id: r.uid, name: r.display_name || NO_NAME, avatar: null };
    if (r.status === "friends") friends.push(u);
    else if (r.requested_by === id) outgoing.push(u);
    else incoming.push(u);
  }
  return { friends, incoming, outgoing };
}

async function myInvites(env, id) {
  const { results } = await env.DB.prepare(
    `SELECT i.group_id, g.name AS group_name, u.display_name, u.name FROM app_group_invites i
     JOIN app_groups g ON g.id = i.group_id LEFT JOIN app_users u ON u.id = i.inviter_id
     WHERE i.user_id = ? ORDER BY i.created_at DESC`
  ).bind(id).all();
  return (results || []).map((r) => ({ groupId: r.group_id, groupName: r.group_name, inviter: r.display_name || NO_NAME }));
}

async function me(env, id) {
  const row = await userRow(env, id);
  if (!row) return null;
  const [accounts, groups, friends, invites, titles] = await Promise.all([
    myTags(env, id), myGroups(env, id), myFriends(env, id), myInvites(env, id), titlesOf(env, id),
  ]);
  return {
    user: { ...pubUser(row), avatar: row.avatar || null, hasName: !!row.display_name, googleName: row.name, friendCode: row.friend_code, admin: isAdmin(env, id) },
    accounts, groups, friends: friends.friends, friendRequests: { incoming: friends.incoming, outgoing: friends.outgoing },
    invites, titles,
  };
}

async function setProfile(request, env, id) {
  const name = textOk((await readBody(request)).displayName, 16);
  if (!name) return fail(400, "表示名は1〜16文字で入れてください");
  await env.DB.prepare("UPDATE app_users SET display_name = ? WHERE id = ?").bind(name, id).run();
  return json(await me(env, id));
}

// ---- クラロワのアカウント ----
async function crPlayer(env, tag) {
  const res = await fetch(`${CR_API}/players/%23${tag}`, {
    headers: { Authorization: `Bearer ${env.CR_API_TOKEN}`, Accept: "application/json", "User-Agent": UA },
  });
  return res.ok ? res.json() : null;
}

async function accountAdd(request, env, id) {
  const b = await readBody(request);
  const tag = cleanTag(b.tag);
  if (!/^[0289PYLQGRJCUV]{3,12}$/.test(tag)) return fail(400, "タグが正しくありません");
  const mine = await myTags(env, id);
  if (mine.some((a) => a.tag === tag)) return fail(400, "このアカウントはもう登録しています");
  if (mine.length >= 1 + MAX_SUBS) return fail(400, `登録できるのはメイン1つとサブ${MAX_SUBS}つまでです`);
  let role = b.role === "main" || !mine.some((a) => a.role === "main") ? "main" : "sub";
  if (role === "sub" && mine.filter((a) => a.role === "sub").length >= MAX_SUBS) return fail(400, `サブは${MAX_SUBS}つまでです`);
  const p = await crPlayer(env, tag);
  if (!p) return fail(404, "プレイヤーが見つかりませんでした。タグを確かめてください");
  const stmts = [];
  if (role === "main") stmts.push(env.DB.prepare("UPDATE app_tags SET role = 'sub' WHERE user_id = ? AND role = 'main'").bind(id));
  stmts.push(env.DB.prepare("INSERT INTO app_tags (user_id, tag, role, name, added_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, tag, role, p.name, iso()));
  // 表示名がまだなら、入れてもらった表示名か、クラロワの名前をそのまま使う
  const wanted = textOk(b.displayName, 16) || textOk(p.name, 16);
  if (wanted) stmts.push(env.DB.prepare("UPDATE app_users SET display_name = ? WHERE id = ? AND display_name IS NULL").bind(wanted, id));
  await env.DB.batch(stmts);
  await moveTagGrants(env, tag, id);
  await writeRoster(env);
  return json(await me(env, id));
}

async function accountRemove(request, env, id) {
  const tag = cleanTag((await readBody(request)).tag);
  const row = await env.DB.prepare("SELECT role FROM app_tags WHERE user_id = ? AND tag = ?").bind(id, tag).first();
  if (!row) return fail(404, "そのアカウントは登録されていません");
  await env.DB.prepare("DELETE FROM app_tags WHERE user_id = ? AND tag = ?").bind(id, tag).run();
  if (row.role === "main") {
    const next = (await myTags(env, id))[0];
    if (next) await env.DB.prepare("UPDATE app_tags SET role = 'main' WHERE user_id = ? AND tag = ?").bind(id, next.tag).run();
  }
  await writeRoster(env);
  return json(await me(env, id));
}

async function accountMain(request, env, id) {
  const tag = cleanTag((await readBody(request)).tag);
  const row = await env.DB.prepare("SELECT role FROM app_tags WHERE user_id = ? AND tag = ?").bind(id, tag).first();
  if (!row) return fail(404, "そのアカウントは登録されていません");
  await env.DB.batch([
    env.DB.prepare("UPDATE app_tags SET role = 'sub' WHERE user_id = ?").bind(id),
    env.DB.prepare("UPDATE app_tags SET role = 'main' WHERE user_id = ? AND tag = ?").bind(id, tag),
  ]);
  await writeRoster(env);
  return json(await me(env, id));
}

// ---- 称号 ----
// 自動の称号は収集(collect.py)が各アカウントの player.json の earned に書く。
// 管理人が付けた称号(ユニーク)は title_grants(discord_id の欄に利用者IDを入れる)
const USER_SHAPES = ["rect", "point", "notch", "ribbon", "blade"];
const ALL_SHAPES = [...USER_SHAPES, "blaze"];
const DESIGN_IDS = ["normal", "rare", "super", "platinum", "diamond", "emerald", "champion",
  "zap", "flame", "ice", "rainbow", "abyss", "sakura", "cosmos", "thunder", "sunset", "std"];
const grantItem = (g) => ({
  id: "g" + g.id, label: g.label, sub: g.sub || "", year: g.year || "",
  design: g.design, shape: g.shape || "", rarity: "unique", at: g.granted_at,
});

async function ownedTitles(env, id, tags) {
  const list = tags || await myTags(env, id);
  const [players, grants] = await Promise.all([
    Promise.all(list.map(async (a) => {
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

async function equipOf(env, id) {
  const { results } = await env.DB.prepare("SELECT slot, title_id, shape FROM title_equips WHERE discord_id = ?").bind(id).all();
  const equip = {};
  for (const e of results || []) equip[e.slot] = e.title_id ? { id: e.title_id, shape: e.shape || "" } : null;
  return equip;
}

async function titlesOf(env, id) {
  const [owned, equip] = await Promise.all([ownedTitles(env, id), equipOf(env, id)]);
  return { owned, equip };
}

async function titlesEquip(request, env, id) {
  const body = await readBody(request);
  const owned = new Map((await ownedTitles(env, id)).map((t) => [t.id, t]));
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
      shape = t.shape ? "" : String(v.shape || "rect");
      if (shape && !USER_SHAPES.includes(shape)) return fail(400, "その形は選べません");
    }
    stmts.push(env.DB.prepare(
      `INSERT INTO title_equips (discord_id, slot, title_id, shape, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(discord_id, slot) DO UPDATE SET title_id = excluded.title_id, shape = excluded.shape, updated_at = excluded.updated_at`
    ).bind(id, slot, tid, shape, iso()));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json(await me(env, id));
}

// まだ誰も登録していないアカウントに付いていたユニーク称号を、登録した人のものにする
async function moveTagGrants(env, tag, userId) {
  const { results } = await env.DB.prepare("SELECT * FROM tag_grants WHERE tag = ?").bind(tag).all();
  if (!results || !results.length) return;
  await env.DB.batch([
    ...results.map((g) => env.DB.prepare(
      "INSERT INTO title_grants (discord_id, label, sub, year, design, shape, granted_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(userId, g.label, g.sub, g.year, g.design, g.shape, g.granted_at)),
    env.DB.prepare("DELETE FROM tag_grants WHERE tag = ?").bind(tag),
  ]);
}

// ---- 友達 ----
const pair = (x, y) => (x < y ? [x, y] : [y, x]);

async function friendRequest(request, env, id) {
  const code = cleanCode((await readBody(request)).code);
  const other = await env.DB.prepare("SELECT id FROM app_users WHERE friend_code = ?").bind(code).first();
  if (!other) return fail(404, "その友達コードの人は見つかりませんでした");
  if (other.id === id) return fail(400, "自分の友達コードです");
  const [a, b] = pair(id, other.id);
  const row = await env.DB.prepare("SELECT * FROM app_friends WHERE user_a = ? AND user_b = ?").bind(a, b).first();
  if (row && row.status === "friends") return fail(400, "もう友達です");
  if (row && row.requested_by !== id) {
    // 相手からも申請が来ていたら、そのまま友達になる
    await env.DB.prepare("UPDATE app_friends SET status = 'friends' WHERE user_a = ? AND user_b = ?").bind(a, b).run();
  } else if (!row) {
    await env.DB.prepare("INSERT INTO app_friends (user_a, user_b, requested_by, status, created_at) VALUES (?, ?, ?, 'pending', ?)")
      .bind(a, b, id, iso()).run();
  }
  return json(await me(env, id));
}

async function friendAccept(request, env, id) {
  const other = String((await readBody(request)).userId || "");
  const [a, b] = pair(id, other);
  const r = await env.DB.prepare(
    "UPDATE app_friends SET status = 'friends' WHERE user_a = ? AND user_b = ? AND status = 'pending' AND requested_by != ?"
  ).bind(a, b, id).run();
  if (!r.meta || !r.meta.changes) return fail(404, "その申請は見つかりませんでした");
  return json(await me(env, id));
}

async function friendRemove(request, env, id) {
  const other = String((await readBody(request)).userId || "");
  const [a, b] = pair(id, other);
  await env.DB.prepare("DELETE FROM app_friends WHERE user_a = ? AND user_b = ?").bind(a, b).run();
  return json(await me(env, id));
}

const areFriends = async (env, x, y) => {
  const [a, b] = pair(x, y);
  return !!(await env.DB.prepare("SELECT 1 FROM app_friends WHERE user_a = ? AND user_b = ? AND status = 'friends'").bind(a, b).first());
};

// ---- グループ ----
async function membership(env, groupId, userId) {
  return env.DB.prepare("SELECT role FROM app_group_members WHERE group_id = ? AND user_id = ?").bind(groupId, userId).first();
}
const canManage = (m) => m && (m.role === "owner" || m.role === "admin");

async function addMember(env, groupId, userId, role) {
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM app_group_members WHERE group_id = ?").bind(groupId).first();
  if (count.n >= MAX_GROUP_MEMBERS) return `このグループは満員です(${MAX_GROUP_MEMBERS}人まで)`;
  const mine = await env.DB.prepare("SELECT COUNT(*) AS n FROM app_group_members WHERE user_id = ?").bind(userId).first();
  if (mine.n >= MAX_JOINED_GROUPS) return `入れるグループは${MAX_JOINED_GROUPS}個までです`;
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO app_group_members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)")
      .bind(groupId, userId, role, iso()),
    env.DB.prepare("DELETE FROM app_group_invites WHERE group_id = ? AND user_id = ?").bind(groupId, userId),
    env.DB.prepare("DELETE FROM app_join_fails WHERE group_id = ? AND user_id = ?").bind(groupId, userId),
  ]);
  return null;
}

async function groupCreate(request, env, id) {
  const b = await readBody(request);
  const name = textOk(b.name, 20);
  const password = String(b.password || "");
  if (!name) return fail(400, "グループ名は1〜20文字で入れてください");
  if (password.length < 4 || password.length > 64) return fail(400, "パスワードは4文字以上にしてください");
  const own = await env.DB.prepare("SELECT COUNT(*) AS n FROM app_groups WHERE owner_id = ?").bind(id).first();
  if (own.n >= MAX_OWN_GROUPS) return fail(400, `作れるグループは${MAX_OWN_GROUPS}個までです`);
  const salt = randomHex(16);
  const hash = await hashPassword(password, salt);
  let gid = null;
  for (let i = 0; i < 5 && !gid; i++) {
    const cand = randomCode(6);
    const r = await env.DB.prepare(
      "INSERT OR IGNORE INTO app_groups (id, name, owner_id, pass_hash, pass_salt, invite_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(cand, name, id, hash, salt, randomHex(12), iso()).run();
    if (r.meta && r.meta.changes) gid = cand;
  }
  if (!gid) return fail(500, "グループを作れませんでした。もう一度試してください");
  const problem = await addMember(env, gid, id, "owner");
  if (problem) return fail(400, problem);
  await writeRoster(env);
  return json({ ...(await me(env, id)), created: gid });
}

async function groupJoin(request, env, id) {
  const b = await readBody(request);
  let group;
  if (b.invite) {
    group = await env.DB.prepare("SELECT * FROM app_groups WHERE invite_code = ?").bind(String(b.invite)).first();
    if (!group) return fail(404, "招待リンクが古いか、まちがっています");
  } else {
    const gid = cleanCode(b.groupId);
    group = await env.DB.prepare("SELECT * FROM app_groups WHERE id = ?").bind(gid).first();
    if (!group) return fail(404, "そのグループIDは見つかりませんでした");
    const f = await env.DB.prepare("SELECT count, last_at FROM app_join_fails WHERE group_id = ? AND user_id = ?").bind(gid, id).first();
    if (f && f.count >= JOIN_FAIL_LIMIT && nowSec() - f.last_at < JOIN_FAIL_WINDOW) {
      return fail(429, "パスワードを何度もまちがえたので、15分ほど待ってから試してください");
    }
    const ok = sameText(await hashPassword(String(b.password || ""), group.pass_salt), group.pass_hash);
    if (!ok) {
      await env.DB.prepare(
        `INSERT INTO app_join_fails (group_id, user_id, count, last_at) VALUES (?, ?, 1, ?)
         ON CONFLICT(group_id, user_id) DO UPDATE SET count = CASE WHEN ? - last_at > ? THEN 1 ELSE count + 1 END, last_at = excluded.last_at`
      ).bind(gid, id, nowSec(), nowSec(), JOIN_FAIL_WINDOW).run();
      return fail(403, "パスワードがちがいます");
    }
  }
  if (await membership(env, group.id, id)) return json({ ...(await me(env, id)), joined: group.id });
  const problem = await addMember(env, group.id, id, "member");
  if (problem) return fail(400, problem);
  await writeRoster(env);
  return json({ ...(await me(env, id)), joined: group.id });
}

// 招待リンクを開いたときに、どのグループか見せる
async function groupInviteInfo(url, env) {
  const g = await env.DB.prepare(
    "SELECT id, name, (SELECT COUNT(*) FROM app_group_members m WHERE m.group_id = app_groups.id) AS members FROM app_groups WHERE invite_code = ?"
  ).bind(String(url.searchParams.get("invite") || "")).first();
  return g ? json(g) : fail(404, "招待リンクが古いか、まちがっています");
}

async function groupMembers(env, gid) {
  const { results } = await env.DB.prepare(
    `SELECT m.user_id, m.role, m.joined_at, u.name, u.display_name, u.avatar FROM app_group_members m
     JOIN app_users u ON u.id = m.user_id WHERE m.group_id = ?
     ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.joined_at`
  ).bind(gid).all();
  const users = results || [];
  const ids = users.map((u) => u.user_id);
  const tags = ids.length ? (await env.DB.prepare(
    `SELECT t.user_id, t.tag, t.role, t.name, (SELECT 1 FROM app_group_hidden h WHERE h.group_id = ? AND h.user_id = t.user_id AND h.tag = t.tag) AS hidden
     FROM app_tags t WHERE t.user_id IN (SELECT user_id FROM app_group_members WHERE group_id = ?)
     ORDER BY t.role = 'main' DESC, t.added_at`
  ).bind(gid, gid).all()).results || [] : [];
  return users.map((u) => ({
    id: u.user_id, name: u.display_name || NO_NAME, avatar: null, role: u.role,
    accounts: tags.filter((t) => t.user_id === u.user_id).map((t) => ({ tag: t.tag, role: t.role, name: t.name, hidden: !!t.hidden })),
  }));
}

async function groupDetail(env, gid, id, m) {
  const g = await env.DB.prepare("SELECT id, name, owner_id, invite_code, created_at FROM app_groups WHERE id = ?").bind(gid).first();
  if (!g) return fail(404, "グループが見つかりません");
  return json({
    group: { id: g.id, name: g.name, role: m.role, invite: canManage(m) ? g.invite_code : null },
    members: await groupMembers(env, gid),
  });
}

// グループのランキング。メンバー(と称号)は今の D1、戦績は収集が書いた players.json
async function groupBoard(env, gid, m) {
  const g = await env.DB.prepare("SELECT id, name FROM app_groups WHERE id = ?").bind(gid).first();
  if (!g) return fail(404, "グループが見つかりません");
  const members = await groupMembers(env, gid);
  const ids = members.map((u) => u.id);
  const [equips, grants, file] = await Promise.all([
    ids.length ? env.DB.prepare(`SELECT discord_id, slot, title_id, shape FROM title_equips WHERE discord_id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all() : { results: [] },
    ids.length ? env.DB.prepare(`SELECT * FROM title_grants WHERE discord_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`).bind(...ids).all() : { results: [] },
    env.DATA.get(`members/groups/${gid}/players.json`),
  ]);
  let players = [], updatedAt = null, challengeYear = null;
  if (file) {
    try { const d = await file.json(); players = d.players || []; updatedAt = d.updatedAt; challengeYear = d.challengeYear ?? null; } catch {}
  }
  const users = members.map((u) => {
    const equip = {};
    for (const e of equips.results || []) if (e.discord_id === u.id) equip[e.slot] = e.title_id ? { id: e.title_id, shape: e.shape || "" } : null;
    return {
      id: u.id, displayName: u.name, role: u.role,
      accounts: u.accounts.filter((a) => !a.hidden).map(({ tag, role, name }) => ({ tag, role, name })),
      equip, grants: (grants.results || []).filter((x) => x.discord_id === u.id).map(grantItem),
    };
  });
  return json({ group: { id: g.id, name: g.name, role: m.role }, users, players, updatedAt, challengeYear });
}

async function groupAction(request, env, id, gid, action) {
  const m = await membership(env, gid, id);
  if (!m) return fail(403, "このグループのメンバーではありません");
  const b = request.method === "POST" ? await readBody(request) : {};
  const target = String(b.userId || "");
  const tm = target ? await membership(env, gid, target) : null;

  if (action === "leave") {
    if (m.role === "owner") return fail(400, "作った人は抜けられません。グループを消すか、ほかの人に作った人を譲ってください");
    await env.DB.prepare("DELETE FROM app_group_members WHERE group_id = ? AND user_id = ?").bind(gid, id).run();
  } else if (action === "invite") {
    if (!(await areFriends(env, id, target))) return fail(400, "招待できるのは友達だけです");
    if (tm) return fail(400, "その人はもうメンバーです");
    await env.DB.prepare("INSERT OR IGNORE INTO app_group_invites (group_id, user_id, inviter_id, created_at) VALUES (?, ?, ?, ?)")
      .bind(gid, target, id, iso()).run();
    return groupDetail(env, gid, id, m);
  } else {
    if (!canManage(m)) return fail(403, "グループの管理者だけができます");
    if (action === "kick") {
      if (!tm || tm.role === "owner" || (tm.role === "admin" && m.role !== "owner")) return fail(400, "その人は外せません");
      await env.DB.batch([
        env.DB.prepare("DELETE FROM app_group_members WHERE group_id = ? AND user_id = ?").bind(gid, target),
        env.DB.prepare("DELETE FROM app_group_hidden WHERE group_id = ? AND user_id = ?").bind(gid, target),
      ]);
    } else if (action === "hide") {
      if (!tm) return fail(400, "その人はメンバーではありません");
      const tag = cleanTag(b.tag);
      await env.DB.prepare(b.hidden
        ? "INSERT OR IGNORE INTO app_group_hidden (group_id, user_id, tag) VALUES (?, ?, ?)"
        : "DELETE FROM app_group_hidden WHERE group_id = ? AND user_id = ? AND tag = ?").bind(gid, target, tag).run();
    } else if (action === "role") {
      if (m.role !== "owner") return fail(403, "管理者を決められるのは作った人だけです");
      if (!tm || tm.role === "owner") return fail(400, "その人は変えられません");
      if (b.role === "owner") {
        // 作った人を譲る(自分は管理者になる)
        await env.DB.batch([
          env.DB.prepare("UPDATE app_group_members SET role = 'owner' WHERE group_id = ? AND user_id = ?").bind(gid, target),
          env.DB.prepare("UPDATE app_group_members SET role = 'admin' WHERE group_id = ? AND user_id = ?").bind(gid, id),
          env.DB.prepare("UPDATE app_groups SET owner_id = ? WHERE id = ?").bind(target, gid),
        ]);
      } else {
        await env.DB.prepare("UPDATE app_group_members SET role = ? WHERE group_id = ? AND user_id = ?")
          .bind(b.role === "admin" ? "admin" : "member", gid, target).run();
      }
    } else if (action === "settings") {
      const stmts = [];
      if (b.name != null) {
        const name = textOk(b.name, 20);
        if (!name) return fail(400, "グループ名は1〜20文字で入れてください");
        stmts.push(env.DB.prepare("UPDATE app_groups SET name = ? WHERE id = ?").bind(name, gid));
      }
      if (b.password) {
        if (String(b.password).length < 4) return fail(400, "パスワードは4文字以上にしてください");
        const salt = randomHex(16);
        stmts.push(env.DB.prepare("UPDATE app_groups SET pass_hash = ?, pass_salt = ? WHERE id = ?")
          .bind(await hashPassword(String(b.password), salt), salt, gid));
      }
      if (b.newInvite) stmts.push(env.DB.prepare("UPDATE app_groups SET invite_code = ? WHERE id = ?").bind(randomHex(12), gid));
      if (stmts.length) await env.DB.batch(stmts);
    } else if (action === "delete") {
      if (m.role !== "owner") return fail(403, "グループを消せるのは作った人だけです");
      await env.DB.batch([
        env.DB.prepare("DELETE FROM app_group_members WHERE group_id = ?").bind(gid),
        env.DB.prepare("DELETE FROM app_group_hidden WHERE group_id = ?").bind(gid),
        env.DB.prepare("DELETE FROM app_group_invites WHERE group_id = ?").bind(gid),
        env.DB.prepare("DELETE FROM app_join_fails WHERE group_id = ?").bind(gid),
        env.DB.prepare("DELETE FROM app_groups WHERE id = ?").bind(gid),
      ]);
      await env.DATA.delete(`members/groups/${gid}/players.json`);
      await writeRoster(env);
      return json(await me(env, id));
    } else {
      return fail(404, "not found");
    }
  }
  await writeRoster(env);
  if (action === "leave") return json(await me(env, id));
  return groupDetail(env, gid, id, await membership(env, gid, id));
}

async function inviteAnswer(request, env, id, accept) {
  const gid = cleanCode((await readBody(request)).groupId);
  const inv = await env.DB.prepare("SELECT 1 FROM app_group_invites WHERE group_id = ? AND user_id = ?").bind(gid, id).first();
  if (!inv) return fail(404, "その招待は見つかりませんでした");
  if (accept) {
    const problem = await addMember(env, gid, id, "member");
    if (problem) return fail(400, problem);
    await writeRoster(env);
  } else {
    await env.DB.prepare("DELETE FROM app_group_invites WHERE group_id = ? AND user_id = ?").bind(gid, id).run();
  }
  return json({ ...(await me(env, id)), joined: accept ? gid : null });
}

// ---- 収集(collect.py)に渡す一覧 ----
// どのアカウントを集めるか と、グループごとにどのアカウントを載せるか
export async function writeRoster(env) {
  const [tags, members, hidden] = await Promise.all([
    env.DB.prepare("SELECT user_id, tag FROM app_tags").all(),
    env.DB.prepare("SELECT group_id, user_id FROM app_group_members").all(),
    env.DB.prepare("SELECT group_id, user_id, tag FROM app_group_hidden").all(),
  ]);
  const byUser = new Map();
  for (const t of tags.results || []) (byUser.get(t.user_id) || byUser.set(t.user_id, []).get(t.user_id)).push(t.tag);
  const hide = new Set((hidden.results || []).map((h) => `${h.group_id}|${h.user_id}|${h.tag}`));
  const groups = new Map();
  for (const m of members.results || []) {
    if (!groups.has(m.group_id)) groups.set(m.group_id, new Set());
    for (const tag of byUser.get(m.user_id) || []) {
      if (!hide.has(`${m.group_id}|${m.user_id}|${tag}`)) groups.get(m.group_id).add(tag);
    }
  }
  const roster = {
    updatedAt: iso(),
    tags: [...new Set((tags.results || []).map((t) => t.tag))],
    groups: [...groups].map(([id, set]) => ({ id, tags: [...set] })),
  };
  await env.DATA.put("members/app-roster.json", JSON.stringify(roster), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

// ---- サイトの管理人: ユニーク称号 ----
async function adminTitles(env) {
  const grants = (await env.DB.prepare(
    `SELECT g.*, COALESCE(u.display_name, u.name) AS user_name FROM title_grants g
     JOIN app_users u ON u.id = g.discord_id ORDER BY g.id DESC`
  ).all()).results || [];
  const tagGrants = (await env.DB.prepare("SELECT * FROM tag_grants ORDER BY id DESC").all()).results || [];
  const users = (await env.DB.prepare("SELECT id, COALESCE(display_name, name) AS name FROM app_users ORDER BY name").all()).results || [];
  return json({
    grants: [
      ...tagGrants.map((g) => ({ ...grantItem(g), id: "t" + g.id, tag: g.tag, userName: `#${g.tag}(まだ登録されていないアカウント)` })),
      ...grants.map((g) => ({ ...grantItem(g), userId: g.discord_id, userName: g.user_name })),
    ],
    users,
  });
}

async function adminGrant(request, env) {
  const b = await readBody(request);
  const target = String(b.target || "");
  let uid = target.startsWith("u:") ? target.slice(2) : "";
  const tag = target.startsWith("t:") ? cleanTag(target.slice(2)) : "";
  const label = textOk(b.label, 20);
  if (!label) return fail(400, "称号の文字は1〜20文字で入れてください");
  if (tag) {
    const owner = await env.DB.prepare("SELECT user_id FROM app_tags WHERE tag = ? ORDER BY added_at LIMIT 1").bind(tag).first();
    if (owner) uid = owner.user_id;
  } else if (!uid || !(await userRow(env, uid))) {
    return fail(400, "付ける人を選んでください");
  }
  const vals = [label, String(b.sub || "").trim().slice(0, 24), String(b.year || "").trim().slice(0, 8),
    DESIGN_IDS.includes(b.design) ? b.design : "zap", ALL_SHAPES.includes(b.shape) ? b.shape : "", iso()];
  await env.DB.prepare(uid
    ? "INSERT INTO title_grants (discord_id, label, sub, year, design, shape, granted_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    : "INSERT INTO tag_grants (tag, label, sub, year, design, shape, granted_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(uid || tag, ...vals).run();
  return adminTitles(env);
}

async function adminRevoke(request, env) {
  const raw = String((await readBody(request)).id || "");
  if (raw.startsWith("t")) {
    await env.DB.prepare("DELETE FROM tag_grants WHERE id = ?").bind(Number(raw.slice(1)) || 0).run();
  } else {
    const gid = Number(raw.replace(/^g/, "")) || 0;
    await env.DB.batch([
      env.DB.prepare("DELETE FROM title_grants WHERE id = ?").bind(gid),
      env.DB.prepare("DELETE FROM title_equips WHERE title_id = ?").bind("g" + gid),
    ]);
  }
  return adminTitles(env);
}

// ---- 入口 ----
// /api/google/* と /api/app/* を受け持つ。それ以外は null を返す
export async function handleApp(request, env, url) {
  const p = url.pathname;
  const post = request.method === "POST";
  if (p === "/api/google/login") return googleLogin(request, env);
  if (p === "/api/google/callback") return googleCallback(request, env);
  if (!p.startsWith("/api/app/")) return null;

  const id = await currentAppUser(request, env);
  if (!id) return fail(401, "ログインしてください");
  if (p === "/api/app/me") {
    const data = await me(env, id);
    return data ? json(data) : fail(401, "ログインしてください");
  }
  if (p === "/api/app/profile" && post) return setProfile(request, env, id);
  if (p === "/api/app/accounts/add" && post) return accountAdd(request, env, id);
  if (p === "/api/app/accounts/remove" && post) return accountRemove(request, env, id);
  if (p === "/api/app/accounts/main" && post) return accountMain(request, env, id);
  if (p === "/api/app/titles/equip" && post) return titlesEquip(request, env, id);
  if (p === "/api/app/friends/request" && post) return friendRequest(request, env, id);
  if (p === "/api/app/friends/accept" && post) return friendAccept(request, env, id);
  if (p === "/api/app/friends/remove" && post) return friendRemove(request, env, id);
  if (p === "/api/app/groups/create" && post) return groupCreate(request, env, id);
  if (p === "/api/app/groups/join" && post) return groupJoin(request, env, id);
  if (p === "/api/app/groups/info") return groupInviteInfo(url, env);
  if (p === "/api/app/invites/accept" && post) return inviteAnswer(request, env, id, true);
  if (p === "/api/app/invites/decline" && post) return inviteAnswer(request, env, id, false);
  if (p.startsWith("/api/app/admin/")) {
    if (!isAdmin(env, id)) return fail(403, "管理人だけが使えます");
    if (p === "/api/app/admin/titles") return adminTitles(env);
    if (p === "/api/app/admin/titles/grant" && post) return adminGrant(request, env);
    if (p === "/api/app/admin/titles/revoke" && post) return adminRevoke(request, env);
    return fail(404, "not found");
  }
  const g = /^\/api\/app\/groups\/([A-Z0-9]{4,10})(?:\/([a-z]+))?$/.exec(p);
  if (g) {
    const [, gid, action] = g;
    const m = await membership(env, gid, id);
    if (!action) return m ? groupDetail(env, gid, id, m) : fail(403, "このグループのメンバーではありません");
    if (action === "board") return m ? groupBoard(env, gid, m) : fail(403, "このグループのメンバーではありません");
    if (post) return groupAction(request, env, id, gid, action);
  }
  return fail(404, "not found");
}
