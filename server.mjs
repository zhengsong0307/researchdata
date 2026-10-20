// ScholarOS 后端 API
import express from 'express';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { db, RESUME_DIR } from './lib/db.mjs';
import { login, logout, userFromToken, cleanupSessions,
         atLeast, maskForRole, audit, ROLES } from './lib/auth.mjs';
import { legacy } from './lib/legacy.mjs';
import { parse } from './lib/parse.mjs';
import { automation } from './lib/automation.mjs';

const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);              // 前面有 Nginx，取真实来源 IP
// ScholarOS 保存时会把整份数据 POST 回来，目前约 2.9MB，留足余量。
// （前端改成按需分页后这个数字会大幅下降，到时可以调回小值。）
app.use(express.json({ limit: '12mb' }));

// —— 访问方式一：访问密钥（当前主用）——
// 三把密钥对应三种角色。密钥可以放在网址 ?key=、请求头 X-SOS-Key，或 cookie 里。
// 首次用网址带密钥访问后，服务器会把它存进 cookie，之后就不用再带了，
// 这样密钥不会一直留在浏览器地址栏和服务器日志里。
const KEYS = {
  admin:   process.env.SOS_ADMIN_KEY   || '',
  member:  process.env.SOS_MEMBER_KEY  || '',
  visitor: process.env.SOS_VISITOR_KEY || '',
};
function roleFromKey(k) {
  if (!k) return null;
  for (const [role, val] of Object.entries(KEYS)) if (val && k === val) return role;
  return null;
}
function cookieVal(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

// —— 访问方式二：账号登录（已实现，留着以后用）——
function tokenOf(req) { return cookieVal(req, 'sos_session'); }

app.use((req, res, next) => {
  // 先看账号登录
  const byLogin = userFromToken(tokenOf(req));
  if (byLogin) { req.user = byLogin; return next(); }

  // 再看访问密钥
  const supplied = req.query.key || req.headers['x-sos-key'] || cookieVal(req, 'sos_key');
  const role = roleFromKey(supplied);
  if (role) {
    req.user = { id: null, username: `key:${role}`, displayName: `密钥访问(${role})`, role };
    // 网址里带的密钥，转存到 cookie，让地址栏干净
    if (req.query.key && cookieVal(req, 'sos_key') !== req.query.key) {
      res.setHeader('Set-Cookie',
        `sos_key=${encodeURIComponent(req.query.key)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${180 * 86400}` +
        (process.env.NO_HTTPS ? '' : '; Secure'));
    }
    return next();
  }

  // —— 免密钥模式 ——
  // 设了 SOS_DEFAULT_ROLE，没带密钥的访问也按这个角色放行。
  // 想重新启用密钥：把 /etc/scholaros/keys.env 里这一行删掉或注释，重启服务即可。
  const DEFAULT_ROLE = process.env.SOS_DEFAULT_ROLE || '';
  if (ROLES.includes(DEFAULT_ROLE)) {
    req.user = { id: null, username: `open:${DEFAULT_ROLE}`,
                 displayName: `免密钥访问(${DEFAULT_ROLE})`, role: DEFAULT_ROLE };
    return next();
  }

  req.user = null;
  next();
});

const need = (role) => (req, res, next) =>
  atLeast(req.user, role) ? next()
    : res.status(req.user ? 403 : 401).json({ error: req.user ? '权限不足' : '缺少访问密钥' });

const ip = (req) => req.ip;

// ============ 登录相关 ============
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请填写用户名和密码' });
  const r = login(String(username), String(password),
                  { userAgent: req.headers['user-agent'], ip: ip(req) });
  if (!r.ok) { audit(null, 'login_failed', username, null, ip(req)); return res.status(401).json({ error: r.reason }); }
  res.setHeader('Set-Cookie',
    `sos_session=${r.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${14 * 86400}` +
    (process.env.NO_HTTPS ? '' : '; Secure'));
  audit(r.user, 'login', null, null, ip(req));
  res.json({ user: r.user });
});

app.post('/api/logout', (req, res) => {
  audit(req.user, 'logout', null, null, ip(req));
  logout(tokenOf(req));
  res.setHeader('Set-Cookie', 'sos_session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => res.json({ user: req.user || null }));

// ============ 健康检查 + 延迟自测 ============
// 用来测你们那边访问这台服务器的真实速度
app.get('/api/ping', (req, res) => res.json({ ok: true, serverTime: Date.now() }));

// 体检接口：给外部监控服务定时访问。任何一项不正常就返回 503，监控服务据此发报警。
// 只返回是否正常和时间，不暴露数据内容。
app.get('/api/health', async (_req, res) => {
  const checks = {}; const now = Date.now(); const H = 3600e3;
  try { checks.database = db.prepare('SELECT COUNT(*) c FROM scholars WHERE deleted_at IS NULL').get().c > 0; }
  catch { checks.database = false; }
  try {
    const { statfsSync, readdirSync, statSync } = await import('node:fs');
    const st = statfsSync('/var/lib/scholaros');
    const freePct = Math.round(st.bavail / st.blocks * 100);
    checks.diskFreePercent = freePct; checks.disk = freePct >= 10;
    const bk = readdirSync('/var/lib/scholaros/backups').filter((f) => f.startsWith('auto_'))
      .map((f) => statSync('/var/lib/scholaros/backups/' + f).mtimeMs).sort((a, b) => b - a)[0] || 0;
    checks.lastBackupHoursAgo = bk ? Math.round((now - bk) / H) : null;
    checks.backup = !!bk && now - bk < 30 * H;            // 每天 03:30 备份，超过 30 小时没新备份就算异常
  } catch { checks.disk = false; checks.backup = false; }
  const nightly = Number(db.prepare("SELECT value v FROM migration_meta WHERE key='matches_computed_at'").get()?.v || 0);
  checks.lastNightlyHoursAgo = nightly ? Math.round((now - nightly) / H) : null;
  checks.nightly = !!nightly && now - nightly < 30 * H;   // 每天 04:00 夜间任务
  const ok = checks.database && checks.disk && checks.backup && checks.nightly;
  res.status(ok ? 200 : 503).json({ ok, checks, time: new Date(now).toISOString() });
});

// ============ 学者 ============
const SCHOLAR_COLS = `id,name,name_en,email,affiliation,country,interest,homepage,h_index,
  openalex_id,wechat,wechat_id,contact_form,status,source,source_type,channel,fit_line,
  collab_form,academic_grade,prio,invite_stage,last_email_date,notes,updated_at`;

app.get('/api/scholars', need('visitor'), (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const q = (req.query.q || '').trim();
  const status = (req.query.status || '').trim();
  const country = (req.query.country || '').trim();

  const where = ['deleted_at IS NULL'];
  const params = [];
  if (q) {
    // FTS5 的 trigram 分词需要至少 3 个字符，搜「韩」「李」这类短词会返回空。
    // 所以短词改走 LIKE 模糊匹配，长词才用全文检索（快很多）。
    if (Array.from(q).length < 3) {
      const like = `%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
      where.push(`(name LIKE ? ESCAPE '\\' OR name_en LIKE ? ESCAPE '\\'
                   OR affiliation LIKE ? ESCAPE '\\' OR interest LIKE ? ESCAPE '\\'
                   OR email LIKE ? ESCAPE '\\')`);
      params.push(like, like, like, like, like);
    } else {
      where.push(`id IN (SELECT rowid FROM scholars_fts WHERE scholars_fts MATCH ?)`);
      params.push(q.replace(/"/g, '""'));
    }
  }
  if (status) { where.push('status = ?'); params.push(status); }
  if (country) { where.push('country = ?'); params.push(country); }
  const w = where.join(' AND ');

  const total = db.prepare(`SELECT COUNT(*) c FROM scholars WHERE ${w}`).get(...params).c;
  const rows = db.prepare(
    `SELECT ${SCHOLAR_COLS} FROM scholars WHERE ${w} ORDER BY id LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  res.json({ total, limit, offset, items: rows.map(r => maskForRole(r, req.user)) });
});

app.get('/api/scholars/:id', need('visitor'), (req, res) => {
  const row = db.prepare(`SELECT * FROM scholars WHERE id=? AND deleted_at IS NULL`).get(req.params.id);
  if (!row) return res.status(404).json({ error: '找不到这个学者' });
  const resumes = db.prepare(
    `SELECT id,kind,blob_key,filename,url,file_size,mime_type,is_primary,uploaded_at,note
     FROM resumes WHERE scholar_id=? ORDER BY is_primary DESC, uploaded_at DESC`).all(row.id);
  res.json({ scholar: maskForRole(row, req.user), resumes });
});

// 只改指定字段，不再整包读写
const EDITABLE = new Set(['name','name_en','email','affiliation','country','interest','homepage',
  'h_index','wechat','wechat_id','contact_form','status','source','channel','fit_line',
  'collab_form','academic_grade','prio','invite_stage','last_email_date','notes']);

app.patch('/api/scholars/:id', need('member'), (req, res) => {
  const row = db.prepare('SELECT * FROM scholars WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '找不到这个学者' });
  const patch = req.body || {};
  const sets = [], vals = [], changed = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!EDITABLE.has(k)) continue;
    if (String(row[k] ?? '') === String(v ?? '')) continue;
    sets.push(`${k} = ?`); vals.push(v === '' ? null : v);
    changed[k] = { from: row[k], to: v };
  }
  if (!sets.length) return res.json({ ok: true, changed: {} });
  sets.push('updated_at = ?'); vals.push(Date.now());
  db.prepare(`UPDATE scholars SET ${sets.join(', ')} WHERE id = ?`).run(...vals, row.id);
  audit(req.user, 'update_scholar', `scholars:${row.id}`, changed, ip(req));
  res.json({ ok: true, changed });
});

app.delete('/api/scholars/:id', need('member'), (req, res) => {
  const r = db.prepare('UPDATE scholars SET deleted_at=? WHERE id=? AND deleted_at IS NULL')
    .run(Date.now(), req.params.id);
  if (!r.changes) return res.status(404).json({ error: '找不到这个学者' });
  audit(req.user, 'trash_scholar', `scholars:${req.params.id}`, null, ip(req));
  res.json({ ok: true });
});

app.post('/api/scholars/:id/restore', need('member'), (req, res) => {
  const r = db.prepare('UPDATE scholars SET deleted_at=NULL WHERE id=?').run(req.params.id);
  audit(req.user, 'restore_scholar', `scholars:${req.params.id}`, null, ip(req));
  res.json({ ok: !!r.changes });
});

// ============ 简历文件 ============
app.get('/api/resumes/:id/file', need('member'), (req, res) => {
  const r = db.prepare('SELECT * FROM resumes WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到这份简历' });
  if (r.kind === 'url') return res.redirect(r.url);
  const p = path.join(RESUME_DIR, r.blob_key);
  if (!existsSync(p)) return res.status(404).json({ error: '文件不存在' });
  res.setHeader('Content-Type', r.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition',
    `inline; filename*=UTF-8''${encodeURIComponent(r.filename || r.blob_key)}`);
  audit(req.user, 'view_resume', `resumes:${r.id}`, null, ip(req));
  res.send(readFileSync(p));
});

// ============ 企业 ============
app.get('/api/companies', need('visitor'), (req, res) => {
  const pool = (req.query.pool || '').trim();
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const where = ['deleted_at IS NULL']; const params = [];
  if (pool) { where.push('pool = ?'); params.push(pool); }
  const w = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) c FROM companies WHERE ${w}`).get(...params).c;
  const rows = db.prepare(`SELECT * FROM companies WHERE ${w} ORDER BY id LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  res.json({ total, limit, offset, items: rows.map(r => maskForRole(r, req.user)) });
});

// ============ 合作线索 / 匹配 / 简报 ============
app.get('/api/org-leads', need('member'), (_req, res) =>
  res.json({ items: db.prepare('SELECT * FROM org_leads WHERE deleted_at IS NULL ORDER BY id').all() }));

app.get('/api/matches', need('visitor'), (req, res) => {
  const rows = db.prepare('SELECT * FROM verified_matches ORDER BY id').all();
  for (const m of rows) {
    m.scholars = db.prepare(
      'SELECT scholar_id,name_snapshot,affiliation_snapshot FROM match_scholars WHERE match_id=?').all(m.id);
    m.companies = db.prepare(
      'SELECT company_id,name_snapshot FROM match_companies WHERE match_id=?').all(m.id);
  }
  res.json({ items: rows });
});

app.get('/api/briefings', need('visitor'), (_req, res) =>
  res.json({ items: db.prepare('SELECT id,ext_id,date,title,created_at FROM briefings ORDER BY date DESC').all() }));

app.get('/api/briefings/:id', need('visitor'), (req, res) => {
  const b = db.prepare('SELECT * FROM briefings WHERE id=?').get(req.params.id);
  b ? res.json(b) : res.status(404).json({ error: '找不到这份简报' });
});

// ============ 审计日志（仅管理员）============
app.get('/api/audit', need('admin'), (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json({ items: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit) });
});

// ============ 统计概览 ============
app.get('/api/stats', need('visitor'), (_req, res) => {
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  res.json({
    scholars: one('SELECT COUNT(*) c FROM scholars WHERE deleted_at IS NULL').c,
    scholarsTrashed: one('SELECT COUNT(*) c FROM scholars WHERE deleted_at IS NOT NULL').c,
    companiesScholaros: one("SELECT COUNT(*) c FROM companies WHERE pool='scholaros' AND deleted_at IS NULL").c,
    companiesSocial: one("SELECT COUNT(*) c FROM companies WHERE pool='social' AND deleted_at IS NULL").c,
    orgLeads: one('SELECT COUNT(*) c FROM org_leads WHERE deleted_at IS NULL').c,
    matches: one('SELECT COUNT(*) c FROM verified_matches').c,
    resumes: one('SELECT COUNT(*) c FROM resumes').c,
  });
});

// ============ 简历解析（服务器端提取文字 / OCR）============
app.use('/api', need('member'), parse);

// ============ 自动化：匹配 / 跟进 / 看板 ============
app.use('/api', need('member'), automation);

// ============ 旧接口兼容层 ============
// 四个前端调的就是这组接口，格式跟原来完全一致。
// 同样需要密钥（页面加载时会带上），访客密钥只能读。
app.use('/legacy', (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: '缺少访问密钥' });
  const writing = req.method !== 'GET' && req.method !== 'OPTIONS';
  // fellow-apply 是对外自助申请，允许访客提交
  const isApply = req.path.endsWith('/fellow-apply');
  if (writing && !isApply && !atLeast(req.user, 'member'))
    return res.status(403).json({ error: '权限不足' });
  next();
}, legacy);

// ============ 入口：用密钥换 cookie ============
// 访问 http://服务器/api/enter?key=密钥  就会把密钥存进 cookie 并跳到应用，
// 之后地址栏里就不用再带密钥了。
app.get('/api/enter', (req, res) => {
  const key = String(req.query.key || '');
  const role = roleFromKey(key);
  if (!role) return res.status(403).send('<meta charset="utf-8">密钥无效');
  const to = String(req.query.to || '/ai4s/');
  // 只允许跳到本站内部路径，防止被拿去做跳转诈骗
  const safe = /^\/[A-Za-z0-9_\-/.]*$/.test(to) ? to : '/ai4s/';
  res.setHeader('Set-Cookie',
    `sos_key=${encodeURIComponent(key)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${180 * 86400}` +
    (process.env.NO_HTTPS ? '' : '; Secure'));
  res.redirect(302, safe);
});

// —— 出错兜底 ——
app.use((err, _req, res, _next) => {
  console.error('[错误]', err);
  res.status(500).json({ error: '服务器内部错误' });
});

// 每小时清理过期登录
setInterval(() => { const n = cleanupSessions(); if (n) console.log(`清理过期登录 ${n} 条`); }, 3600_000);

app.listen(PORT, '127.0.0.1', () =>
  console.log(`ScholarOS API 已启动，监听 127.0.0.1:${PORT}`));
