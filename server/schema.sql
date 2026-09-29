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

-- 支付（9-29，从戳了么搬来）：订单 + 权益。只有中国区实例配支付宝；美服这两张表空着。
CREATE TABLE IF NOT EXISTS orders (
  out_trade_no TEXT PRIMARY KEY,       -- 我们的订单号（CP + base36 时间 + 随机）
  uid          TEXT NOT NULL,          -- 买的人（必须登录才能买：权益要有归属，换机才找得回）
  product      TEXT NOT NULL,          -- 'theme.onsen' …（价目表从 rewards_catalog.json 读，见 pay.js）
  amount_fen   INTEGER NOT NULL,       -- 服务端定的金额（分）；notify/反查回来的金额必须和它一致
  channel      TEXT NOT NULL,          -- 'alipay_wap' | 'alipay_app'
  status       TEXT NOT NULL,          -- CREATED | PAID | CLOSED
  trade_no     TEXT UNIQUE,            -- 支付宝交易号。UNIQUE = 同一笔交易只能落一单
  created      INTEGER NOT NULL,
  paid_at      INTEGER,
  queried_at   INTEGER,                -- 上次主动反查支付宝的时间（限频）
  raw          TEXT                    -- 到账那条 notify / 反查响应原文（对账用）
);
CREATE INDEX IF NOT EXISTS idx_orders_uid ON orders(uid, created);

CREATE TABLE IF NOT EXISTS entitlements (
  uid        TEXT NOT NULL,
  product    TEXT NOT NULL,            -- 与 orders.product 同口径
  granted_at INTEGER NOT NULL,
  order_no   TEXT,                     -- 哪一单发的
  PRIMARY KEY (uid, product)
);

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
