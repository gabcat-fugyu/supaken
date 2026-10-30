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
  name      TEXT,                     -- 覚え書き(誰か分かるように)
  added_at  TEXT NOT NULL
);


-- ゲームアカウント(タグ)に付けたユニーク称号。まだ誰も登録していないアカウント用。
-- そのアカウントを誰かがプロフィールで登録したら、その人の title_grants に移す
CREATE TABLE IF NOT EXISTS tag_grants (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tag        TEXT NOT NULL,
  label      TEXT NOT NULL,
  sub        TEXT,
  year       TEXT,
  design     TEXT NOT NULL,
  shape      TEXT,
  granted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tag_grants_tag ON tag_grants (tag);

-- ==================== グループランキング(Google でログイン。誰でも使える) ====================
-- 利用者。id はこちらで振る(英数字)。friend_code は友達追加に使う短い番号
CREATE TABLE IF NOT EXISTS app_users (
  id           TEXT PRIMARY KEY,
  google_sub   TEXT UNIQUE NOT NULL,
  email        TEXT,
  name         TEXT,
  avatar       TEXT,
  display_name TEXT,
  friend_code  TEXT UNIQUE NOT NULL,
  created_at   TEXT NOT NULL,
  last_login   TEXT
);

-- 利用者が登録したクラロワのアカウント(メイン1つ+サブ2つまで)。
-- 誰でも登録できるので、同じタグを別の人が登録することもある(グループの管理者が外せる)
CREATE TABLE IF NOT EXISTS app_tags (
  user_id  TEXT NOT NULL,
  tag      TEXT NOT NULL,
  role     TEXT NOT NULL,          -- 'main' か 'sub'
  name     TEXT,
  added_at TEXT NOT NULL,
  PRIMARY KEY (user_id, tag)
);
CREATE INDEX IF NOT EXISTS app_tags_tag ON app_tags (tag);

-- グループ。入るにはパスワードか招待リンク(invite_code)
CREATE TABLE IF NOT EXISTS app_groups (
  id          TEXT PRIMARY KEY,      -- グループID(人に伝える短い英数字)
  name        TEXT NOT NULL,
  owner_id    TEXT NOT NULL,
  pass_hash   TEXT NOT NULL,
  pass_salt   TEXT NOT NULL,
  invite_code TEXT UNIQUE NOT NULL,
  created_at  TEXT NOT NULL
);

-- グループのメンバー。role は 'owner'(作った人) / 'admin'(管理者) / 'member'
CREATE TABLE IF NOT EXISTS app_group_members (
  group_id  TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  role      TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS app_group_members_user ON app_group_members (user_id);

-- グループの管理者が「このグループには出さない」にしたアカウント(なりすまし対策)
CREATE TABLE IF NOT EXISTS app_group_hidden (
  group_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  tag      TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id, tag)
);

-- 友達。1組につき1行(user_a < user_b)。status は 'pending'(申請中) か 'friends'
CREATE TABLE IF NOT EXISTS app_friends (
  user_a     TEXT NOT NULL,
  user_b     TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_a, user_b)
);
CREATE INDEX IF NOT EXISTS app_friends_b ON app_friends (user_b);

-- 友達からのグループへの招待(受けるとパスワードなしで入れる)
CREATE TABLE IF NOT EXISTS app_group_invites (
  group_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  inviter_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

-- グループのパスワード間違いの回数(総当たり対策)
CREATE TABLE IF NOT EXISTS app_join_fails (
  group_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  count    INTEGER NOT NULL,
  last_at  INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
