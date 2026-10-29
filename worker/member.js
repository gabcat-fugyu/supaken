// member.supaken.com の入口。
//
//   /api/login, /api/logout, /api/me     ログイン
//   /api/register/start, /api/register/finish
//                                        登録とパスワード再設定(お気に入りカードで本人確認)
//   /api/data/...                        戦績データ(R2 の members/...)。ログインした人だけ
//   それ以外                              site/member の画面ファイル
//
// 使うもの(wrangler.toml / secret):
//   DB    … D1(users / sessions / challenges)
//   DATA  … R2(戦績データ)
//   CR_API_TOKEN … クラロワAPIのトークン(本人確認でプロフィールを見る)
//   ADMIN_TAGS   … 管理人のタグ(カンマ区切り)

const SESSION_DAYS = 60;          // 一度ログインしたら、この日数はそのまま
const CHALLENGE_MINUTES = 30;     // 本人確認の有効時間
const PBKDF2_ITER = 10000;        // パスワードのハッシュの強さ(無料枠の計算時間に収まる程度)
const CR_API = "https://proxy.royaleapi.dev/v1";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ---- 小物 ----
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
const fail = (status, message) => json({ error: message }, status);
const now = () => Math.floor(Date.now() / 1000);
const cleanTag = (t) => String(t || "").toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g, "0");

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITER }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 文字列を時間差なく比べる(パスワードの照合用)
function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readBody(request) {
  try { return await request.json(); } catch { return {}; }
}

// ---- メンバー名簿(R2 の index.json) ----
let rosterCache = null, rosterAt = 0;
async function roster(env) {
  if (rosterCache && Date.now() - rosterAt < 60_000) return rosterCache;
  const obj = await env.DATA.get("members/index.json");
  const map = new Map();
  if (obj) {
    const idx = await obj.json();
    for (const p of idx.players || []) map.set(cleanTag(p.tag), p.label || p.name || p.tag);
  }
  rosterCache = map; rosterAt = Date.now();
  return map;
}

async function crPlayer(env, tag) {
  const res = await fetch(`${CR_API}/players/%23${tag}`, {
    headers: { Authorization: `Bearer ${env.CR_API_TOKEN}`, Accept: "application/json", "User-Agent": UA },
  });
  if (!res.ok) return null;
  return res.json();
}

// ---- セッション ----
function readCookie(request, name) {
  const m = (request.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

async function currentTag(request, env) {
  const sid = readCookie(request, "sid");
  if (!sid) return null;
  const row = await env.DB.prepare("SELECT tag FROM sessions WHERE token = ? AND expires_at > ?").bind(sid, now()).first();
  return row ? row.tag : null;
}

async function startSession(env, tag) {
  const token = randomHex(32);
  const maxAge = SESSION_DAYS * 86400;
  await env.DB.prepare("INSERT INTO sessions (token, tag, expires_at) VALUES (?, ?, ?)").bind(token, tag, now() + maxAge).run();
  // 古いセッションの掃除(ついで)
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now()).run();
  return `sid=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

const isAdmin = (env, tag) =>
  String(env.ADMIN_TAGS || "").split(",").map(cleanTag).filter(Boolean).includes(tag);

async function me(env, tag) {
  const names = await roster(env);
  return { tag, name: names.get(tag) || tag, admin: isAdmin(env, tag) };
}

// ---- 各処理 ----
async function login(request, env) {
  const { tag: rawTag, password } = await readBody(request);
  const tag = cleanTag(rawTag);
  const row = tag && await env.DB.prepare("SELECT pass_hash, salt FROM users WHERE tag = ?").bind(tag).first();
  if (!row || !password || !sameString(await hashPassword(String(password), row.salt), row.pass_hash)) {
    return fail(401, "タグかパスワードが違います");
  }
  return json(await me(env, tag), 200, { "set-cookie": await startSession(env, tag) });
}

async function registerStart(request, env) {
  const tag = cleanTag((await readBody(request)).tag);
  if (!tag) return fail(400, "タグを入れてください");
  if (!(await roster(env)).has(tag)) return fail(403, "このタグはメンバーに登録されていません");
  const player = await crPlayer(env, tag);
  if (!player) return fail(404, "プレイヤーが見つかりませんでした。タグを確かめてください");

  // 今のお気に入り以外の、持っているカードから1枚選ぶ
  const favId = player.currentFavouriteCard?.id;
  const pool = (player.cards || []).filter((c) => c.id !== favId && c.iconUrls?.medium);
  if (!pool.length) return fail(500, "カードの情報が取れませんでした");
  const card = pool[Math.floor(Math.random() * pool.length)];

  await env.DB.prepare(
    "INSERT OR REPLACE INTO challenges (tag, card_id, card_name, card_icon, expires_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(tag, card.id, card.name, card.iconUrls.medium, now() + CHALLENGE_MINUTES * 60).run();

  return json({ name: player.name, card: { name: card.name, icon: card.iconUrls.medium } });
}

async function registerFinish(request, env) {
  const body = await readBody(request);
  const tag = cleanTag(body.tag);
  const password = String(body.password || "");
  if (password.length < 4) return fail(400, "パスワードは4文字以上にしてください");

  const ch = await env.DB.prepare("SELECT card_id, card_name, expires_at FROM challenges WHERE tag = ?").bind(tag).first();
  if (!ch || ch.expires_at < now()) return fail(400, "時間切れです。もう一度はじめからやってください");

  const player = await crPlayer(env, tag);
  if (!player) return fail(502, "クラロワのプロフィールが取れませんでした。少し待ってもう一度押してください");
  if (player.currentFavouriteCard?.id !== ch.card_id) {
    return fail(400, "まだお気に入りカードが変わっていません。変えたばかりなら、1〜2分待ってからもう一度押してください");
  }

  const salt = randomHex(16);
  const hash = await hashPassword(password, salt);
  await env.DB.prepare(
    `INSERT INTO users (tag, pass_hash, salt, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(tag) DO UPDATE SET pass_hash = excluded.pass_hash, salt = excluded.salt`
  ).bind(tag, hash, salt, new Date().toISOString()).run();
  // パスワードを変えたら、他の端末のログインは切る
  await env.DB.prepare("DELETE FROM sessions WHERE tag = ?").bind(tag).run();
  await env.DB.prepare("DELETE FROM challenges WHERE tag = ?").bind(tag).run();

  return json(await me(env, tag), 200, { "set-cookie": await startSession(env, tag) });
}

async function logout(request, env) {
  const sid = readCookie(request, "sid");
  if (sid) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(sid).run();
  return json({ ok: true }, 200, { "set-cookie": "sid=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" });
}

async function data(request, env, url) {
  const tag = await currentTag(request, env);
  if (!tag) return fail(401, "ログインしてください");
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
    const post = request.method === "POST";
    try {
      if (p.startsWith("/api/data/")) return await data(request, env, url);
      if (p === "/api/me") {
        const tag = await currentTag(request, env);
        return tag ? json(await me(env, tag)) : fail(401, "ログインしていません");
      }
      if (p === "/api/login" && post) return await login(request, env);
      if (p === "/api/logout" && post) return await logout(request, env);
      if (p === "/api/register/start" && post) return await registerStart(request, env);
      if (p === "/api/register/finish" && post) return await registerFinish(request, env);
      if (p.startsWith("/api/")) return fail(404, "not found");
    } catch (e) {
      return fail(500, "サーバーでエラーが起きました: " + (e && e.message || e));
    }
    return env.ASSETS.fetch(request);
  },
};
