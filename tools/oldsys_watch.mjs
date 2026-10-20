#!/usr/bin/env node
// 盯旧系统：旧的 Netlify / Cloudflare 站点在正式下线前（Netlify 额度 2026-10-05 才重置，之前没法部署跳转页），
// 如果有人用旧链接改了数据，新系统不会知道。这里每晚把旧系统的数据拉下来，跟迁移时的快照比指纹，
// 一旦不同就记下来，ScholarOS 运营看板会亮红灯提醒去同步。只读，不改旧系统任何东西。
import { createHash } from 'node:crypto';
import { db } from '../lib/db.mjs';

// 2026-09-20 迁移快照的指纹（9/23 复查时旧系统仍与之完全一致）
const TARGETS = [
  { key: 'scholaros', label: '旧 ScholarOS（Netlify）',
    url: 'https://expert-ops-workstation.netlify.app/.netlify/functions/scholaros-data' },
  { key: 'social', label: '旧社媒页（Cloudflare）',
    url: 'https://audax-social-intake.cf-scholaros-overflow.workers.dev/.netlify/functions/scholaros-data' },
];
const meta = (k) => db.prepare('SELECT value FROM migration_meta WHERE key=?').get(k)?.value;
const setMeta = (k, v) => db.prepare(`INSERT INTO migration_meta (key,value) VALUES (?,?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(k, String(v));

const results = [];
for (const t of TARGETS) {
  try {
    const r = await fetch(t.url, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    JSON.parse(buf.toString('utf-8'));                          // 确认内容完整
    const md5 = createHash('md5').update(buf).digest('hex');
    const base = meta('oldsys_baseline_' + t.key);
    if (!base) { setMeta('oldsys_baseline_' + t.key, md5); results.push({ ...t, state: '已记录基线', md5 }); continue; }
    const changed = md5 !== base;
    if (changed && !meta('oldsys_changed_' + t.key)) setMeta('oldsys_changed_' + t.key, Date.now());
    results.push({ ...t, state: changed ? '有变化' : '无变化', md5 });
  } catch (e) {
    results.push({ ...t, state: '检查失败：' + e.message });
  }
}
setMeta('oldsys_checked_at', Date.now());
setMeta('oldsys_last_result', JSON.stringify(results.map(({ key, label, state }) => ({ key, label, state }))));
for (const r of results) console.log(`${r.label}：${r.state}`);
