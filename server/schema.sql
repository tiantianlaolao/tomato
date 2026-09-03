-- Capyroom · 账号 + 跨设备同步（2026-09-03，从戳了么 schema.sql 账号半边原样搬来）
-- 全部 IF NOT EXISTS：服务每次启动都跑一遍，对老库空转。
-- 口径：这里存的是**用户主动注册**的身份（Apple / Google 的 sub、或手机号），
--       不存 ip、不存设备号、不存 UA。同步的 data 服务端不解析，只当哑仓库。

CREATE TABLE IF NOT EXISTS users (
  uid      TEXT PRIMARY KEY,           -- 服务端生成的随机 id（'u'+24hex）
  provider TEXT NOT NULL,              -- 'apple' | 'google' | 'phone'
  subject  TEXT NOT NULL,              -- 提供方的稳定用户号（id_token 的 sub；phone = 11 位手机号）
  email    TEXT,                       -- 只用来展示"你登录的是哪个号"。Apple 只在首次授权给一次——只在有值时更新
  created  INTEGER NOT NULL,
  UNIQUE (provider, subject)
);

CREATE TABLE IF NOT EXISTS sessions (
  token   TEXT PRIMARY KEY,            -- 48 位随机 hex，客户端持有（Bearer）
  uid     TEXT NOT NULL,
  created INTEGER NOT NULL,
  seen    INTEGER NOT NULL             -- 最近使用；滑动 400 天过期（account.js 清扫）
);

-- 匿名安装号 → 账号（戳了么用它把分享作者归到账号；Capyroom 暂时只记录，登录时可选传）
CREATE TABLE IF NOT EXISTS installs (
  install TEXT PRIMARY KEY,
  uid     TEXT NOT NULL,
  created INTEGER NOT NULL
);

-- 跨设备同步：记录级 LWW。
--   kind/id = 客户端命名空间（session/<started_ms>、plan/<id>、schedule/<id>、rewards/'rewards'、settings/'settings'）
--   data NULL = 墓碑；mtime = 客户端修改时间，谁新谁赢；seq = 按 uid 单调递增，增量拉取游标
CREATE TABLE IF NOT EXISTS sync_items (
  uid   TEXT NOT NULL,
  kind  TEXT NOT NULL,
  id    TEXT NOT NULL,
  data  TEXT,
  mtime INTEGER NOT NULL,
  seq   INTEGER NOT NULL,
  PRIMARY KEY (uid, kind, id)
);
CREATE INDEX IF NOT EXISTS idx_sync_uid_seq ON sync_items(uid, seq);
CREATE INDEX IF NOT EXISTS idx_sessions_uid ON sessions(uid);

-- 手机号登录验证码（中国区专用；海外实例不配短信凭据 = 这条路 501）
CREATE TABLE IF NOT EXISTS sms_codes (
  phone    TEXT PRIMARY KEY,
  hash     TEXT NOT NULL,              -- sha256(验证码)，不存明文
  expires  INTEGER NOT NULL,           -- 毫秒，5 分钟
  tries    INTEGER NOT NULL DEFAULT 0, -- ≥5 作废
  lastSent INTEGER NOT NULL,           -- 60 秒冷却
  dayKey   TEXT,
  dayCount INTEGER NOT NULL DEFAULT 0  -- 每号每天最多 8 条
);
