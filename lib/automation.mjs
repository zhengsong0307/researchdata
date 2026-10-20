// 自动化：学者×企业匹配、每日跟进清单、运营看板
import { Router } from 'express';
import { db } from './db.mjs';
import { audit, atLeast } from './auth.mjs';

export const automation = Router();

// ---------- 表结构（首次启动时补上）----------
db.exec(`CREATE TABLE IF NOT EXISTS auto_matches (
  company_id INTEGER NOT NULL, scholar_id INTEGER NOT NULL,
  score REAL NOT NULL, reasons TEXT, computed_at INTEGER NOT NULL,
  PRIMARY KEY (company_id, scholar_id));
CREATE INDEX IF NOT EXISTS idx_auto_matches_company ON auto_matches(company_id, score DESC);`);
const cols = db.prepare('PRAGMA table_info(scholars)').all().map((c) => c.name);
if (!cols.includes('openalex_status')) db.exec('ALTER TABLE scholars ADD COLUMN openalex_status TEXT');
if (!cols.includes('openalex_checked_at')) db.exec('ALTER TABLE scholars ADD COLUMN openalex_checked_at INTEGER');

// ---------- 研究方向标签表 ----------
// 企业和学者各自的文字里命中哪些标签，共同标签越多、越具体，匹配分越高。
// weight：具体方向 2 分；比较宽泛的方向 1 分。
export const TAGS = [
  ['蛋白质/结构生物学', 2, /蛋白|protein|结构预测|折叠|folding|alphafold|\besm\b|binder|抗体|antibod|酶|enzyme/i],
  ['药物发现', 2, /药物|药学|制药|医药|drug|pharma|biotech|生物技术|分子对接|docking|先导化合物|admet|小分子|新药/i],
  ['计算化学', 2, /计算化学|量子化学|\bdft\b|第一性原理|first.?principles|化学信息|cheminformatics/i],
  ['分子动力学/力场', 2, /分子动力学|molecular dynamic|机器学习势|力场|force field|\bmd\b模拟/i],
  ['材料', 2, /材料|material|合金|alloy|晶体|crystal|钙钛矿|perovskite|高分子|polymer|共晶/i],
  ['电池/能源', 2, /电池|batter|电解质|electrolyte|储能|光伏|太阳能|solar|热电|能源材料/i],
  ['半导体/芯片', 2, /半导体|semiconductor|芯片|\bchip|\beda\b|集成电路|存算/i],
  ['量子', 2, /量子|quantum/i],
  ['生物信息/组学', 2, /生物信息|bioinformatic|基因组|genom|单细胞|single.?cell|转录组|组学|omics|测序|sequencing/i],
  ['医疗AI', 2, /医学|医疗|medical|clinical|临床|医学影像|病理|patholog|健康/i],
  ['PDE/科学计算', 2, /偏微分|\bpde\b|数值求解|神经算子|neural operator|科学计算|计算数学|scientific computing/i],
  ['气候/地球科学', 2, /气候|climate|气象|weather|地球系统|遥感|remote sensing|海洋|ocean/i],
  ['机器人/具身', 2, /机器人|robot|具身|embodied/i],
  ['自动化实验', 2, /自动化实验|自驱实验|self.?driving lab|高通量|high.?throughput|湿实验|wet.?lab|闭环实验/i],
  ['图神经网络', 2, /图神经|\bgnn\b|graph neural/i],
  ['生成模型', 1, /生成式|生成模型|扩散模型|diffusion|generative|flow matching/i],
  ['大模型/NLP', 1, /大模型|\bllm|语言模型|language model|\bnlp\b|自然语言|预训练|后训练|pre.?train|post.?train|rlhf|对齐|alignment/i],
  ['智能体/Agent', 1, /智能体|\bagents?\b|agentic/i],
  ['评测/数据', 1, /评测|benchmark|数据集|dataset|数据工程|数据标注|专家数据/i],
  ['数学推理', 2, /数学推理|定理证明|theorem|formal|形式化|ai4math|数论|几何/i],
  ['物理', 1, /物理|physics|凝聚态|粒子/i],
  // 2026-09-23 补：专家数据/评测公司按学科要人（物理/化学/生物/数学），生成视觉和工程仿真公司原来没有对应方向
  ['化学', 2, /化学|chemistry|chemical|化工/i],
  ['生物', 2, /生物|biolog|生命科学|life science|神经科学|neuroscience/i],
  ['数学', 2, /数学|mathemat|\bmath\b|统计|statistic|运筹|逻辑/i],
  ['编程/代码', 1, /编程|代码|coding|\bcode\b|程序合成|software engineering|软件工程/i],
  ['计算机视觉/3D', 2, /计算机视觉|computer vision|视觉|图像|image|视频生成|video|3d|三维|渲染|render|nerf|gaussian splatting|世界模型|world model/i],
  ['工程仿真/CFD', 2, /cfd|计算流体|流体|fluid|仿真|simulation|有限元|finite element|空气动力|aerodynam|航空航天|aerospace/i],
];
export const tagsOf = (text) => {
  const s = String(text || '');
  return TAGS.filter(([, , re]) => re.test(s)).map(([name, w]) => ({ name, w }));
};

const scholarText = (s) => {
  let t = [s.interest, s.fit_line, s.affiliation].filter(Boolean).join(' ');
  try { const f = JSON.parse(s.academic_facts || 'null'); if (f && f.topics) t += ' ' + f.topics.join(' '); } catch {}
  return t;
};
const companyText = (c) => [c.name, c.industry, c.need_detail, c.needs, c.scholar_match, c.fit_line, c.notes]
  .filter(Boolean).join(' ');

// ---------- 学者×企业匹配 ----------
export function recomputeMatches(topN = 15) {
  const scholars = db.prepare(`SELECT id,name,affiliation,interest,fit_line,academic_facts,h_index,email,
    wechat,academic_grade,status FROM scholars WHERE deleted_at IS NULL`).all()
    .map((s) => ({ ...s, tags: tagsOf(scholarText(s)) }))
    .filter((s) => s.tags.length);
  const companies = db.prepare('SELECT * FROM companies WHERE deleted_at IS NULL').all();
  const now = Date.now();
  let pairs = 0;
  db.transaction(() => {
    db.exec('DELETE FROM auto_matches');
    const ins = db.prepare('INSERT INTO auto_matches (company_id,scholar_id,score,reasons,computed_at) VALUES (?,?,?,?,?)');
    for (const c of companies) {
      const ct = tagsOf(companyText(c));
      if (!ct.length) continue;
      const cset = new Map(ct.map((t) => [t.name, t.w]));
      // 企业只有宽泛方向（比如大模型公司只写了"大模型/Agent"）时，允许按宽泛方向匹配，
      // 否则这类公司一个人都匹配不到；有具体方向的企业仍然要求至少一个具体方向重合。
      const onlyGeneric = !ct.some((t) => t.w >= 2);
      const scored = [];
      for (const s of scholars) {
        const shared = s.tags.filter((t) => cset.has(t.name));
        const specific = shared.filter((t) => t.w >= 2);
        if (!specific.length && !(onlyGeneric && shared.length)) continue;   // 只有宽泛标签重合不算，除非企业本身只有宽泛标签
        let score = shared.reduce((a, t) => a + t.w, 0);
        const bonus = [];
        if (s.email || s.wechat) { score += 0.5; bonus.push('有联系方式'); }
        if (Number(s.h_index) >= 15) { score += 0.5; bonus.push('h指数' + s.h_index); }
        if (/博士|博士后/.test(s.academic_grade || '')) { score += 0.3; }
        scored.push({ id: s.id, score, reasons: shared.map((t) => t.name).concat(bonus) });
      }
      scored.sort((a, b) => b.score - a.score || a.id - b.id);
      for (const m of scored.slice(0, topN)) { ins.run(c.id, m.id, m.score, m.reasons.join('、'), now); pairs++; }
    }
  })();
  db.prepare(`INSERT INTO migration_meta (key,value) VALUES ('matches_computed_at',?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(now));
  return { companies: companies.length, pairs, at: now };
}

// ---------- 每日跟进清单（规则与 ScholarOS 的邀请按钮完全一致）----------
// inviteStage：0/空=没邀请，1=已邀请，2=已发提醒1，3=已发提醒2·结束；距上次发送满 7 天就该发下一封
export function followups() {
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);   // 北京时间
  const dayDiff = (d) => Math.round((Date.parse(today) - Date.parse(d)) / 86400e3);
  const rows = db.prepare(`SELECT id,name,affiliation,email,status,invite_stage,last_email_date,notes
    FROM scholars WHERE deleted_at IS NULL AND invite_stage IN (1,2) AND last_email_date IS NOT NULL
    AND COALESCE(status,'') <> '意向合作'`).all();
  const due = [], soon = [];
  for (const r of rows) {
    const d = dayDiff(r.last_email_date);
    const next = r.invite_stage === 1 ? '提醒1' : '提醒2';
    const owner = ((r.notes || '').match(/对接人[:：]\s*([^；;\n]+)/) || [])[1] || '';
    const item = { id: r.id, name: r.name, affiliation: r.affiliation, email: r.email,
                   stage: r.invite_stage, last: r.last_email_date, days: d, next, owner };
    if (d >= 7) due.push(item); else if (d >= 5) soon.push(item);
  }
  due.sort((a, b) => b.days - a.days);
  soon.sort((a, b) => b.days - a.days);
  return { today, due, soon };
}

// ---------- 接口 ----------
automation.get('/board', (req, res) => {
  const one = (sql) => db.prepare(sql).get();
  const top = db.prepare(`SELECT c.id,c.name,c.pool,c.industry,c.status,COUNT(m.scholar_id) AS n,MAX(m.score) AS best
    FROM companies c JOIN auto_matches m ON m.company_id=c.id WHERE c.deleted_at IS NULL
    GROUP BY c.id ORDER BY best DESC, n DESC`).all();
  res.json({
    followups: followups(),
    matches: { computedAt: Number(one("SELECT value v FROM migration_meta WHERE key='matches_computed_at'")?.v || 0),
               companies: top },
    oldsys: {
      checkedAt: Number(one("SELECT value v FROM migration_meta WHERE key='oldsys_checked_at'")?.v || 0),
      result: JSON.parse(one("SELECT value v FROM migration_meta WHERE key='oldsys_last_result'")?.v || '[]'),
      changedAt: Math.max(0, ...['scholaros', 'social'].map((k) =>
        Number(one(`SELECT value v FROM migration_meta WHERE key='oldsys_changed_${k}'`)?.v || 0))),
    },
    enrich: {
      total: one('SELECT COUNT(*) c FROM scholars WHERE deleted_at IS NULL').c,
      checked: one("SELECT COUNT(*) c FROM scholars WHERE deleted_at IS NULL AND openalex_status IS NOT NULL").c,
      matched: one("SELECT COUNT(*) c FROM scholars WHERE deleted_at IS NULL AND openalex_status='matched'").c,
      hMissing: one('SELECT COUNT(*) c FROM scholars WHERE deleted_at IS NULL AND h_index IS NULL').c,
      lastRun: Number(one("SELECT value v FROM migration_meta WHERE key='openalex_last_run'")?.v || 0),
    },
  });
});

automation.get('/matches/company/:id', (req, res) => {
  const c = db.prepare('SELECT id,name,pool,industry,need_detail,needs,scholar_match FROM companies WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: '找不到这家企业' });
  const showContact = atLeast(req.user, 'member');
  const items = db.prepare(`SELECT m.score,m.reasons,s.id,s.name,s.affiliation,s.interest,s.h_index,
      s.academic_grade,s.status,s.email,s.wechat
    FROM auto_matches m JOIN scholars s ON s.id=m.scholar_id WHERE m.company_id=? ORDER BY m.score DESC`).all(c.id)
    .map((r) => showContact ? r : { ...r, email: null, wechat: null });
  res.json({ company: { ...c, tags: tagsOf(companyText(c)).map((t) => t.name) }, items });
});

automation.post('/matches/recompute', (req, res) => {
  if (!atLeast(req.user, 'member')) return res.status(403).json({ error: '权限不足' });
  const r = recomputeMatches();
  audit(req.user, 'recompute_matches', null, r, req.ip);
  res.json({ ok: true, ...r });
});
