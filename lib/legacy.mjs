// 旧接口兼容层：前端不用改代码，只改数据源地址
// 路径形如 /legacy/<应用>/<接口名>，<应用> 用来区分 ai4s / social / fellow / scholaros
import { Router } from 'express';
import { writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { db, RESUME_DIR } from './db.mjs';
import { audit } from './auth.mjs';
import * as M from './legacy-map.mjs';

export const legacy = Router();

const J = (res, obj, code = 200) => res.status(code)
  .set({ 'content-type': 'application/json', 'cache-control': 'no-store' })
  .send(JSON.stringify(obj));
const bad = (res, error, code = 400) => J(res, { error }, code);
const norm = (s) => (s || '').toString().trim().toLowerCase();
// 把传进来的值规整成"有内容就保留、空的存 NULL"，写库时统一用它。
// 故意不叫 s——文件里多处有 const s = findScholar(...) 这样的局部变量，会遮蔽外层同名函数。
const str = (v) => (v === null || v === undefined) ? null : (String(v).trim() || null);
const now = () => Date.now();

// —— 按 姓名+机构 找人（旧接口都是这样定位记录的）——
function findScholar(name, affiliation, inTrash = false) {
  const cond = inTrash ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL';
  return db.prepare(
    `SELECT * FROM scholars WHERE ${cond}
     AND lower(trim(COALESCE(name,''))) = ? AND lower(trim(COALESCE(affiliation,''))) = ?
     LIMIT 1`).get(norm(name), norm(affiliation));
}

// —— 把简历信息补回学者记录（旧格式里 resumeId 是学者的字段）——
function attachResumes(rows) {
  if (!rows.length) return rows;
  const map = new Map();
  // 文件型和网址型都要传给前端。网址型没有 blob_key，用 url:<简历id> 作为标识，
  // 前端照常拿它去调 scholaros-resume-get，后端识别到 url: 前缀就跳转到那个网址。
  for (const r of db.prepare(
    `SELECT id, scholar_id, kind, blob_key, filename, url FROM resumes
     WHERE scholar_id IS NOT NULL
     ORDER BY is_primary DESC, uploaded_at DESC`).all()) {
    if (!map.has(r.scholar_id)) map.set(r.scholar_id, r);
  }
  for (const s of rows) {
    const hit = map.get(s.id);
    if (!hit) continue;
    if (hit.kind === 'url') {
      s._resumeId = `url:${hit.id}`;
      s._resumeFilename = hit.url || '个人主页';
    } else {
      s._resumeId = hit.blob_key;
      s._resumeFilename = hit.filename;
    }
  }
  return rows;
}

const allScholars = (trashed = false) => attachResumes(db.prepare(
  `SELECT * FROM scholars WHERE deleted_at IS ${trashed ? 'NOT ' : ''}NULL ORDER BY id`).all())
  .map(M.scholarToLegacy);

// ============================================================
// scholaros-data —— 两个应用要的内容不一样，按应用分别组装
// ============================================================
// 全量数据的缓存：数据没变就直接用上次生成好的，浏览器那边也能拿到 304「没变」直接用本地那份。
// 判断"变没变"：本连接累计改动数 + SQLite 的 data_version（别的进程写入时会变，比如夜间任务）。
const dataCache = new Map();
const dataStamp = () => db.prepare('SELECT total_changes() AS n').get().n + ':' + db.pragma('data_version', { simple: true });
legacy.get('/:app/scholaros-data', (req, res, next) => {
  const app = req.params.app === 'social' ? 'social' : 'main';
  const stamp = dataStamp();
  const hit = dataCache.get(app);
  if (hit && hit.stamp === stamp) {
    res.set({ 'content-type': 'application/json', 'cache-control': 'no-cache' });
    return res.send(hit.body);          // Express 会根据内容算 ETag，浏览器带着旧 ETag 来就回 304
  }
  const origJson = res.send.bind(res);
  res.send = (body) => {                // 截下这次生成的结果存进缓存
    if (res.statusCode === 200 && typeof body === 'string') dataCache.set(app, { stamp, body });
    res.set('cache-control', 'no-cache');
    return origJson(body);
  };
  next();
});
legacy.get('/:app/scholaros-data', (req, res) => {
  const app = req.params.app;
  const base = { candidates: allScholars(false), trashedCandidates: allScholars(true) };

  if (app === 'social') {
    // 社媒页要：候选人 + 它自己那份企业池 + 合作线索
    return J(res, {
      ...base,
      orgLeads: db.prepare('SELECT * FROM org_leads ORDER BY id').all().map(M.leadToLegacy),
      companies: db.prepare("SELECT * FROM companies WHERE pool='social' ORDER BY id").all()
        .map(M.companySocialToLegacy),
    });
  }

  // ai4s / scholaros 要：候选人 + ScholarOS 原生企业池 + 匹配 + 简报 + 月度笔记
  const matches = db.prepare('SELECT * FROM verified_matches ORDER BY id').all().map((m) => ({
    id: m.ext_id || `vm_db_${m.id}`, tag: m.tag || '', desc: m.descr || '',
    companyPageRef: m.company_page_ref || '',
    points: m.points ? JSON.parse(m.points) : [],
    followUpStatus: m.follow_up_status || '', verifiedAt: m.verified_at,
    verifiedNote: m.verified_note || '',
    scholars: db.prepare('SELECT name_snapshot,affiliation_snapshot FROM match_scholars WHERE match_id=?')
      .all(m.id).map((x) => ({ name: x.name_snapshot || '', affiliation: x.affiliation_snapshot || '' })),
    companies: db.prepare('SELECT name_snapshot FROM match_companies WHERE match_id=?')
      .all(m.id).map((x) => ({ name: x.name_snapshot || '' })),
  }));
  const monthNotes = {};
  for (const r of db.prepare('SELECT month,note FROM month_notes').all()) monthNotes[r.month] = r.note || '';

  J(res, {
    ...base,
    companies: db.prepare("SELECT * FROM companies WHERE pool='scholaros' AND deleted_at IS NULL ORDER BY id")
      .all().map(M.companyScholarosToLegacy),
    trashedCompanies: db.prepare("SELECT * FROM companies WHERE pool='scholaros' AND deleted_at IS NOT NULL ORDER BY id")
      .all().map(M.companyScholarosToLegacy),
    monthNotes,
    verifiedMatches: matches,
    briefings: db.prepare('SELECT * FROM briefings ORDER BY id').all().map(M.briefingToLegacy),
    seeded: true,
    savedAt: stateSavedAt(),
  });
});

// 整份状态的"最后修改时间"。ScholarOS 靠它判断云端有没有被别人改过，
// 所以必须是稳定的真实时间，不能每次请求都返回当前时间（那样它每次都以为有冲突）。
function stateSavedAt() {
  const vals = [
    db.prepare('SELECT MAX(updated_at) v FROM scholars').get().v,
    db.prepare('SELECT MAX(updated_at) v FROM companies').get().v,
    db.prepare('SELECT MAX(updated_at) v FROM org_leads').get().v,
    Number(db.prepare("SELECT value v FROM migration_meta WHERE key='state_saved_at'").get()?.v || 0),
  ].map(Number).filter(Number.isFinite);
  return vals.length ? Math.max(...vals) : Date.now();
}
function bumpSavedAt(ts) {
  db.prepare(`INSERT INTO migration_meta (key,value) VALUES ('state_saved_at',?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(ts));
}

// ============================================================
// scholaros-data 的写入（ScholarOS 页面唯一的保存方式）
// 原系统是"整份覆盖"，那正是并发互相覆盖的根源，这里改成逐条比对：
//   · 只更新真正有变化的字段
//   · 数据里没有、库里有的人不删（防止旧页面的残缺数据抹掉别人新加的）
//   · 条数比库里少一半以上直接拒绝（防止页面显示默认值时误触保存）
// ============================================================
legacy.post('/:app/scholaros-data', (req, res) => {
  const b = req.body || {};
  if (!Array.isArray(b.candidates)) return bad(res, 'missing_candidates');

  // partial=true：新版页面只发改动过的记录，条数少是正常的，不做"条数骤减"检查
  const partial = b.partial === true;
  // baseSavedAt：这个页面上次和服务器同步的时间。库里某条记录在这之后被别人改过，
  // 而这个页面也要改它 → 冲突，这一条不写，交给前端提示用户刷新。其他记录照常保存。
  const base = Number(b.baseSavedAt) || 0;
  const conflicts = [];
  const dbCount = db.prepare('SELECT COUNT(*) c FROM scholars WHERE deleted_at IS NULL').get().c;
  if (!partial && dbCount > 20 && b.candidates.length < dbCount * 0.5) {
    return J(res, {
      error: 'suspicious_shrink',
      message: `拒绝保存：收到 ${b.candidates.length} 条，库里有 ${dbCount} 条，` +
               `相差过大，疑似页面未加载到真实数据。请刷新页面后重试。`,
      received: b.candidates.length, existing: dbCount,
    }, 409);
  }

  const ts = now();
  let updated = 0, inserted = 0, restored = 0, trashed = 0, cUpdated = 0, cInserted = 0;

  db.transaction(() => {
    // —— 学者 ——
    // 匹配全部在 JS 里做，不用 SQL 的 lower()——
    // SQLite 的 lower() 只处理英文字母，'École' 不会变成 'école'，
    // 而 JS 的 toLowerCase() 会，两边对不上就会把已有的人当成新人插进去。
    const allRows = db.prepare('SELECT * FROM scholars').all();
    const byEmail = new Map();     // 邮箱 -> [记录...]
    const byNameAff = new Map();   // 姓名|机构 -> [记录...]
    for (const r of allRows) {
      const e = norm(r.email);
      if (e) { if (!byEmail.has(e)) byEmail.set(e, []); byEmail.get(e).push(r); }
      const k = norm(r.name) + '\u0000' + norm(r.affiliation);
      if (!byNameAff.has(k)) byNameAff.set(k, []);
      byNameAff.get(k).push(r);
    }
    // 一条库记录只能被一条传入数据认领，避免两条同邮箱的数据互相覆盖
    const claimed = new Set();
    function pick(list, wantDeleted) {
      if (!list || !list.length) return null;
      // 优先：没被认领过 且 删除状态一致
      let hit = list.find((r) => !claimed.has(r.id) && (!!r.deleted_at === wantDeleted));
      // 其次：没被认领过
      if (!hit) hit = list.find((r) => !claimed.has(r.id));
      if (hit) claimed.add(hit.id);
      return hit || null;
    }
    const insS = db.prepare(`INSERT INTO scholars
      (name,name_en,email,affiliation,country,interest,homepage,h_index,openalex_id,wechat,
       wechat_id,contact_form,status,source,source_type,channel,fit_line,collab_form,
       academic_grade,prio,notes,invite_stage,last_email_date,created_at,updated_at)
      VALUES (@name,@name_en,@email,@affiliation,@country,@interest,@homepage,@h_index,@openalex_id,
       @wechat,@wechat_id,@contact_form,@status,@source,@source_type,@channel,@fit_line,@collab_form,
       @academic_grade,@prio,@notes,@invite_stage,@last_email_date,@ts,@ts)`);

    const byId = new Map(allRows.map((r) => [r.id, r]));
    // wantDeleted: 这条传入数据期望匹配"在用"还是"回收站"里的记录
    const locate = (c, wantDeleted = false) => {
      // 有数据库编号就按编号认，最可靠（改了姓名/机构也认得出）
      const byNo = c._id != null ? byId.get(Number(c._id)) : null;
      if (byNo && !claimed.has(byNo.id)) { claimed.add(byNo.id); return byNo; }
      // 姓名+机构比邮箱更精确（同一邮箱可能对应两条不同的人/记录），所以先用它
      const hit = pick(byNameAff.get(norm(c.name) + '\u0000' + norm(c.affiliation)), wantDeleted);
      if (hit) return hit;
      const e = norm(c.email);
      return e ? pick(byEmail.get(e), wantDeleted) : null;
    };
    const numOrNull = (v) => {
      if (v === '' || v === null || v === undefined) return null;
      const n = Number(String(v).replace(/[^\d.-]/g, ''));
      return Number.isFinite(n) ? n : null;
    };

    for (const c of b.candidates) {
      if (!c || !c.name) continue;
      const row = locate(c);
      if (row && base && Number(row.updated_at || 0) > base) { conflicts.push(row.name || c.name); continue; }
      if (!row) {
        insS.run({
          name: c.name, name_en: str(c.nameEn), email: str(c.email), affiliation: str(c.affiliation),
          country: str(c.country), interest: str(c.interest), homepage: str(c.homepage),
          h_index: numOrNull(c.hIndex), openalex_id: str(c.openalexId), wechat: str(c.wechat),
          wechat_id: str(c.wechatId), contact_form: str(c.contactForm), status: str(c.status) || '未联系',
          source: str(c.source), source_type: str(c.sourceType), channel: str(c.channel),
          fit_line: str(c.fitLine), collab_form: str(c.collabForm), academic_grade: str(c.academicGrade),
          prio: str(c.prio), notes: str(c.notes), invite_stage: numOrNull(c.inviteStage),
          last_email_date: str(c.lastEmailSentDate), ts });
        inserted++;
        continue;
      }
      const sets = [], vals = [];
      for (const [legacyKey, col] of Object.entries(M.S_FIELD)) {
        if (!col || !(legacyKey in c)) continue;
        const incoming = col === 'h_index' || col === 'invite_stage'
          ? numOrNull(c[legacyKey]) : (str(c[legacyKey]));
        if (String(row[col] ?? '') === String(incoming ?? '')) continue;
        sets.push(`${col}=?`); vals.push(incoming);
      }
      if (row.deleted_at) { sets.push('deleted_at=NULL'); restored++; }
      if (sets.length) {
        sets.push('updated_at=?'); vals.push(ts);
        db.prepare(`UPDATE scholars SET ${sets.join(',')} WHERE id=?`).run(...vals, row.id);
        updated++;
      }
    }

    // —— 回收站 ——
    for (const c of (Array.isArray(b.trashedCandidates) ? b.trashedCandidates : [])) {
      if (!c || !c.name) continue;
      const row = locate(c, true);
      if (row && base && Number(row.updated_at || 0) > base) { conflicts.push(row.name || c.name); continue; }
      if (row && !row.deleted_at) {
        db.prepare('UPDATE scholars SET deleted_at=?, updated_at=? WHERE id=?').run(ts, ts, row.id);
        trashed++;
      }
    }

    // —— 企业（ScholarOS 池）——
    for (const c of (Array.isArray(b.companies) ? b.companies : [])) {
      if (!c || !c.name) continue;
      const row = (c._id != null && db.prepare("SELECT * FROM companies WHERE pool='scholaros' AND id=?").get(Number(c._id)))
        || db.prepare("SELECT * FROM companies WHERE pool='scholaros' AND name=?").get(c.name);
      if (row && base && Number(row.updated_at || 0) > base) { conflicts.push(row.name); continue; }
      if (row && row.deleted_at) {   // 从企业回收站恢复
        db.prepare('UPDATE companies SET deleted_at=NULL, updated_at=? WHERE id=?').run(ts, row.id); cUpdated++;
      }
      if (!row) {
        db.prepare(`INSERT INTO companies (pool,name,country,industry,funding_stage,homepage,
          status,source,notes,contact_name,contact_title,contact_info,need_type,fit_line,
          collab_form,prio,scholar_match,discovered_date,created_at,updated_at)
          VALUES ('scholaros',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          c.name, str(c.country), str(c.industry), str(c.fundingStage), str(c.homepage), str(c.status),
          str(c.source), str(c.notes), str(c.contactName), str(c.contactTitle), str(c.contactInfo),
          str(c.needType), str(c.fitLine), str(c.collabForm), str(c.prio), str(c.scholarMatch),
          str(c.discoveredDate), ts, ts);
        cInserted++;
        continue;
      }
      const sets = [], vals = [];
      for (const [legacyKey, col] of Object.entries(M.C_SOS_FIELD)) {
        if (!col || !(legacyKey in c)) continue;
        const incoming = str(c[legacyKey]);
        if (String(row[col] ?? '') === String(incoming ?? '')) continue;
        sets.push(`${col}=?`); vals.push(incoming);
      }
      if (sets.length) {
        sets.push('updated_at=?'); vals.push(ts);
        db.prepare(`UPDATE companies SET ${sets.join(',')} WHERE id=?`).run(...vals, row.id);
        cUpdated++;
      }
    }

    // —— 企业回收站（以前没处理，在 ScholarOS 里删除企业一直存不上）——
    for (const c of (Array.isArray(b.trashedCompanies) ? b.trashedCompanies : [])) {
      if (!c || !c.name) continue;
      const row = (c._id != null && db.prepare("SELECT * FROM companies WHERE pool='scholaros' AND id=?").get(Number(c._id)))
        || db.prepare("SELECT * FROM companies WHERE pool='scholaros' AND name=?").get(c.name);
      if (!row || row.deleted_at) continue;
      if (base && Number(row.updated_at || 0) > base) { conflicts.push(row.name); continue; }
      db.prepare('UPDATE companies SET deleted_at=?, updated_at=? WHERE id=?').run(ts, ts, row.id); cUpdated++;
    }

    // —— 月度笔记 ——
    if (b.monthNotes && typeof b.monthNotes === 'object') {
      for (const [k, v] of Object.entries(b.monthNotes)) {
        db.prepare(`INSERT INTO month_notes (month,note) VALUES (?,?)
                    ON CONFLICT(month) DO UPDATE SET note=excluded.note`).run(k, v ?? '');
      }
    }

    bumpSavedAt(ts);
  })();

  audit(req.user, 'legacy_save_state', null,
    { updated, inserted, restored, trashed, cUpdated, cInserted }, req.ip);
  J(res, { ok: true, savedAt: stateSavedAt(), conflicts,
    applied: { 学者更新: updated, 学者新增: inserted, 恢复: restored,
               移入回收站: trashed, 企业更新: cUpdated, 企业新增: cInserted } });
});

// ============================================================
// 候选人写操作
// ============================================================
legacy.post('/:app/scholaros-update-field', (req, res) => {
  const { name, affiliation, field, value } = req.body || {};
  if (!name || !affiliation || !field) return bad(res, 'missing_required_fields');
  if (!(field in M.S_FIELD)) return bad(res, 'field_not_allowed');
  const col = M.S_FIELD[field];
  const s = findScholar(name, affiliation);
  if (!s) return bad(res, 'candidate_not_found', 404);
  if (col) {                       // 有对应列的才写库
    db.prepare(`UPDATE scholars SET ${col}=?, updated_at=? WHERE id=?`)
      .run(value === '' ? null : value, now(), s.id);
  }
  audit(req.user, 'legacy_update_field', `scholars:${s.id}`, { field, value }, req.ip);
  const fresh = attachResumes([db.prepare('SELECT * FROM scholars WHERE id=?').get(s.id)])[0];
  J(res, { ok: true, candidate: M.scholarToLegacy(fresh) });
});

legacy.post('/:app/scholaros-trash-candidate', (req, res) => {
  const { name, affiliation, action } = req.body || {};
  if (!name || !affiliation || !['trash', 'restore'].includes(action))
    return bad(res, 'missing_required_fields');
  const s = findScholar(name, affiliation, action === 'restore');
  if (!s) return bad(res, action === 'trash' ? 'candidate_not_found' : 'candidate_not_found_in_trash', 404);
  db.prepare('UPDATE scholars SET deleted_at=?, updated_at=? WHERE id=?')
    .run(action === 'trash' ? now() : null, now(), s.id);
  audit(req.user, `legacy_${action}`, `scholars:${s.id}`, null, req.ip);
  J(res, { ok: true,
    totalCandidates: db.prepare('SELECT COUNT(*) c FROM scholars WHERE deleted_at IS NULL').get().c,
    totalTrashed: db.prepare('SELECT COUNT(*) c FROM scholars WHERE deleted_at IS NOT NULL').get().c });
});

legacy.post('/:app/scholaros-merge-candidates', (req, res) => {
  const incoming = Array.isArray(req.body?.candidates) ? req.body.candidates : [];
  if (!incoming.length) return bad(res, 'no_candidates');

  const rows = db.prepare('SELECT id,name,affiliation FROM scholars WHERE deleted_at IS NULL').all();
  const byKey = new Set(rows.map((c) => norm(c.name) + '|' + norm(c.affiliation)));
  const byName = new Set(rows.map((c) => norm(c.name)));

  const added = [], skippedDuplicate = [];
  const ins = db.prepare(`INSERT INTO scholars
    (name,name_en,email,affiliation,country,interest,homepage,h_index,openalex_id,wechat,
     wechat_id,contact_form,status,source,source_type,channel,fit_line,collab_form,
     academic_grade,prio,notes,created_at,updated_at)
    VALUES (@name,@name_en,@email,@affiliation,@country,@interest,@homepage,@h_index,@openalex_id,
     @wechat,@wechat_id,@contact_form,@status,@source,@source_type,@channel,@fit_line,@collab_form,
     @academic_grade,@prio,@notes,@ts,@ts)`);

  db.transaction(() => {
    for (const p of incoming) {
      if (!p.name) continue;
      const key = norm(p.name) + '|' + norm(p.affiliation);
      if (byKey.has(key)) { skippedDuplicate.push(p.name); continue; }
      // 同名但机构写法不同：默认不自动新增，需要人工确认（跟原逻辑一致）
      if (byName.has(norm(p.name)) && !p.forceAdd) {
        skippedDuplicate.push(p.name + '（同名不同机构写法，未新增，需人工核实是否同一人）'); continue;
      }
      const hi = Number(String(p.hIndex ?? '').replace(/[^\d.-]/g, ''));
      ins.run({
        name: p.name, name_en: p.nameEn || null, email: p.email || null,
        affiliation: p.affiliation || null, country: p.country || null,
        interest: p.interest || null, homepage: p.homepage || null,
        h_index: Number.isFinite(hi) && String(p.hIndex ?? '') !== '' ? hi : null,
        openalex_id: p.openalexId || null, wechat: p.wechat || null,
        wechat_id: p.wechatId || null, contact_form: p.contactForm || null,
        status: p.status || '未联系', source: p.source || null,
        source_type: p.sourceType || null, channel: p.channel || null,
        fit_line: p.fitLine || null, collab_form: p.collabForm || null,
        academic_grade: p.academicGrade || null, prio: p.prio || null,
        notes: p.notes || null, ts: now(),
      });
      byKey.add(key); byName.add(norm(p.name)); added.push(p.name);
    }
  })();

  audit(req.user, 'legacy_merge_candidates', null, { added: added.length, skipped: skippedDuplicate.length }, req.ip);
  J(res, { ok: true, added, skippedDuplicate,
    totalCandidates: db.prepare('SELECT COUNT(*) c FROM scholars WHERE deleted_at IS NULL').get().c });
});

// 只补空字段，不覆盖已有值；notes 是追加
legacy.post('/:app/scholaros-enrich-candidate', (req, res) => {
  const { targetName, targetAffiliation, fields } = req.body || {};
  if (!targetName || !targetAffiliation || !fields) return bad(res, 'missing_required_fields');
  const s = findScholar(targetName, targetAffiliation);
  if (!s) return bad(res, 'candidate_not_found', 404);

  const ENRICH = ['email', 'nameEn', 'country', 'interest', 'homepage', 'wechat', 'hIndex'];
  const filled = [], sets = [], vals = [];
  for (const f of ENRICH) {
    const v = fields[f];
    if (v === undefined || v === null || v === '') continue;
    const col = M.S_FIELD[f];
    if (!col || s[col]) continue;          // 已有值就不动
    sets.push(`${col}=?`);
    vals.push(f === 'hIndex' ? Number(String(v).replace(/[^\d.-]/g, '')) || null : v);
    filled.push(f);
  }
  // 简历：原来是学者字段，现在写进简历表
  if (fields.resumeId) {
    const ex = db.prepare('SELECT id FROM resumes WHERE blob_key=?').get(fields.resumeId);
    if (ex) db.prepare('UPDATE resumes SET scholar_id=?, filename=COALESCE(filename,?) WHERE id=?')
      .run(s.id, fields.resumeFilename || null, ex.id);
    filled.push('resumeId');
  }
  if (fields.notes) {
    sets.push('notes=?');
    vals.push((s.notes || '') + (s.notes ? '；' : '') + fields.notes);
    filled.push('notes');
  }
  if (sets.length) {
    sets.push('updated_at=?'); vals.push(now());
    db.prepare(`UPDATE scholars SET ${sets.join(', ')} WHERE id=?`).run(...vals, s.id);
  }
  audit(req.user, 'legacy_enrich', `scholars:${s.id}`, { filled }, req.ip);
  const fresh = attachResumes([db.prepare('SELECT * FROM scholars WHERE id=?').get(s.id)])[0];
  J(res, { ok: true, filled, candidate: M.scholarToLegacy(fresh) });
});

// ============================================================
// 简历上传 / 读取
// ============================================================
legacy.post('/:app/scholaros-resume-upload', (req, res) => {
  const { filename, base64Data, contentType, overwriteId } = req.body || {};
  if (!filename || !base64Data) return bad(res, 'missing_required_fields');
  const buf = Buffer.from(base64Data, 'base64');
  if (!buf.length) return bad(res, 'empty_file');
  if (buf.length > 20 * 1024 * 1024) return bad(res, 'file_too_large');

  const resumeId = overwriteId ||
    ('resume_' + now() + '_' + randomBytes(5).toString('hex').slice(0, 8));
  if (!/^resume_[A-Za-z0-9_]+$/.test(resumeId)) return bad(res, 'bad_resume_id');

  writeFileSync(path.join(RESUME_DIR, resumeId), buf);
  const md5 = createHash('md5').update(buf).digest('hex');
  const ex = db.prepare('SELECT id FROM resumes WHERE blob_key=?').get(resumeId);
  if (ex) {
    db.prepare('UPDATE resumes SET filename=?,file_size=?,mime_type=?,md5=?,uploaded_at=? WHERE id=?')
      .run(filename, buf.length, contentType || 'application/pdf', md5, now(), ex.id);
  } else {
    db.prepare(`INSERT INTO resumes (scholar_id,kind,blob_key,filename,file_size,mime_type,md5,uploaded_at)
                VALUES (NULL,'file',?,?,?,?,?,?)`)
      .run(resumeId, filename, buf.length, contentType || 'application/pdf', md5, now());
  }
  audit(req.user, 'legacy_resume_upload', resumeId, { filename, size: buf.length }, req.ip);
  J(res, { ok: true, resumeId, filename });
});

legacy.get('/:app/scholaros-resume-get', (req, res) => {
  const id = req.query.id;
  if (!id) return bad(res, 'missing_id');
  // 网址型简历：直接跳到本人主页
  if (String(id).startsWith('url:')) {
    const u = db.prepare("SELECT url FROM resumes WHERE id=? AND kind='url'")
                .get(String(id).slice(4));
    if (!u || !u.url) return bad(res, 'resume_not_found', 404);
    return res.redirect(302, u.url);
  }
  const r = db.prepare('SELECT * FROM resumes WHERE blob_key=?').get(id);
  const p = path.join(RESUME_DIR, path.basename(String(id)));
  if (!r || !existsSync(p)) return bad(res, 'resume_not_found', 404);
  res.set({
    'content-type': r.mime_type || 'application/pdf',
    'content-disposition': `inline; filename="${encodeURIComponent(r.filename || 'resume.pdf')}"`,
    'cache-control': 'public, max-age=3600',
  });
  res.send(readFileSync(p));
});

// ============================================================
// 活动日志
// ============================================================
legacy.get('/:app/scholaros-activity', (req, res) => {
  if (req.query.all === '1') {
    return J(res, { events: db.prepare(
      `SELECT payload FROM activity_log ORDER BY id DESC LIMIT 2000`).all()
      .map((r) => JSON.parse(r.payload)).reverse() });
  }
  const since = now() - 5 * 60 * 1000;
  J(res, { events: db.prepare('SELECT payload FROM activity_log WHERE created_at > ? ORDER BY id').all(since)
    .map((r) => JSON.parse(r.payload)) });
});

legacy.post('/:app/scholaros-activity', (req, res) => {
  const { name, action } = req.body || {};
  if (!name || !action) return bad(res, 'missing_required_fields');
  const entry = { name: String(name).slice(0, 30), action: String(action).slice(0, 80), ts: now() };
  db.prepare('INSERT INTO activity_log (event_type,payload,created_at) VALUES (?,?,?)')
    .run('activity', JSON.stringify(entry), entry.ts);
  J(res, { ok: true });
});

// ============================================================
// 合作线索 / 企业池（社媒侧）
// ============================================================
function upsertList(res, req, table, pool) {
  const { action, id, fields } = req.body || {};
  if (!['add', 'update', 'archive', 'unarchive'].includes(action)) return bad(res, 'invalid_action');
  const isLead = table === 'org_leads';
  const FIELD = isLead ? M.LEAD_FIELD : M.C_SOC_FIELD;
  const where = isLead ? 'ext_id=?' : "ext_id=? AND pool='social'";

  if (action === 'add') {
    const extId = (isLead ? 'lead_' : 'company_') + now() + '_' + randomBytes(3).toString('hex');
    const cols = ['ext_id', 'created_at', 'updated_at'], vals = [extId, now(), now()];
    if (!isLead) { cols.push('pool'); vals.push('social'); }
    cols.push('status'); vals.push(fields?.status || (isLead ? '跟进中' : '未联系'));
    for (const [k, v] of Object.entries(fields || {})) {
      if (k === 'status' || !FIELD[k]) continue;
      cols.push(FIELD[k]); vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
    db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
  } else {
    const row = db.prepare(`SELECT id FROM ${table} WHERE ${where}`).get(id);
    if (!row) return bad(res, isLead ? 'lead_not_found' : 'company_not_found', 404);
    if (action === 'update') {
      const sets = [], vals = [];
      for (const [k, v] of Object.entries(fields || {})) {
        if (!FIELD[k]) continue;
        sets.push(`${FIELD[k]}=?`); vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
      }
      if (sets.length) {
        sets.push('updated_at=?'); vals.push(now());
        db.prepare(`UPDATE ${table} SET ${sets.join(',')} WHERE id=?`).run(...vals, row.id);
      }
    } else {
      db.prepare(`UPDATE ${table} SET deleted_at=?, updated_at=? WHERE id=?`)
        .run(action === 'archive' ? now() : null, now(), row.id);
    }
  }
  audit(req.user, `legacy_${table}_${action}`, id || null, null, req.ip);

  if (isLead) return J(res, { ok: true, leads: db.prepare('SELECT * FROM org_leads ORDER BY id').all().map(M.leadToLegacy) });
  J(res, { ok: true, companies: db.prepare("SELECT * FROM companies WHERE pool='social' ORDER BY id").all().map(M.companySocialToLegacy) });
}
legacy.post('/:app/scholaros-org-lead', (req, res) => upsertList(res, req, 'org_leads'));
legacy.post('/:app/scholaros-company', (req, res) => upsertList(res, req, 'companies', 'social'));

// ============================================================
// ScholarOS 原生企业池
// ============================================================
legacy.post('/:app/scholaros-update-company-field', (req, res) => {
  const { name, field, value } = req.body || {};
  if (!name || !field) return bad(res, 'missing_required_fields');
  const col = M.C_SOS_FIELD[field];
  if (!col) return bad(res, 'field_not_allowed');
  const r = db.prepare("SELECT id FROM companies WHERE pool='scholaros' AND name=?").get(name);
  if (!r) return bad(res, 'company_not_found', 404);
  db.prepare(`UPDATE companies SET ${col}=?, updated_at=? WHERE id=?`).run(value === '' ? null : value, now(), r.id);
  audit(req.user, 'legacy_update_company', `companies:${r.id}`, { field, value }, req.ip);
  J(res, { ok: true });
});

legacy.post('/:app/scholaros-merge-companies', (req, res) => {
  const incoming = Array.isArray(req.body?.prospects) ? req.body.prospects : [];
  if (!incoming.length) return bad(res, 'no_prospects');
  const added = [], enriched = [];
  const existing = new Map(db.prepare("SELECT id,name,notes,homepage,industry FROM companies WHERE pool='scholaros'")
    .all().map((c) => [norm(c.name), c]));

  db.transaction(() => {
    for (const p of incoming) {
      if (!p.name) continue;
      const hit = existing.get(norm(p.name));
      if (hit) {
        // 已存在：只补空字段
        const sets = [], vals = [];
        if (!hit.industry && p.industry) { sets.push('industry=?'); vals.push(p.industry); }
        if (!hit.homepage && p.homepage) { sets.push('homepage=?'); vals.push(p.homepage); }
        if (p.desc) { sets.push('notes=?'); vals.push((hit.notes || '') + (hit.notes ? '；' : '') + p.desc); }
        if (sets.length) {
          sets.push('updated_at=?'); vals.push(now());
          db.prepare(`UPDATE companies SET ${sets.join(',')} WHERE id=?`).run(...vals, hit.id);
        }
        enriched.push(p.name);
      } else {
        const r = db.prepare(`INSERT INTO companies (pool,name,industry,homepage,contact_info,notes,source,status,discovered_date,created_at,updated_at)
          VALUES ('scholaros',?,?,?,?,?,?,'未联系',?,?,?)`).run(
          p.name, p.industry || null, p.homepage || null, p.email || null,
          p.desc || null, p.source || '企业裂变',
          new Date().toISOString().slice(0, 10), now(), now());
        existing.set(norm(p.name), { id: r.lastInsertRowid, name: p.name, notes: p.desc, homepage: p.homepage, industry: p.industry });
        added.push(p.name);
      }
    }
  })();
  audit(req.user, 'legacy_merge_companies', null, { added: added.length, enriched: enriched.length }, req.ip);
  J(res, { ok: true, added, enriched,
    totalCompanies: db.prepare("SELECT COUNT(*) c FROM companies WHERE pool='scholaros' AND deleted_at IS NULL").get().c });
});

// ============================================================
// 匹配记录字段更新
// ============================================================
legacy.post('/:app/scholaros-update-match-field', (req, res) => {
  const { id, field, value } = req.body || {};
  if (!id || !field) return bad(res, 'missing_required_fields');
  const col = M.MATCH_FIELD[field];
  if (!col) return bad(res, 'field_not_allowed');
  const r = db.prepare('SELECT id FROM verified_matches WHERE ext_id=?').get(id);
  if (!r) return bad(res, 'match_not_found', 404);
  db.prepare(`UPDATE verified_matches SET ${col}=? WHERE id=?`).run(value === '' ? null : value, r.id);
  audit(req.user, 'legacy_update_match', `matches:${r.id}`, { field, value }, req.ip);
  J(res, { ok: true });
});

// ============================================================
// 简报
// ============================================================
legacy.post('/:app/scholaros-briefings', (req, res) => {
  const { action, id, date, title, contentHtml, dataJson } = req.body || {};
  if (action === 'add') {
    const extId = 'brief_' + now() + '_' + randomBytes(3).toString('hex');
    const r = db.prepare(`INSERT INTO briefings (ext_id,date,title,content_html,data_json,created_at)
                          VALUES (?,?,?,?,?,?)`)
      .run(extId, date || '', title || '', contentHtml || '',
           dataJson ? JSON.stringify(dataJson) : null, now());
    audit(req.user, 'legacy_briefing_add', extId, null, req.ip);
    return J(res, { ok: true, record: M.briefingToLegacy(
      db.prepare('SELECT * FROM briefings WHERE id=?').get(r.lastInsertRowid)) });
  }
  const row = db.prepare('SELECT id FROM briefings WHERE ext_id=?').get(id);
  if (!row) return bad(res, 'briefing_not_found', 404);
  if (action === 'edit') {
    db.prepare('UPDATE briefings SET content_html=?, data_json=? WHERE id=?')
      .run(contentHtml || '', dataJson ? JSON.stringify(dataJson) : null, row.id);
  } else if (action === 'delete') {
    db.prepare('DELETE FROM briefings WHERE id=?').run(row.id);
  } else return bad(res, 'invalid_action');
  audit(req.user, `legacy_briefing_${action}`, id, null, req.ip);
  J(res, { ok: true });
});

// ============================================================
// Audax Fellow 的三个接口
// ============================================================
const admitted = () => db.prepare(
  "SELECT * FROM scholars WHERE deleted_at IS NULL AND status='意向合作' ORDER BY id").all();

legacy.get('/:app/fellow-public', (_req, res) => {
  const list = admitted().map((c) => ({
    affiliation: c.affiliation || '', country: c.country || '', interest: c.interest || '' }));
  J(res, { count: list.length, scholars: list });
});

legacy.get('/:app/fellow-full', (req, res) => {
  // 沿用原来的密钥参数名，同时接受统一的访问密钥
  const isAdmin = req.user?.role === 'admin';
  const isMember = req.user?.role === 'member' || isAdmin;
  if (!req.user) return J(res, { error: 'invalid_key' }, 403);
  const list = admitted().map((c) => {
    const o = { name: c.name || '', affiliation: c.affiliation || '',
                country: c.country || '', interest: c.interest || '' };
    if (isMember) { o.wechat = c.wechat || ''; o.contactForm = c.contact_form || ''; }
    return o;
  });
  J(res, { count: list.length, scholars: list });
});

legacy.post('/:app/fellow-apply', (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.affiliation) return bad(res, 'missing_required_fields');
  const dup = b.email
    ? db.prepare('SELECT id FROM scholars WHERE lower(trim(COALESCE(email,\'\')))=?').get(norm(b.email))
    : findScholar(b.name, b.affiliation);
  if (dup) {
    db.prepare(`UPDATE scholars SET source_type='自助申请入驻', updated_at=? WHERE id=?`).run(now(), dup.id);
    return J(res, { ok: true, duplicated: true });
  }
  db.prepare(`INSERT INTO scholars (name,affiliation,country,interest,email,wechat,contact_form,
              status,source,source_type,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,'未联系','自助申请入驻','自助申请入驻',?,?)`)
    .run(b.name, b.affiliation, b.country || null, b.interest || null, b.email || null,
         b.wechat || null, b.contactForm || null, now(), now());
  audit(req.user, 'legacy_fellow_apply', b.name, null, req.ip);
  J(res, { ok: true });
});

legacy.get('/:app/fellow-admin', (req, res) => {
  if (req.user?.role !== 'admin') return J(res, { error: 'invalid_key' }, 403);
  J(res, { pending: db.prepare(
    "SELECT * FROM scholars WHERE deleted_at IS NULL AND source_type='自助申请入驻' ORDER BY id")
    .all().map(M.scholarToLegacy) });
});

legacy.post('/:app/fellow-admin', (req, res) => {
  if (req.user?.role !== 'admin') return J(res, { error: 'invalid_key' }, 403);
  const { name, affiliation, action } = req.body || {};
  if (!name || !affiliation || !['approve', 'reject'].includes(action))
    return bad(res, 'missing_required_fields');
  const s = findScholar(name, affiliation);
  if (!s) return bad(res, 'candidate_not_found', 404);
  if (action === 'approve') {
    db.prepare("UPDATE scholars SET status='意向合作', updated_at=? WHERE id=?").run(now(), s.id);
  } else {
    db.prepare('UPDATE scholars SET deleted_at=?, updated_at=? WHERE id=?').run(now(), now(), s.id);
  }
  audit(req.user, `legacy_fellow_${action}`, `scholars:${s.id}`, null, req.ip);
  J(res, { ok: true });
});
