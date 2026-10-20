#!/usr/bin/env node
// 用 OpenAlex（免费的学术数据库，无需密钥）补全学者的学术数据
// 原则：宁可不填，也不填错——
//   · 姓名必须完全对上（顺序可以不同），机构也必须对上，且只有唯一一个候选人才写入
//   · 只补空字段，已有的 h 指数不覆盖
//   · 只有中文名、没有英文名的学者跳过（拼音同名太多，没法可靠区分）
// 用法：node tools/openalex.mjs [最多处理多少人，默认 800] [--recheck] [--dry 只看不写]
import { db } from '../lib/db.mjs';

const LIMIT = Number(process.argv[2]) || 800;
const RECHECK = process.argv.includes('--recheck');
const DRY = process.argv.includes('--dry');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 中文机构名 → OpenAlex 里的英文名（覆盖库里常见的高校和研究机构）
const CN = {
  '清华': 'tsinghua', '北京大学': 'peking university', '浙江大学': 'zhejiang university', '复旦': 'fudan',
  '上海交通': 'shanghai jiao tong', '中国科学技术大学': 'science and technology of china',
  '南京大学': 'nanjing university', '中国科学院大学': 'university of chinese academy of sciences',
  '中国科学院': 'chinese academy of sciences', '中科院': 'chinese academy of sciences',
  '武汉大学': 'wuhan university', '华中科技': 'huazhong university', '中山大学': 'sun yat-sen',
  '同济': 'tongji', '西安交通': "xi'an jiaotong", '哈尔滨工业': 'harbin institute of technology',
  '北京航空航天': 'beihang', '南开': 'nankai', '天津大学': 'tianjin university', '中南大学': 'central south university',
  '厦门大学': 'xiamen university', '山东大学': 'shandong university', '四川大学': 'sichuan university',
  '电子科技大学': 'electronic science and technology of china', '东南大学': 'southeast university',
  '湖南大学': 'hunan university', '上海科技': 'shanghaitech', '南方科技': 'southern university of science',
  '香港大学': 'university of hong kong', '香港中文': 'chinese university of hong kong',
  '香港科技': 'hong kong university of science', '香港城市': 'city university of hong kong',
  '北京师范': 'beijing normal', '中国人民大学': 'renmin', '大连理工': 'dalian university of technology',
  '吉林大学': 'jilin university', '西北工业': 'northwestern polytechnical', '华东师范': 'east china normal',
  '北京理工': 'beijing institute of technology', '南京航空航天': 'nanjing university of aeronautics',
  '中国海洋': 'ocean university of china', '苏州大学': 'soochow', '深圳大学': 'shenzhen university',
  '西湖大学': 'westlake', '澳门大学': 'university of macau', '新加坡国立': 'national university of singapore',
  '南洋理工': 'nanyang technological', '京都大学': 'kyoto university', '东京大学': 'university of tokyo',
  '上海人工智能实验室': 'shanghai artificial intelligence laboratory', '之江实验室': 'zhejiang lab',
};
// 太常见、单独出现不能证明是同一机构的词
const WEAK = new Set(('university of the and for institute school department dept college laboratory lab center centre ' +
  'research science sciences technology national state key engineering faculty china usa uk beijing shanghai ' +
  'hong kong new york california medical medicine health hospital academy chinese international').split(' '));

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const nameKey = (s) => fold(s).replace(/[^a-z\s-]/g, ' ').split(/[\s-]+/).filter(Boolean).sort().join(' ');
const tokens = (s) => new Set(fold(s).replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !WEAK.has(w)));

function affKeys(aff) {
  const a = String(aff || '');
  const phrases = Object.entries(CN).filter(([k]) => a.includes(k)).map(([, v]) => v);
  return { phrases, toks: tokens(a) };
}
function instMatch(ours, instNames) {
  const hay = instNames.map(fold);
  if (ours.phrases.some((p) => hay.some((h) => h.includes(p)))) return true;
  const theirs = new Set(); for (const h of hay) for (const t of tokens(h)) theirs.add(t);
  const overlap = [...ours.toks].filter((t) => theirs.has(t));
  return overlap.length >= 2 || (overlap.length === 1 && overlap[0].length >= 6);
}

// 2026 年起 OpenAlex 不带密钥时，同一 IP 每天共享约 0.1 美元免费额度（约 100 次查询），
// 用完要到 UTC 零点（北京时间早 8 点）才重置。注册免费账号拿到密钥后，写进
// /etc/scholaros/keys.env 的 OPENALEX_API_KEY=xxx，就会用自己的额度。
const KEY = process.env.OPENALEX_API_KEY || '';
class BudgetError extends Error {}
async function search(q) {
  const url = 'https://api.openalex.org/authors?per-page=8&search=' + encodeURIComponent(q) +
    (KEY ? '&api_key=' + encodeURIComponent(KEY) : '');
  let last = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'ScholarOS-enrich/1.0' },
                                   signal: AbortSignal.timeout(20000) });
      if (r.status === 429) {
        const body = await r.text().catch(() => '');
        // 当天额度用完：重试没用，直接停
        if (/budget|Insufficient/i.test(body)) throw new BudgetError('当天免费额度已用完');
        last = 'HTTP 429'; await sleep(4000 * (attempt + 1)); continue;
      }
      if (r.status >= 500) { last = 'HTTP ' + r.status; await sleep(4000 * (attempt + 1)); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return (await r.json()).results || [];
    } catch (e) {
      if (e instanceof BudgetError) throw e;
      last = e.name === 'TimeoutError' ? '超时' : (e.cause?.code || e.message);
      await sleep(4000 * (attempt + 1));
    }
  }
  throw new Error(last || '未知错误');
}
const errCount = new Map();

const pick = db.prepare(`SELECT id,name,name_en,affiliation,h_index,academic_facts FROM scholars
  WHERE deleted_at IS NULL ${RECHECK ? '' : "AND (openalex_status IS NULL OR openalex_status='error')"} ORDER BY id LIMIT ?`);
const mark = db.prepare('UPDATE scholars SET openalex_status=?, openalex_checked_at=? WHERE id=?');
const save = db.prepare(`UPDATE scholars SET openalex_status='matched', openalex_checked_at=?, openalex_id=?,
  h_index=COALESCE(h_index, ?), academic_facts=COALESCE(academic_facts, ?), updated_at=? WHERE id=?`);

const rows = DRY
  ? db.prepare('SELECT id,name,name_en,affiliation,h_index,academic_facts FROM scholars WHERE deleted_at IS NULL ORDER BY id').all()
      .filter((_, i) => i % 61 === 0).slice(0, LIMIT)
  : pick.all(LIMIT);
const stat = { matched: 0, ambiguous: 0, no_match: 0, skipped: 0, error: 0, hFilled: 0 };
const t0 = Date.now();
console.log(`开始：本轮处理 ${rows.length} 人`);

for (const [i, s] of rows.entries()) {
  const now = Date.now();
  const latin = /^[\x00-\x7FÀ-ɏ\s.'-]+$/.test(s.name || '') ? s.name : (s.name_en || '');
  if (!latin.trim() || nameKey(latin).split(' ').length < 2) { if (!DRY) mark.run('skipped', now, s.id); stat.skipped++; continue; }
  const ours = affKeys(s.affiliation);
  if (!ours.phrases.length && !ours.toks.size) { if (!DRY) mark.run('skipped', now, s.id); stat.skipped++; continue; }
  try {
    const res = await search(latin);
    const want = nameKey(latin);
    const ourH = s.h_index == null ? null : Number(s.h_index);
    // 严格版（第一版试运行发现误配很多，2026-09-23 改严）：
    //  1. 姓名完全对上
    //  2. 机构只跟 OpenAlex 的「当前单位」比，不跟历史单位比——常见中文名在 OpenAlex 里经常是
    //     几百个同名的人混成一个档案，历史单位有几百个，拿历史单位比几乎总能对上
    //  3. 发表数超过 600 篇的档案不信，大概率是多人混合
    //  4. 库里已有 h 指数的拿来交叉验证，差距超过 max(3, 30%) 不认
    const ok = res.filter((a) => {
      const names = [a.display_name, ...(a.display_name_alternatives || [])].map(nameKey);
      if (!names.includes(want)) return false;
      if ((a.works_count || 0) > 600) return false;
      const cur = (a.last_known_institutions || []).map((x) => x.display_name || '');
      if (!cur.length || !instMatch(ours, cur)) return false;
      const h = a.summary_stats?.h_index;
      if (ourH != null && h != null && Math.abs(h - ourH) > Math.max(3, 0.3 * ourH)) return false;
      return true;
    });
    ok.sort((x, y) => (y.works_count || 0) - (x.works_count || 0));
    const dominant = ok.length === 1 || (ok.length > 1 && (ok[0].works_count || 0) >= 3 * Math.max(1, ok[1].works_count || 0));
    if (DRY) console.log(`  ${(dominant ? '✓匹配' : ok.length ? '?不确定' : '×不填').padEnd(6)} ${latin.slice(0, 20).padEnd(21)}| 库里:${String(s.affiliation || '').slice(0, 26).padEnd(27)} h=${ourH ?? '空'}`.padEnd(70) + `| OA:${ok[0] ? ((ok[0].last_known_institutions || [])[0]?.display_name || '?').slice(0, 26) + ' h=' + ok[0].summary_stats?.h_index + ' 发表' + ok[0].works_count : '-'}`);
    if (!dominant) { if (!DRY) mark.run(ok.length ? 'ambiguous' : 'no_match', now, s.id); ok.length ? stat.ambiguous++ : stat.no_match++; }
    else if (DRY) { stat.matched++; }
    else {
      const a = ok[0], h = a.summary_stats?.h_index ?? null;
      const facts = JSON.stringify({
        source: 'openalex', works: a.works_count, cited: a.cited_by_count, h, i10: a.summary_stats?.i10_index ?? null,
        orcid: a.orcid || null, inst: (a.last_known_institutions || []).map((x) => x.display_name).slice(0, 3),
        topics: (a.topics || []).slice(0, 6).map((x) => x.display_name), checked: new Date(now).toISOString().slice(0, 10),
      });
      if (s.h_index == null && h != null) stat.hFilled++;
      save.run(now, a.id.replace('https://openalex.org/', ''), h, facts, now, s.id);
      stat.matched++;
    }
  } catch (e) {
    if (e instanceof BudgetError) {
      console.log(`OpenAlex 当天免费额度已用完，本轮到此为止（已处理 ${i} 人，未处理的下次继续）。` +
        (KEY ? '' : '注册免费密钥可提高额度，见文件开头说明。'));
      break;
    }
    if (!DRY) mark.run('error', now, s.id); stat.error++;
    errCount.set(e.message, (errCount.get(e.message) || 0) + 1);
    // 连续大量出错通常是网络或被限流，停下来别白跑，下次再续
    if (stat.error >= 30 && stat.error > (stat.matched + stat.no_match + stat.ambiguous)) {
      console.log('出错太多，提前结束本轮（出错的人下次会自动重试）：', JSON.stringify([...errCount]));
      break;
    }
  }
  if ((i + 1) % 100 === 0) console.log(`  进度 ${i + 1}/${rows.length}`, JSON.stringify(stat));
  await sleep(250);   // 每秒最多 4 次，远低于 OpenAlex 的限额
}
if (!DRY) db.prepare(`INSERT INTO migration_meta (key,value) VALUES ('openalex_last_run',?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(Date.now()));
console.log(`${DRY ? '【试运行，未写入】' : ''}完成，用时 ${Math.round((Date.now() - t0) / 1000)} 秒：`, JSON.stringify(stat));
if (errCount.size) console.log('错误原因统计：', JSON.stringify([...errCount]));
console.log('  matched=匹配成功并写入  ambiguous=有多个可能的人，不敢填  no_match=没找到  skipped=只有中文名或没机构，跳过');
