// 简历解析：服务器端提取文字
// PDF 有文字层 → pdftotext（毫秒级）
// PDF 无文字层（扫描件）→ pdftoppm 转图片 → tesseract OCR
// 图片 → tesseract OCR
// Word(docx) → mammoth
import { Router } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, readFileSync, rmSync, mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { audit } from './auth.mjs';
import { db, RESUME_DIR } from './db.mjs';
import { createHash, randomBytes } from 'node:crypto';

const run = promisify(execFile);
export const parse = Router();

const MAX_BYTES = 20 * 1024 * 1024;
const OCR_LANG = 'chi_sim+eng';

function sniff(buf, filename = '') {
  const h4 = buf.subarray(0, 4).toString('latin1');
  if (h4.startsWith('%PDF')) return 'pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image';
  if (buf[0] === 0x89 && h4.slice(1, 4) === 'PNG') return 'image';
  if (h4.startsWith('PK')) return 'docx';
  if (/\.(jpe?g|png|webp|bmp|tiff?)$/i.test(filename)) return 'image';
  if (/\.docx$/i.test(filename)) return 'docx';
  if (/\.pdf$/i.test(filename)) return 'pdf';
  return 'unknown';
}

async function ocrImage(file) {
  const { stdout } = await run('tesseract', [file, 'stdout', '-l', OCR_LANG, '--psm', '3'],
    { maxBuffer: 20 * 1024 * 1024, timeout: 120000 });
  return stdout;
}

async function extract(buf, filename) {
  const kind = sniff(buf, filename);
  const dir = mkdtempSync(path.join(tmpdir(), 'sosparse-'));
  try {
    const f = path.join(dir, 'input');
    writeFileSync(f, buf);

    if (kind === 'pdf') {
      // 先试文字层
      let text = '';
      try {
        const { stdout } = await run('pdftotext', ['-layout', f, '-'],
          { maxBuffer: 20 * 1024 * 1024, timeout: 60000 });
        text = stdout;
      } catch { /* 损坏的 PDF 也走 OCR */ }

      if (text.replace(/\s/g, '').length >= 40) {
        return { kind: 'pdf', method: '文字层提取', text };
      }
      // 没有文字层 → 扫描件，转图片 OCR（最多前 5 页，控制耗时）
      try {
        await run('pdftoppm', ['-r', '150', '-png', '-f', '1', '-l', '5', f, path.join(dir, 'pg')],
          { timeout: 120000 });
      } catch {
        return { kind: 'pdf', method: '', text: '',
                 error: '这个 PDF 打不开（文件可能损坏或不是真正的 PDF），请换一份' };
      }
      const pages = readdirSync(dir).filter((n) => n.startsWith('pg')).sort();
      if (!pages.length) {
        return { kind: 'pdf', method: '', text: '',
                 error: 'PDF 里没有可识别的内容（既没有文字层也转不出图片）' };
      }
      let out = '';
      for (const p of pages) out += await ocrImage(path.join(dir, p)) + '\n';
      return { kind: 'pdf', method: `扫描件 OCR（${pages.length} 页）`, text: out };
    }

    if (kind === 'image') {
      return { kind: 'image', method: '图片 OCR', text: await ocrImage(f) };
    }

    if (kind === 'docx') {
      const mammoth = await import('mammoth');
      const r = await mammoth.extractRawText({ buffer: buf });
      return { kind: 'docx', method: 'Word 解析', text: r.value || '' };
    }

    return { kind: 'unknown', method: '', text: '', error: '不支持的文件类型' };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// ============ 规则版字段抽取（不调用外部 AI）============
// 用 19 份真实简历测过：姓名/邮箱/电话接近全对；机构、学历七八成；
// 毕业时间、研究方向靠不住——这几项返回在 unsure 里，页面标黄提醒人工核对。
const SURN = '王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤俞花';
const CURRENT = /至今|现在|Present|present|expected|Expected|在读|预计/;
const DEGREE_WORD = /博士|硕士|本科|学士|研究生|Ph\.?\s?D|Master|Bachelor|Postdoc|postdoc/;
const SCHOOL = /[一-龥]{2,14}(?:大学|科学院|研究院|研究所)|(?:[A-Z][a-z]+\s)*(?:University|Institute)(?:\s(?:of\s)?[A-Z][a-zA-Z]+)*|KAIST|MBZUAI/;

function guessFields(text, filename = '') {
  const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const unsure = [];
  let m;

  // 姓名：「姓名：」标签 → 开头单独一行的中文名 → 开头的英文名 → 文件名
  let name = '';
  if ((m = text.match(/姓\s*名[:：\s]*([一-龥]{2,4})/))) name = m[1];
  if (!name && (m = (lines[0] || '').match(/^([\u4e00-\u9fa5]{2,3})[，,、\s|｜:：(（]/)) && SURN.includes(m[1][0])) name = m[1];
  if (!name) for (const l of lines.slice(0, 12)) {
    const c = l.replace(/\s+/g, '');
    if (/^[一-龥]{2,4}$/.test(c) && SURN.includes(c[0])) { name = c; break; }
  }
  if (!name) for (const l of lines.slice(0, 6)) {
    const mm = l.match(/^([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){1,2})\s*$/);
    if (mm && !/University|Institute|Curriculum|Resume|Personal/.test(mm[1])) { name = mm[1]; break; }
  }
  if (!name && (m = filename.match(/([一-龥]{2,3})(?:的?简历|[-_])/)) && SURN.includes(m[1][0])) name = m[1];
  if (!name) unsure.push('name');

  // 邮箱：顺手修 OCR 常见的「gmailcom」少点问题
  let email = (text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/) || [''])[0].toLowerCase();
  if (!email && (m = text.match(/([\w.+-]+@(?:gmail|163|126|qq|outlook|hotmail|foxmail|sina|yahoo|icloud))(com|cn)\b/i))) {
    email = (m[1] + '.' + m[2]).toLowerCase(); unsure.push('email');
  }
  if (!email) unsure.push('email');

  const phone = ((text.match(/(?:\+?86[-\s]?)?1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}/) || [''])[0]).replace(/\D/g, '').slice(-11);

  // 学校：排除「国家级大学生创新项目」这类误抓；KAIST/MBZUAI 这种缩写优先
  const schoolOf = (str) => {
    const abbr = str.match(/\b(KAIST|MBZUAI)\b/); if (abbr) return abbr[1];
    const re = new RegExp(SCHOOL.source, 'g'); let mm;
    while ((mm = re.exec(str))) {
      const after = str[mm.index + mm[0].length] || '';
      if (after === '生' || /^(国家级|省级|全国|第)/.test(mm[0])) continue;
      return mm[0];
    }
    return '';
  };
  const degreeOf = (str) =>
    /博士后|Postdoc|postdoc/.test(str) ? '博士后'
    : /博士|Ph\.?\s?D|硕博连读/.test(str) ? '博士在读'
    : /硕士|Master|研究生/.test(str) ? '硕士在读'
    : /本科|Bachelor|学士/.test(str) ? '本科在读'
    : /工程师|研究员|有限公司|公司|Inc\.|Ltd/.test(str) ? '产业界' : '';
  // 日期区间，兼容「2021 年 09 月—2026 年 6 月」这类带空格和年月字的写法
  const RANGE = /20\d{2}[^—–\-~至\d]{0,6}\d{0,2}[^—–\-~至\d]{0,4}[—–\-~至]+\s*(20\d{2})(?:[^\d]{0,4}(\d{1,2}))?/;

  // 当前在读/在职：先看带「至今/在读/预计」的那一行本身，不行再看上下两行
  let degree = '', affiliation = '', grad = '';
  for (let i = 0; i < lines.length; i++) {
    if (!CURRENT.test(lines[i])) continue;
    const ctx = lines.slice(Math.max(0, i - 2), i + 3).join(' ');
    if (!degree) degree = degreeOf(lines[i]) || degreeOf(ctx);
    if (!affiliation) affiliation = schoolOf(lines[i]) || schoolOf(ctx);
    if (degree && affiliation) break;
  }
  // 没写「至今」的：找带学位词、结束年份在今年及以后的那行（说明还没毕业）
  if (!degree || !grad) for (const l of lines) {
    if (!DEGREE_WORD.test(l)) continue;
    const r = l.match(RANGE);
    if (!r || Number(r[1]) < 2026) continue;
    if (!degree) degree = degreeOf(l);
    if (!affiliation) affiliation = schoolOf(l);
    if (!grad) grad = r[1] + (r[2] ? '.' + r[2].padStart(2, '0') : '');
    break;
  }
  if (!affiliation) affiliation = schoolOf(text);

  // 毕业：明确写了「预计 / expected / 20xx 届」的优先
  if ((m = text.match(/(?:预计|expected|Expected)\D{0,8}(20\d{2}(?:[./]\d{1,2})?)/)) ||
      (m = text.match(/(20\d{2}(?:[./]\d{1,2})?)\D{0,6}(?:预计|\(?[Ee]xpected)/)) ||
      (m = text.match(/(20\d{2})\s*届/))) grad = m[1];
  if (degree === '产业界' || degree === '博士后') grad = '';

  // 研究方向：找「研究方向 / Research Interests」这类标签后面的内容
  let interest = '';
  const lab = /(研究方向|研究兴趣|研究领域|研究内容|求职方向|求职意向|Research\s+(?:Interests?|Area|Focus))\s*[:：|｜]?\s*(.*)/i;
  for (let i = 0; i < lines.length; i++) {
    if (!(m = lines[i].match(lab))) continue;
    interest = (m[2] && m[2].length >= 4 ? m[2] : (lines[i + 1] || '')).slice(0, 120);
    if (interest) break;
  }

  for (const k of ['affiliation', 'degree', 'grad', 'interest']) unsure.push(k);
  return { name, email, phone, affiliation, degree, grad, interest, unsure: [...new Set(unsure)] };
}

// 查重：邮箱相同 → 同一人；姓名相同且机构有重叠 → 同一人；只有姓名相同 → 提示可能重名
const norm = (v) => String(v || '').trim().toLowerCase();
function findExisting(f) {
  const rows = db.prepare('SELECT id,name,affiliation,email FROM scholars WHERE deleted_at IS NULL').all();
  if (f.email) {
    const hit = rows.find((r) => norm(r.email) === norm(f.email));
    if (hit) return { match: hit, sameName: [] };
  }
  if (!f.name) return { match: null, sameName: [] };
  const same = rows.filter((r) => norm(r.name) === norm(f.name));
  const key = norm(f.affiliation).slice(0, 4);
  const hit = key ? same.find((r) => norm(r.affiliation).includes(key)) : null;
  return { match: hit || null, sameName: hit ? [] : same.slice(0, 3) };
}

// POST /api/parse-resumes  { files:[{filename, base64}] }
parse.post('/parse-resumes', async (req, res) => {
  const files = Array.isArray(req.body?.files) ? req.body.files : [];
  if (!files.length) return res.status(400).json({ error: '没有收到文件' });
  if (files.length > 40) return res.status(400).json({ error: '一次最多 40 份' });

  const results = [];
  for (const f of files) {
    const name = String(f?.filename || '未命名');
    try {
      const buf = Buffer.from(String(f?.base64 || ''), 'base64');
      if (!buf.length) { results.push({ filename: name, error: '文件为空' }); continue; }
      if (buf.length > MAX_BYTES) { results.push({ filename: name, error: '文件超过 20MB' }); continue; }
      const t0 = Date.now();
      const r = await extract(buf, name);
      results.push({
        filename: name, kind: r.kind, method: r.method,
        ms: Date.now() - t0, size: buf.length,
        text: (r.text || '').slice(0, 60000),
        chars: (r.text || '').replace(/\s/g, '').length,
        fields: (() => { const g = guessFields(r.text || '', name); const e = findExisting(g);
          return { ...g, existing: e.match, sameName: e.sameName }; })(),
        error: r.error || null,
      });
    } catch (e) {
      results.push({ filename: name, error: String(e?.message || e) });
    }
  }
  audit(req.user, 'parse_resumes', null,
    { count: files.length, ok: results.filter((r) => !r.error).length }, req.ip);
  res.json({ results });
});

// 能力自检
parse.get('/parse-capabilities', async (_req, res) => {
  const probe = async (cmd, args) => {
    try { const { stdout, stderr } = await run(cmd, args); return (stdout || stderr).split('\n')[0]; }
    catch { return null; }
  };
  res.json({
    pdftotext: await probe('pdftotext', ['-v']),
    tesseract: await probe('tesseract', ['--version']),
    langs: (await probe('tesseract', ['--list-langs']).catch(() => '')) !== null
      ? (await run('tesseract', ['--list-langs']).then((r) => (r.stdout + r.stderr).split('\n').slice(1).filter(Boolean)).catch(() => []))
      : [],
    docx: true,
  });
});

// POST /api/import-resume  确认后写入一个人（新建，或补充到已有记录）
// { filename, base64, contentType, fields:{name,email,phone,affiliation,degree,grad,interest,notes},
//   channel, owner, mergeIntoId }
parse.post('/import-resume', (req, res) => {
  const b = req.body || {};
  const f = b.fields || {};
  const str = (v) => (v === null || v === undefined) ? null : (String(v).trim() || null);
  if (!str(f.name)) return res.status(400).json({ error: '姓名不能为空' });
  const buf = b.base64 ? Buffer.from(String(b.base64), 'base64') : null;
  if (buf && buf.length > 20 * 1024 * 1024) return res.status(400).json({ error: '文件超过 20MB' });

  const now = Date.now();
  const today = new Date(now + 8 * 3600e3).toISOString().slice(0, 10);   // 北京时间日期
  const degree = str(f.degree), grad = str(f.grad);
  const source = '简历批量导入' + (degree ? '·' + degree + (grad ? '·' + grad : '') : '');
  const ownerNote = str(b.owner) ? `对接人:${str(b.owner)}；` : '';
  const logNote = `（${today} 上传简历自动解析入库${b.filename ? '，文件 ' + b.filename : ''}）`;

  let scholarId, merged = false;
  db.transaction(() => {
    const target = b.mergeIntoId
      ? db.prepare('SELECT * FROM scholars WHERE id=? AND deleted_at IS NULL').get(b.mergeIntoId)
      : null;
    if (target) {
      // 合并：只补空字段，不覆盖已有内容；备注追加
      const fill = { email: str(f.email), wechat: str(f.phone), affiliation: str(f.affiliation),
                     interest: str(f.interest), academic_grade: degree, homepage: str(f.homepage) };
      const sets = [], vals = [];
      for (const [col, v] of Object.entries(fill)) {
        if (v && !str(target[col])) { sets.push(`${col}=?`); vals.push(v); }
      }
      const extra = [ownerNote, grad ? `预计毕业:${grad}；` : '', str(f.notes), logNote].filter(Boolean).join('');
      sets.push('notes=?'); vals.push((target.notes ? target.notes + '\n' : '') + extra);
      sets.push('updated_at=?'); vals.push(now);
      db.prepare(`UPDATE scholars SET ${sets.join(',')} WHERE id=?`).run(...vals, target.id);
      scholarId = target.id; merged = true;
    } else {
      const r = db.prepare(`INSERT INTO scholars
        (name,email,affiliation,interest,wechat,homepage,status,source,source_type,channel,academic_grade,
         notes,discovered_date,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'未联系',?,'简历投递',?,?,?,?,?,?)`).run(
        str(f.name), str(f.email), str(f.affiliation), str(f.interest), str(f.phone), str(f.homepage),
        source, str(b.channel) || '小红书', degree,
        [ownerNote, str(f.notes), logNote].filter(Boolean).join(''), today, now, now);
      scholarId = r.lastInsertRowid;
    }

    if (buf && buf.length) {
      const key = 'resume_' + now + '_' + randomBytes(4).toString('hex');
      writeFileSync(path.join(RESUME_DIR, key), buf);
      db.prepare('UPDATE resumes SET is_primary=0 WHERE scholar_id=?').run(scholarId);
      db.prepare(`INSERT INTO resumes (scholar_id,kind,blob_key,filename,file_size,mime_type,md5,is_primary,uploaded_at,note)
                  VALUES (?,'file',?,?,?,?,?,1,?,?)`).run(
        scholarId, key, str(b.filename), buf.length, str(b.contentType) || 'application/octet-stream',
        createHash('md5').update(buf).digest('hex'), now, `${today} 上传入库`);
    }
    // 从网页链接来的：挂一条网址型简历，点简历图标会直接打开这个网页
    if (!buf && str(b.resumeUrl)) {
      const has = db.prepare("SELECT 1 FROM resumes WHERE scholar_id=? AND kind='url' AND url=?").get(scholarId, str(b.resumeUrl));
      if (!has) {
        db.prepare('UPDATE resumes SET is_primary=0 WHERE scholar_id=?').run(scholarId);
        db.prepare(`INSERT INTO resumes (scholar_id,kind,url,is_primary,uploaded_at,note) VALUES (?,'url',?,1,?,?)`)
          .run(scholarId, str(b.resumeUrl), now, `${today} 从网页链接入库`);
      }
    }
  })();

  audit(req.user, merged ? 'resume_merge' : 'resume_import', `scholars:${scholarId}`,
        { name: f.name, file: b.filename }, req.ip);
  res.json({ ok: true, scholarId, merged, name: f.name });
});

// POST /api/parse-text  { text }  贴一段文字（比如微信消息）直接解析成字段
parse.post('/parse-text', (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: '没有收到文字' });
  if (text.length > 20000) return res.status(400).json({ error: '文字太长（超过 2 万字）' });
  const g = guessFields(text, '');
  const e = findExisting(g);
  res.json({ fields: { ...g, existing: e.match, sameName: e.sameName } });
});

// ============ 网页链接解析：服务器去抓个人主页 ============
// 安全：只允许访问公网地址，防止有人填内网地址借服务器去访问内部服务。
// 域名解析和真正连接用同一个 IP（在连接时校验），避免"先解析成公网、连接时换成内网"的绕过。
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224 || ip === '47.237.201.14';
  }
  const x = ip.toLowerCase();
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') ||
    (x.startsWith('::ffff:') && isPrivateIp(x.slice(7)));
}
function safeLookup(hostname, opts, cb) {
  dns.lookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) return cb(new Error('不允许访问内网地址'));
    if (opts && opts.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}
function fetchPublic(url, hops = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('网址格式不对')); }
    if (!/^https?:$/.test(u.protocol)) return reject(new Error('只支持 http / https 网址'));
    if (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && isPrivateIp(u.hostname.replace(/^\[|\]$/g, '')))
      return reject(new Error('不允许访问内网地址'));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { lookup: safeLookup, timeout: 15000,
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) ScholarOS-fetch/1.0', accept: 'text/html,application/pdf,*/*' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (hops >= 4) return reject(new Error('跳转次数太多'));
        return resolve(fetchPublic(new URL(res.headers.location, u).toString(), hops + 1));
      }
      if (res.statusCode >= 400) { res.resume(); return reject(new Error('对方网站返回 ' + res.statusCode)); }
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size > 6 * 1024 * 1024) { req.destroy(); reject(new Error('网页太大')); } else chunks.push(c); });
      res.on('end', () => resolve({ buf: Buffer.concat(chunks), type: String(res.headers['content-type'] || ''), finalUrl: u.toString() }));
    });
    req.on('timeout', () => req.destroy(new Error('对方网站响应超时')));
    req.on('error', reject);
  });
}
function htmlToText(buf, type) {
  let cs = (type.match(/charset=([\w-]+)/i) || [])[1];
  const head = buf.subarray(0, 3000).toString('latin1');
  if (!cs) cs = (head.match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
  let html;
  try { html = new TextDecoder(cs || 'utf-8').decode(buf); } catch { html = buf.toString('utf-8'); }
  const title = ((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
  const text = html
    .replace(/<(script|style|noscript|svg|nav|footer)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|section|article|td)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
  return { title, text };
}

// POST /api/parse-url  { url }
parse.post('/parse-url', async (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!url) return res.status(400).json({ error: '没有收到网址' });
  try {
    const r = await fetchPublic(/^https?:\/\//i.test(url) ? url : 'https://' + url);
    let text = '', title = '';
    if (/pdf/i.test(r.type) || r.buf.subarray(0, 4).toString('latin1') === '%PDF') {
      text = (await extract(r.buf, 'page.pdf')).text || '';
    } else {
      ({ title, text } = htmlToText(r.buf, r.type));
    }
    if (text.replace(/\s/g, '').length < 60) {
      return res.status(422).json({ error: '网页上几乎没有文字，可能需要登录，或者是用脚本动态加载的页面（比如领英、谷歌学术），这类请改用"贴文字"' });
    }
    // 网页标题里通常有姓名（如「Paul Pu Liang - MIT」），放到最前面帮姓名规则识别
    const titleName = title.split(/[-|–—·:：,，(（]/)[0].trim();
    const g = guessFields([titleName, text].filter(Boolean).join('\n'), '');
    const e = findExisting(g);
    audit(req.user, 'parse_url', r.finalUrl, { chars: text.length }, req.ip);
    res.json({ url: r.finalUrl, title, chars: text.length,
               fields: { ...g, homepage: r.finalUrl, existing: e.match, sameName: e.sameName } });
  } catch (err) {
    res.status(400).json({ error: '抓取失败：' + (err.message || String(err)) });
  }
});
