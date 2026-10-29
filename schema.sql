-- メンバーアプリのログイン用データベース(Cloudflare D1)
-- 何度流しても壊れないよう IF NOT EXISTS で書く

-- アカウント。ID はクラロワのタグ(# なし・大文字)
CREATE TABLE IF NOT EXISTS users (
  tag        TEXT PRIMARY KEY,
  pass_hash  TEXT NOT NULL,
  salt       TEXT NOT NULL,
  is_admin   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- ログイン中の端末。cookie の sid と対応する
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  tag        TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- 登録・パスワード再設定の本人確認(お気に入りカードを指定のカードにしてもらう)
CREATE TABLE IF NOT EXISTS challenges (
  tag        TEXT PRIMARY KEY,
  card_id    INTEGER NOT NULL,
  card_name  TEXT NOT NULL,
  card_icon  TEXT,
  expires_at INTEGER NOT NULL
);

-- Discord でログインした人。tag はあとでクラロワのアカウントと結びつけたときに入る
CREATE TABLE IF NOT EXISTS discord_users (
  id         TEXT PRIMARY KEY,
  name       TEXT,
  avatar     TEXT,
  tag        TEXT,
  created_at TEXT NOT NULL,
  last_login TEXT
);

-- プロフィール(表示名)。Discord の1アカウントにつき1つ
CREATE TABLE IF NOT EXISTS profiles (
  discord_id   TEXT PRIMARY KEY,
  display_name TEXT,
  updated_at   TEXT
);

-- Discord アカウントに結びつけたクラロワのアカウント。メイン1つ+サブ2つまで
-- tag は1人の Discord アカウントにしか結びつけられない
CREATE TABLE IF NOT EXISTS game_accounts (
  tag        TEXT PRIMARY KEY,
  discord_id TEXT NOT NULL,
  role       TEXT NOT NULL,          -- 'main' か 'sub'
  name       TEXT,                   -- ゲーム内の名前(登録したとき)
  added_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS game_accounts_owner ON game_accounts (discord_id);

-- アカウント登録の本人確認(お気に入りカード)。1人1件
CREATE TABLE IF NOT EXISTS link_challenges (
  discord_id TEXT PRIMARY KEY,
  tag        TEXT NOT NULL,
  role       TEXT NOT NULL,
  card_id    INTEGER NOT NULL,
  card_name  TEXT NOT NULL,
  card_icon  TEXT,
  expires_at INTEGER NOT NULL
);

-- 管理人が付けた称号(ユニーク)。Discord の1人に付く
CREATE TABLE IF NOT EXISTS title_grants (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id TEXT NOT NULL,
  label      TEXT NOT NULL,
  sub        TEXT,
  year       TEXT,
  design     TEXT NOT NULL,
  shape      TEXT,                   -- 空なら本人が形を選べる。入っていればその形で固定(炎の枠など)
  granted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS title_grants_owner ON title_grants (discord_id);

-- 付けている称号。slot は 'top'(名前の上) か 'bottom'(名前の下)。
-- 行が無ければ「おまかせ」(上は一番レアな称号、下はなし)。title_id が空なら「なし」
CREATE TABLE IF NOT EXISTS title_equips (
  discord_id TEXT NOT NULL,
  slot       TEXT NOT NULL,
  title_id   TEXT NOT NULL,
  shape      TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (discord_id, slot)
);

-- メン限ロールが無くても入れる人(管理人が許可する)
CREATE TABLE IF NOT EXISTS allowed_users (
  id        TEXT PRIMARY KEY,          -- Discord ユーザーID
  name      TEXT,
  added_at  TEXT NOT NULL
);

-- ロールが無くて入れなかった人(管理人が「許可する」を押せるように残す)
CREATE TABLE IF NOT EXISTS denied_logins (
  id        TEXT PRIMARY KEY,
  name      TEXT,
  avatar    TEXT,
  reason    TEXT,
  at        TEXT NOT NULL
);
