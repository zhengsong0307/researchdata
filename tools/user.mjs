#!/usr/bin/env node
// 账号管理命令行工具
// 用法：
//   node tools/user.mjs add <用户名> <角色>     新建账号（会提示输入密码）
//   node tools/user.mjs passwd <用户名>          改密码
//   node tools/user.mjs list                     列出所有账号
//   node tools/user.mjs disable <用户名>         停用
//   node tools/user.mjs enable <用户名>          启用
import { db } from '../lib/db.mjs';
import { hashPassword, ROLES } from '../lib/auth.mjs';
import readline from 'node:readline';
import { Writable } from 'node:stream';

// 隐藏输入的密码提示
// 用终端的"原始模式"关掉系统级回显。之前用 readline 自定义输出流的做法
// 关不掉终端驱动自己的回显，密码会显示在屏幕上（2026-09-20 修复）。
function askHidden(prompt) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    // 保险：拿不到真正的终端就拒绝收密码，绝不在可能回显的环境下运行
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
      console.error('\n错误：当前不是交互式终端，拒绝在此读取密码（避免密码被显示或记录）。');
      console.error('请用 ssh -t 连接后再运行，例如：');
      console.error('  ssh -i <密钥> -t root@<服务器> "cd /opt/scholaros && node tools/user.mjs ..."');
      process.exit(1);
    }
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const done = (val) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      resolve(val);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return done(buf);
        if (ch === '\u0003') {                  // Ctrl-C
          stdin.setRawMode(false);
          process.stdout.write('\n已取消\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') { buf = buf.slice(0, -1); continue; }
        if (ch < ' ') continue;                  // 忽略其它控制字符
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readPasswordTwice() {
  const p1 = await askHidden('请输入密码（输入时屏幕不显示）: ');
  if (p1.length < 8) { console.error('密码至少 8 位，请重来。'); process.exit(1); }
  const p2 = await askHidden('请再输入一次确认: ');
  if (p1 !== p2) { console.error('两次输入不一致，请重来。'); process.exit(1); }
  return p1;
}

const [, , cmd, arg1, arg2] = process.argv;

if (cmd === 'add') {
  if (!arg1 || !ROLES.includes(arg2)) {
    console.error(`用法: node tools/user.mjs add <用户名> <${ROLES.join('|')}>`); process.exit(1);
  }
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(arg1)) {
    console.error(`账号 ${arg1} 已存在。改密码请用 passwd 命令。`); process.exit(1);
  }
  const pwd = await readPasswordTwice();
  const { hash, salt } = hashPassword(pwd);
  db.prepare(`INSERT INTO users (username,display_name,role,pwd_hash,pwd_salt,created_at)
              VALUES (?,?,?,?,?,?)`).run(arg1, arg1, arg2, hash, salt, Date.now());
  console.log(`已创建账号 ${arg1}（角色 ${arg2}）`);

} else if (cmd === 'passwd') {
  const u = db.prepare('SELECT id FROM users WHERE username=?').get(arg1);
  if (!u) { console.error(`没有账号 ${arg1}`); process.exit(1); }
  const pwd = await readPasswordTwice();
  const { hash, salt } = hashPassword(pwd);
  db.prepare('UPDATE users SET pwd_hash=?,pwd_salt=?,failed_count=0,locked_until=NULL WHERE id=?')
    .run(hash, salt, u.id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);  // 改密码后旧登录全部失效
  console.log(`${arg1} 的密码已更新，该账号原有的登录状态已全部退出`);

} else if (cmd === 'list') {
  const rows = db.prepare(`SELECT username,display_name,role,is_active,created_at,last_login_at
                           FROM users ORDER BY id`).all();
  if (!rows.length) { console.log('还没有任何账号'); }
  const fmt = (t) => t ? new Date(t).toLocaleString('zh-CN') : '从未';
  for (const r of rows) {
    console.log(`${r.username.padEnd(16)} ${r.role.padEnd(8)} ${r.is_active ? '启用' : '停用'}  最后登录 ${fmt(r.last_login_at)}`);
  }

} else if (cmd === 'disable' || cmd === 'enable') {
  const v = cmd === 'enable' ? 1 : 0;
  const r = db.prepare('UPDATE users SET is_active=? WHERE username=?').run(v, arg1);
  if (!r.changes) { console.error(`没有账号 ${arg1}`); process.exit(1); }
  if (!v) db.prepare('DELETE FROM sessions WHERE user_id=(SELECT id FROM users WHERE username=?)').run(arg1);
  console.log(`${arg1} 已${v ? '启用' : '停用'}`);

} else {
  console.log(`账号管理

  node tools/user.mjs add <用户名> <角色>    新建账号，角色可选 ${ROLES.join(' / ')}
  node tools/user.mjs passwd <用户名>        修改密码
  node tools/user.mjs list                   列出所有账号
  node tools/user.mjs disable <用户名>       停用账号
  node tools/user.mjs enable <用户名>        启用账号

角色说明
  admin    全部读写，可管理账号
  member   读写学者和企业数据，不能管账号
  visitor  只读，且看不到联系方式`);
}
db.close();
