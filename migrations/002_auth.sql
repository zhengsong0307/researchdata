-- 账号与会话（第二次迁移，2026-09-20）

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,   -- 登录名
  display_name  TEXT,                   -- 显示名
  role          TEXT NOT NULL,          -- admin / member / visitor
  pwd_hash      TEXT NOT NULL,          -- 密码哈希（scrypt，不可逆）
  pwd_salt      TEXT NOT NULL,          -- 加盐，防止相同密码算出相同哈希
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER,
  failed_count  INTEGER NOT NULL DEFAULT 0,  -- 连续失败次数，防暴力破解
  locked_until  INTEGER                       -- 锁定到什么时候
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,   -- 随机令牌
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  user_agent  TEXT,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- 操作审计：谁在什么时候改了什么，出问题能追溯
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER,
  username    TEXT,
  action      TEXT NOT NULL,   -- 比如 update_scholar
  target      TEXT,            -- 比如 scholars:3644
  detail      TEXT,            -- JSON，改了哪些字段
  ip          TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
