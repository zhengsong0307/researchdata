// 账号认证：密码哈希、登录、会话
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { db } from './db.mjs';

const SESSION_DAYS = 14;          // 登录后多久要重新登录
const MAX_FAILED = 8;             // 连续失败几次锁定
const LOCK_MINUTES = 15;          // 锁多久

// —— 密码 ——
// scrypt 是专门设计得"算起来很慢"的算法，这样即使密码哈希泄露，
// 暴力破解也会慢到不可行。加盐是为了让相同的密码算出不同的哈希。
export function hashPassword(plain) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(plain, salt, 64).toString('hex');
  return { hash, salt };
}
function verifyPassword(plain, hash, salt) {
  const calc = scryptSync(plain, salt, 64);
  const want = Buffer.from(hash, 'hex');
  if (calc.length !== want.length) return false;
  return timingSafeEqual(calc, want);   // 定时安全比较，防止通过响应时间猜密码
}

// —— 登录 ——
export function login(username, password, meta = {}) {
  const u = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username);
  const now = Date.now();

  // 无论账号存不存在都走一遍哈希计算，让失败耗时一致，
  // 防止通过响应快慢推断"这个用户名存不存在"
  if (!u) { scryptSync(password, 'dummy', 64); return { ok: false, reason: '用户名或密码错误' }; }

  if (u.locked_until && u.locked_until > now) {
    const mins = Math.ceil((u.locked_until - now) / 60000);
    return { ok: false, reason: `失败次数过多，请 ${mins} 分钟后再试` };
  }

  if (!verifyPassword(password, u.pwd_hash, u.pwd_salt)) {
    const n = u.failed_count + 1;
    db.prepare('UPDATE users SET failed_count=?, locked_until=? WHERE id=?')
      .run(n, n >= MAX_FAILED ? now + LOCK_MINUTES * 60000 : null, u.id);
    return { ok: false, reason: '用户名或密码错误' };
  }

  db.prepare('UPDATE users SET failed_count=0, locked_until=NULL, last_login_at=? WHERE id=?')
    .run(now, u.id);

  const token = randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO sessions (token,user_id,created_at,expires_at,user_agent,ip)
              VALUES (?,?,?,?,?,?)`)
    .run(token, u.id, now, now + SESSION_DAYS * 86400000,
         meta.userAgent || null, meta.ip || null);

  return { ok: true, token, user: publicUser(u) };
}

export function logout(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function userFromToken(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ? AND u.is_active = 1`).get(token, Date.now());
  return row ? publicUser(row) : null;
}

export function cleanupSessions() {
  return db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()).changes;
}

const publicUser = (u) => ({ id: u.id, username: u.username,
  displayName: u.display_name || u.username, role: u.role });

// —— 权限 ——
export const ROLES = ['admin', 'member', 'visitor'];
const RANK = { visitor: 1, member: 2, admin: 3 };
export const atLeast = (user, role) => !!user && RANK[user.role] >= RANK[role];

// visitor 看不到联系方式——这些字段会被抹掉
export const CONTACT_FIELDS = ['email', 'wechat', 'wechat_id', 'contact_form',
  'contact_info', 'contact', 'contact_name', 'contact_title', 'alt_contacts'];

export function maskForRole(row, user) {
  if (atLeast(user, 'member')) return row;
  const out = { ...row };
  for (const f of CONTACT_FIELDS) if (f in out) out[f] = null;
  return out;
}

// —— 审计 ——
export function audit(user, action, target, detail, ip) {
  db.prepare(`INSERT INTO audit_log (user_id,username,action,target,detail,ip,created_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run(user?.id ?? null, user?.username ?? null, action, target ?? null,
         detail ? JSON.stringify(detail) : null, ip ?? null, Date.now());
}
