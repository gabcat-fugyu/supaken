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
