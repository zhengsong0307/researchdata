-- ScholarOS 生态 SQLite 表结构设计 v1
-- 2026-09-20
-- 说明：字段注释写在每行后面，方便非技术阅读

PRAGMA journal_mode = WAL;      -- 写前日志，允许读写并发，避免锁全表
PRAGMA foreign_keys = ON;       -- 开启外键约束，防止出现孤儿数据

-- ============================================================
-- 1. 学者（候选人）主表  —— 3914 条
-- ============================================================
CREATE TABLE scholars (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,      -- 姓名
  name_en         TEXT,               -- 英文名
  email           TEXT,               -- 邮箱
  affiliation     TEXT,               -- 所属机构
  country         TEXT,               -- 国家
  interest        TEXT,               -- 研究方向 / 意向
  homepage        TEXT,               -- 个人主页
  h_index         INTEGER,            -- h指数（原数据混了文本和数字，这里统一成数字，空值存 NULL）
  openalex_id     TEXT,               -- OpenAlex 学者ID
  wechat          TEXT,               -- 微信/手机
  wechat_id       TEXT,               -- 微信号
  contact_form    TEXT,               -- 联系方式备注
  status          TEXT NOT NULL DEFAULT '未联系',   -- 状态
  source          TEXT,               -- 来源说明
  source_type     TEXT,               -- 来源类型
  channel         TEXT,               -- 渠道（小红书等）
  fit_line        TEXT,               -- 匹配说明
  collab_form     TEXT,               -- 合作形式
  pool_override   TEXT,               -- 分池覆盖（目前全空）
  academic_grade  TEXT,               -- 学术评级
  academic_score  REAL,               -- 学术分（目前全空）
  academic_facts  TEXT,               -- 学术依据（目前全空，JSON）
  grade_note      TEXT,               -- 评级备注
  prio            TEXT,               -- 优先级
  invite_stage    INTEGER,            -- 邀约阶段
  last_email_date TEXT,               -- 最后发信日期
  notes           TEXT,               -- 备注
  created_at      INTEGER,            -- 创建时间（毫秒时间戳）
  updated_at      INTEGER,            -- 更新时间
  deleted_at      INTEGER             -- 软删除时间；NULL=正常，有值=在回收站
);

CREATE INDEX idx_scholars_email   ON scholars(email);
CREATE INDEX idx_scholars_status  ON scholars(status);
CREATE INDEX idx_scholars_deleted ON scholars(deleted_at);

-- 全文检索：按姓名/机构/方向/备注模糊搜索
CREATE VIRTUAL TABLE scholars_fts USING fts5(
  name, name_en, affiliation, interest, notes,
  content='scholars', content_rowid='id', tokenize='trigram'
);

-- ============================================================
-- 2. 简历表 —— 一个学者可以挂多份简历，文件和网址两种形态都支持
-- ============================================================
CREATE TABLE resumes (
  id            INTEGER PRIMARY KEY,
  scholar_id    INTEGER REFERENCES scholars(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,   -- 'file'=上传的文件, 'url'=个人网站
  blob_key      TEXT,            -- 原 Netlify 的 resumeId，迁移后作为文件名
  filename      TEXT,            -- 原始文件名
  url           TEXT,            -- kind='url' 时存网址
  file_size     INTEGER,         -- 文件字节数
  mime_type     TEXT,            -- 文件类型
  md5           TEXT,            -- 文件指纹，用于校验没损坏
  is_primary    INTEGER DEFAULT 0,  -- 是否主简历
  uploaded_at   INTEGER,
  note          TEXT             -- 备注（比如"原为孤儿文件，人工认领"）
);
CREATE INDEX idx_resumes_scholar ON resumes(scholar_id);

-- ============================================================
-- 3. 企业表 —— ScholarOS 原生 63 家 + 社媒 99 家
--    用 pool 字段区分两个池子，互不干扰，但能跨池查重
-- ============================================================
CREATE TABLE companies (
  id                INTEGER PRIMARY KEY,
  pool              TEXT NOT NULL,   -- 'scholaros' 或 'social'
  ext_id            TEXT,            -- 社媒池原来的 id
  name              TEXT NOT NULL,
  country           TEXT,
  industry          TEXT,
  funding_stage     TEXT,
  homepage          TEXT,
  status            TEXT,
  source            TEXT,
  notes             TEXT,
  -- ScholarOS 池专有
  contact_name      TEXT,
  contact_title     TEXT,
  contact_info      TEXT,
  contact_label     TEXT,
  need_type         TEXT,
  need_detail       TEXT,
  budget            TEXT,
  timeline          TEXT,
  fit_line          TEXT,
  collab_form       TEXT,
  prio              TEXT,
  scholar_match     TEXT,
  discovered_date   TEXT,
  eval_focus        TEXT,
  eval_analysis_html TEXT,
  cross_matches     TEXT,   -- JSON
  alt_contacts      TEXT,   -- JSON
  -- 社媒池专有
  needs             TEXT,
  contact           TEXT,
  email             TEXT,
  researched        INTEGER,
  match_label       TEXT,
  match_count       INTEGER,
  match_updated_at  INTEGER,
  created_at        INTEGER,
  updated_at        INTEGER,
  deleted_at        INTEGER   -- 软删除（原 archived 字段也归到这里）
);
CREATE INDEX idx_companies_pool ON companies(pool);
CREATE INDEX idx_companies_name ON companies(name);

-- ============================================================
-- 4. 合作线索 —— 4 条
-- ============================================================
CREATE TABLE org_leads (
  id          INTEGER PRIMARY KEY,
  ext_id      TEXT,
  org         TEXT,      -- 机构名
  project     TEXT,      -- 项目
  amount      TEXT,      -- 金额
  stage       TEXT,      -- 阶段
  contact     TEXT,      -- 对接人
  ideas       TEXT,      -- 合作思路
  notes       TEXT,
  status      TEXT,
  created_at  INTEGER,
  updated_at  INTEGER,
  deleted_at  INTEGER
);

-- ============================================================
-- 5. 已验证匹配 —— 9 条（学者×企业的撮合记录）
-- ============================================================
CREATE TABLE verified_matches (
  id                INTEGER PRIMARY KEY,
  ext_id            TEXT,
  tag               TEXT,
  descr             TEXT,
  company_page_ref  TEXT,
  points            TEXT,   -- JSON 数组
  follow_up_status  TEXT,
  verified_at       INTEGER,
  verified_note     TEXT
);

-- 匹配里涉及哪些学者/企业，单独拆成关联表，方便反查"这个学者被匹配过几次"
CREATE TABLE match_scholars (
  match_id    INTEGER REFERENCES verified_matches(id) ON DELETE CASCADE,
  scholar_id  INTEGER REFERENCES scholars(id),
  name_snapshot TEXT,        -- 当时记录的姓名，对不上学者表时保留原文
  affiliation_snapshot TEXT
);
CREATE TABLE match_companies (
  match_id    INTEGER REFERENCES verified_matches(id) ON DELETE CASCADE,
  company_id  INTEGER REFERENCES companies(id),
  name_snapshot TEXT
);

-- ============================================================
-- 6. 简报 —— 2 条
-- ============================================================
CREATE TABLE briefings (
  id           INTEGER PRIMARY KEY,
  ext_id       TEXT,
  date         TEXT,
  title        TEXT,
  content_html TEXT,
  data_json    TEXT,
  created_at   INTEGER
);

-- ============================================================
-- 7. 月度笔记 —— 3 条（目前都是空字符串）
-- ============================================================
CREATE TABLE month_notes (
  month  TEXT PRIMARY KEY,   -- 'aug' / 'sep' / 'oct'
  note   TEXT
);

-- ============================================================
-- 8. 活动日志 —— 目前为空，留着接新数据
-- ============================================================
CREATE TABLE activity_log (
  id          INTEGER PRIMARY KEY,
  event_type  TEXT,
  payload     TEXT,     -- JSON
  created_at  INTEGER
);

-- ============================================================
-- 9. 学者参考库 scholar90k —— 72969 条，只读参考数据
--    跟上面的 scholars 表分开：这是外部检索来的大池子，
--    scholars 是你实际在运营的人
-- ============================================================
CREATE TABLE scholar_pool (
  id            INTEGER PRIMARY KEY,   -- 对应原数据的 i
  name          TEXT,      -- n
  affiliation   TEXT,      -- a
  country       TEXT,      -- c
  h_index       INTEGER,   -- h
  email         TEXT,      -- e
  author_count  INTEGER,   -- ac
  top_title     TEXT,      -- ta  代表作标题
  top_year      INTEGER,   -- ty
  top_citations INTEGER,   -- tc
  top_journal   TEXT,      -- tj
  keywords      TEXT,      -- kw  JSON 数组
  link          TEXT,      -- link
  tier          TEXT       -- t   分层标签
);
CREATE INDEX idx_pool_country ON scholar_pool(country);
CREATE INDEX idx_pool_hindex  ON scholar_pool(h_index);

CREATE VIRTUAL TABLE scholar_pool_fts USING fts5(
  name, affiliation, top_title, keywords,
  content='scholar_pool', content_rowid='id', tokenize='trigram'
);

-- ============================================================
-- 10. 迁移元信息 —— 记录这份库是怎么来的，便于日后追溯
-- ============================================================
CREATE TABLE migration_meta (
  key    TEXT PRIMARY KEY,
  value  TEXT
);
