// ScholarOS 数据导入脚本
// 原则：全程在一个事务里跑，任何一步出错就整体回滚，不会留下半截数据
import Database from 'better-sqlite3';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import path from 'node:path';

const DB = '/var/lib/scholaros/scholaros.db';
const PKG = '/opt/scholaros/上传包';
const RESUME_DIR = '/var/lib/scholaros/resumes';

const db = new Database(DB);
db.pragma('foreign_keys = ON');

const j = (p) => JSON.parse(gunzipSync(readFileSync(p)).toString('utf-8'));
const main = j(path.join(PKG, 'main.json.gz'));

// —— 工具函数 ——
const s = (v) => (v === null || v === undefined) ? null : String(v).trim() || null;
const num = (v) => {                       // h指数等：文本和数字混杂，统一转数字
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const jsonOrNull = (v) => (v === null || v === undefined) ? null : JSON.stringify(v);

const report = [];
const log = (k, v) => { report.push([k, v]); console.log(`  ${k.padEnd(34)} ${v}`); };

const tx = db.transaction(() => {
  // ===== 1. 学者 =====
  const insS = db.prepare(`INSERT INTO scholars
    (name,name_en,email,affiliation,country,interest,homepage,h_index,openalex_id,
     wechat,wechat_id,contact_form,status,source,source_type,channel,fit_line,collab_form,
     pool_override,academic_grade,academic_score,academic_facts,grade_note,prio,
     invite_stage,last_email_date,notes,created_at,updated_at,deleted_at)
    VALUES (@name,@name_en,@email,@affiliation,@country,@interest,@homepage,@h_index,@openalex_id,
     @wechat,@wechat_id,@contact_form,@status,@source,@source_type,@channel,@fit_line,@collab_form,
     @pool_override,@academic_grade,@academic_score,@academic_facts,@grade_note,@prio,
     @invite_stage,@last_email_date,@notes,@created_at,@updated_at,@deleted_at)`);

  const now = Date.now();
  const mapS = (c, deletedAt = null) => ({
    name: s(c.name), name_en: s(c.nameEn), email: s(c.email),
    affiliation: s(c.affiliation), country: s(c.country), interest: s(c.interest),
    homepage: s(c.homepage), h_index: num(c.hIndex), openalex_id: s(c.openalexId),
    wechat: s(c.wechat), wechat_id: s(c.wechatId), contact_form: s(c.contactForm),
    status: s(c.status) || '未联系', source: s(c.source), source_type: s(c.sourceType),
    channel: s(c.channel), fit_line: s(c.fitLine), collab_form: s(c.collabForm),
    pool_override: s(c.poolOverride), academic_grade: s(c.academicGrade),
    academic_score: num(c.academicScore), academic_facts: jsonOrNull(c.academicFacts),
    grade_note: s(c.gradeNote), prio: s(c.prio),
    invite_stage: num(c.inviteStage), last_email_date: s(c.lastEmailSentDate),
    notes: s(c.notes), created_at: now, updated_at: now, deleted_at: deletedAt
  });

  // 记下 resumeId -> scholar_id 的对应，后面挂简历用
  const resumeLink = new Map();
  let n = 0;
  for (const c of main.candidates) {
    const r = insS.run(mapS(c));
    if (c.resumeId) resumeLink.set(c.resumeId, { id: r.lastInsertRowid, filename: c.resumeFilename });
    n++;
  }
  log('学者 scholars', n);

  let nt = 0;
  for (const c of main.trashedCandidates) { insS.run(mapS(c, now)); nt++; }
  log('学者（回收站，软删除）', nt);

  // ===== 2. 企业（两池合表） =====
  const insC = db.prepare(`INSERT INTO companies
    (pool,ext_id,name,country,industry,funding_stage,homepage,status,source,notes,
     contact_name,contact_title,contact_info,contact_label,need_type,need_detail,budget,timeline,
     fit_line,collab_form,prio,scholar_match,discovered_date,eval_focus,eval_analysis_html,
     cross_matches,alt_contacts,needs,contact,email,researched,match_label,match_count,
     match_updated_at,created_at,updated_at,deleted_at)
    VALUES (@pool,@ext_id,@name,@country,@industry,@funding_stage,@homepage,@status,@source,@notes,
     @contact_name,@contact_title,@contact_info,@contact_label,@need_type,@need_detail,@budget,@timeline,
     @fit_line,@collab_form,@prio,@scholar_match,@discovered_date,@eval_focus,@eval_analysis_html,
     @cross_matches,@alt_contacts,@needs,@contact,@email,@researched,@match_label,@match_count,
     @match_updated_at,@created_at,@updated_at,@deleted_at)`);

  const blankC = {
    ext_id:null,country:null,industry:null,funding_stage:null,homepage:null,status:null,
    source:null,notes:null,contact_name:null,contact_title:null,contact_info:null,
    contact_label:null,need_type:null,need_detail:null,budget:null,timeline:null,
    fit_line:null,collab_form:null,prio:null,scholar_match:null,discovered_date:null,
    eval_focus:null,eval_analysis_html:null,cross_matches:null,alt_contacts:null,
    needs:null,contact:null,email:null,researched:null,match_label:null,match_count:null,
    match_updated_at:null,created_at:now,updated_at:now,deleted_at:null
  };

  let n1 = 0;
  for (const c of main.companies_scholaros) {
    insC.run({ ...blankC, pool:'scholaros', name:s(c.name), country:s(c.country),
      industry:s(c.industry), funding_stage:s(c.fundingStage), homepage:s(c.homepage),
      status:s(c.status), source:s(c.source), notes:s(c.notes),
      contact_name:s(c.contactName), contact_title:s(c.contactTitle), contact_info:s(c.contactInfo),
      contact_label:s(c.contactLabel), need_type:s(c.needType), need_detail:s(c.needDetail),
      budget:s(c.budget), timeline:s(c.timeline), fit_line:s(c.fitLine),
      collab_form:s(c.collabForm), prio:s(c.prio), scholar_match:s(c.scholarMatch),
      discovered_date:s(c.discoveredDate), eval_focus:s(c.evalFocus),
      eval_analysis_html:s(c.evalAnalysisHtml),
      cross_matches:jsonOrNull(c.crossMatches), alt_contacts:jsonOrNull(c.altContacts) });
    n1++;
  }
  log('企业 · ScholarOS 池', n1);

  let n2 = 0;
  for (const c of main.companies_social) {
    insC.run({ ...blankC, pool:'social', ext_id:s(c.id), name:s(c.name),
      country:s(c.country), industry:s(c.industry), funding_stage:s(c.fundingStage),
      homepage:s(c.homepage), status:s(c.status), notes:s(c.notes),
      needs:s(c.needs), contact:s(c.contact), email:s(c.email),
      researched: c.researched ? 1 : 0, match_label:s(c.scholarMatchLabel),
      match_count:num(c.scholarMatchCount), match_updated_at:num(c.scholarMatchUpdatedAt),
      created_at:num(c.createdAt) || now,
      deleted_at: c.archived ? now : null });
    n2++;
  }
  log('企业 · 社媒池', n2);

  // ===== 3. 合作线索 =====
  const insL = db.prepare(`INSERT INTO org_leads
    (ext_id,org,project,amount,stage,contact,ideas,notes,status,created_at,updated_at,deleted_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  let n3 = 0;
  for (const l of main.orgLeads) {
    insL.run(s(l.id), s(l.org), s(l.project), s(l.amount), s(l.stage), s(l.contact),
      s(l.ideas), s(l.notes), s(l.status), num(l.createdAt) || now, now,
      l.archived ? now : null);
    n3++;
  }
  log('合作线索 org_leads', n3);

  // ===== 4. 已验证匹配 =====
  const insM = db.prepare(`INSERT INTO verified_matches
    (ext_id,tag,descr,company_page_ref,points,follow_up_status,verified_at,verified_note)
    VALUES (?,?,?,?,?,?,?,?)`);
  const insMS = db.prepare(`INSERT INTO match_scholars
    (match_id,scholar_id,name_snapshot,affiliation_snapshot) VALUES (?,?,?,?)`);
  const insMC = db.prepare(`INSERT INTO match_companies
    (match_id,company_id,name_snapshot) VALUES (?,?,?)`);
  const findS = db.prepare('SELECT id FROM scholars WHERE name = ? LIMIT 1');
  const findC = db.prepare('SELECT id FROM companies WHERE name = ? LIMIT 1');

  let n4 = 0, linkedS = 0, unlinkedS = 0, linkedC = 0, unlinkedC = 0;
  for (const m of main.verifiedMatches) {
    const r = insM.run(s(m.id), s(m.tag), s(m.desc), s(m.companyPageRef),
      jsonOrNull(m.points), s(m.followUpStatus), num(m.verifiedAt), s(m.verifiedNote));
    for (const sc of (m.scholars || [])) {
      const hit = findS.get(s(sc.name) || '');
      insMS.run(r.lastInsertRowid, hit ? hit.id : null, s(sc.name), s(sc.affiliation));
      hit ? linkedS++ : unlinkedS++;
    }
    for (const co of (m.companies || [])) {
      const hit = findC.get(s(co.name) || '');
      insMC.run(r.lastInsertRowid, hit ? hit.id : null, s(co.name));
      hit ? linkedC++ : unlinkedC++;
    }
    n4++;
  }
  log('已验证匹配 verified_matches', n4);
  log('  └ 学者关联成功 / 仅存姓名', `${linkedS} / ${unlinkedS}`);
  log('  └ 企业关联成功 / 仅存名称', `${linkedC} / ${unlinkedC}`);

  // ===== 5. 简报、月度笔记 =====
  const insB = db.prepare(`INSERT INTO briefings (ext_id,date,title,content_html,data_json,created_at)
    VALUES (?,?,?,?,?,?)`);
  let n5 = 0;
  for (const b of main.briefings) {
    insB.run(s(b.id), s(b.date), s(b.title), s(b.contentHtml), jsonOrNull(b.dataJson), num(b.createdAt));
    n5++;
  }
  log('简报 briefings', n5);

  const insN = db.prepare('INSERT INTO month_notes (month,note) VALUES (?,?)');
  let n6 = 0;
  for (const [k, v] of Object.entries(main.monthNotes || {})) { insN.run(k, v ?? ''); n6++; }
  log('月度笔记 month_notes', n6);

  // ===== 6. 简历（文件） =====
  const insR = db.prepare(`INSERT INTO resumes
    (scholar_id,kind,blob_key,filename,url,file_size,mime_type,md5,is_primary,uploaded_at,note)
    VALUES (@scholar_id,@kind,@blob_key,@filename,@url,@file_size,@mime_type,@md5,@is_primary,@uploaded_at,@note)`);

  const sniff = (buf) => {
    const h = buf.subarray(0, 4).toString('latin1');
    if (h.startsWith('%PDF')) return 'application/pdf';
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
    if (h.startsWith('PK')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    return 'application/octet-stream';
  };

  let nR = 0, nOrphan = 0;
  if (existsSync(RESUME_DIR)) {
    for (const f of readdirSync(RESUME_DIR)) {
      const p = path.join(RESUME_DIR, f);
      if (!statSync(p).isFile()) continue;
      const buf = readFileSync(p);
      const link = resumeLink.get(f);
      const tsMatch = f.match(/^resume_(\d+)_/);
      insR.run({
        scholar_id: link ? link.id : null,
        kind: 'file', blob_key: f,
        filename: link ? (link.filename || null) : null,
        url: null, file_size: buf.length, mime_type: sniff(buf),
        md5: createHash('md5').update(buf).digest('hex'),
        is_primary: link ? 1 : 0,
        uploaded_at: tsMatch ? Number(tsMatch[1]) : null,
        note: link ? null : '孤儿文件：导入时无对应学者'
      });
      link ? nR++ : nOrphan++;
    }
  }
  log('简历 · 已关联学者', nR);
  log('简历 · 孤儿文件', nOrphan);

  // ===== 7. 学者参考库 scholar_pool =====
  const insP = db.prepare(`INSERT INTO scholar_pool
    (id,name,affiliation,country,h_index,email,author_count,top_title,top_year,
     top_citations,top_journal,keywords,link,tier)
    VALUES (@id,@name,@affiliation,@country,@h_index,@email,@author_count,@top_title,@top_year,
     @top_citations,@top_journal,@keywords,@link,@tier)`);
  const lines = gunzipSync(readFileSync(path.join(PKG, 'scholar_pool.ndjson.gz')))
    .toString('utf-8').split('\n');
  let nP = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    insP.run({ ...r, h_index: num(r.h_index), author_count: num(r.author_count),
      top_year: num(r.top_year), top_citations: num(r.top_citations) });
    nP++;
  }
  log('学者参考库 scholar_pool', nP);

  // ===== 8. 建全文检索索引 =====
  db.exec(`INSERT INTO scholars_fts(rowid,name,name_en,affiliation,interest,notes)
           SELECT id,COALESCE(name,''),COALESCE(name_en,''),COALESCE(affiliation,''),
                  COALESCE(interest,''),COALESCE(notes,'') FROM scholars`);
  db.exec(`INSERT INTO scholar_pool_fts(rowid,name,affiliation,top_title,keywords)
           SELECT id,COALESCE(name,''),COALESCE(affiliation,''),
                  COALESCE(top_title,''),COALESCE(keywords,'') FROM scholar_pool`);
  log('全文检索索引', '已建立');

  // ===== 9. 迁移元信息 =====
  const insMeta = db.prepare('INSERT OR REPLACE INTO migration_meta (key,value) VALUES (?,?)');
  insMeta.run('imported_at', new Date().toISOString());
  insMeta.run('source', 'Netlify Blobs (site: expert-ops-workstation)');
  insMeta.run('export_snapshot', '数据导出_20260920_0016');
  for (const [k, v] of report) insMeta.run('count:' + k, String(v));
});

console.log('开始导入（全程单事务，出错自动回滚）...\n');
tx();
console.log('\n导入完成，正在整理数据库...');
db.exec('ANALYZE');
db.pragma('wal_checkpoint(TRUNCATE)');
db.close();
console.log('完成。');
