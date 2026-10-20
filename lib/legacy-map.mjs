// 数据库行 ←→ 旧接口 JSON 格式互转
// 目的：让四个前端一行代码都不用改，看到的字段名和现在完全一样

export function scholarToLegacy(r) {
  const o = {
    _id: r.id,   // 数据库编号：前端保存时靠它认人，改了姓名或机构也不会被当成新人
    name: r.name || '', nameEn: r.name_en || '', email: r.email || '',
    affiliation: r.affiliation || '', country: r.country || '',
    interest: r.interest || '', source: r.source || '',
    status: r.status || '未联系',
    hIndex: r.h_index === null || r.h_index === undefined ? '' : r.h_index,
    homepage: r.homepage || '', wechat: r.wechat || '', wechatId: r.wechat_id || '',
    contactForm: r.contact_form || '', fitLine: r.fit_line || '',
    collabForm: r.collab_form || '', poolOverride: r.pool_override || '',
    openalexId: r.openalex_id || '', academicGrade: r.academic_grade || '',
    academicScore: r.academic_score, academicFacts: r.academic_facts ? JSON.parse(r.academic_facts) : null,
    sourceType: r.source_type || '',
  };
  // 这些字段原来是"有才有"，不是所有记录都带，保持一致避免前端判断出错
  if (r.channel) o.channel = r.channel;
  if (r.notes) o.notes = r.notes;
  if (r.prio) o.prio = r.prio;
  if (r.grade_note) o.gradeNote = r.grade_note;
  if (r.invite_stage !== null && r.invite_stage !== undefined) o.inviteStage = r.invite_stage;
  if (r.last_email_date) o.lastEmailSentDate = r.last_email_date;
  if (r._resumeId) { o.resumeId = r._resumeId; o.resumeFilename = r._resumeFilename || ''; }
  return o;
}

// 旧字段名 → 数据库列名
export const S_FIELD = {
  name:'name', nameEn:'name_en', email:'email', affiliation:'affiliation',
  country:'country', interest:'interest', source:'source', status:'status',
  hIndex:'h_index', homepage:'homepage', wechat:'wechat', wechatId:'wechat_id',
  contactForm:'contact_form', fitLine:'fit_line', collabForm:'collab_form',
  poolOverride:'pool_override', openalexId:'openalex_id', academicGrade:'academic_grade',
  sourceType:'source_type', channel:'channel', notes:'notes', prio:'prio',
  gradeNote:'grade_note', inviteStage:'invite_stage', lastEmailSentDate:'last_email_date',
  discoveredDate:null, jobSeeking:null, xhsOnboarded:null, linkedinOnboarded:null,
};

export function companyScholarosToLegacy(r) {
  return {
    _id: r.id,
    name: r.name || '', country: r.country || '', industry: r.industry || '',
    fundingStage: r.funding_stage || '', fitLine: r.fit_line || '',
    needType: r.need_type || '', contactName: r.contact_name || '',
    contactTitle: r.contact_title || '', contactInfo: r.contact_info || '',
    budget: r.budget || '', timeline: r.timeline || '', homepage: r.homepage || '',
    source: r.source || '', status: r.status || '', collabForm: r.collab_form || '',
    notes: r.notes || '', prio: r.prio || '', scholarMatch: r.scholar_match || '',
    discoveredDate: r.discovered_date || '',
    ...(r.contact_label ? { contactLabel: r.contact_label } : {}),
    ...(r.need_detail ? { needDetail: r.need_detail } : {}),
    ...(r.eval_focus ? { evalFocus: r.eval_focus } : {}),
    ...(r.eval_analysis_html ? { evalAnalysisHtml: r.eval_analysis_html } : {}),
    ...(r.cross_matches ? { crossMatches: JSON.parse(r.cross_matches) } : {}),
    ...(r.alt_contacts ? { altContacts: JSON.parse(r.alt_contacts) } : {}),
  };
}
export const C_SOS_FIELD = {
  name:'name', country:'country', industry:'industry', fundingStage:'funding_stage',
  fitLine:'fit_line', needType:'need_type', contactName:'contact_name',
  contactTitle:'contact_title', contactInfo:'contact_info', budget:'budget',
  timeline:'timeline', homepage:'homepage', source:'source', status:'status',
  collabForm:'collab_form', notes:'notes', prio:'prio', scholarMatch:'scholar_match',
  discoveredDate:'discovered_date', contactLabel:'contact_label', needDetail:'need_detail',
  evalFocus:'eval_focus', evalAnalysisHtml:'eval_analysis_html',
};

export function companySocialToLegacy(r) {
  return {
    id: r.ext_id || `company_db_${r.id}`, name: r.name || '', industry: r.industry || '',
    needs: r.needs || '', contact: r.contact || '', email: r.email || '',
    notes: r.notes || '', status: r.status || '未联系',
    archived: !!r.deleted_at, researched: !!r.researched,
    createdAt: r.created_at, homepage: r.homepage || '', country: r.country || '',
    fundingStage: r.funding_stage || '',
    scholarMatchLabel: r.match_label || '', scholarMatchCount: r.match_count,
    scholarMatchUpdatedAt: r.match_updated_at,
  };
}
export const C_SOC_FIELD = {
  name:'name', industry:'industry', needs:'needs', contact:'contact', email:'email',
  notes:'notes', status:'status', researched:'researched', homepage:'homepage',
  country:'country', fundingStage:'funding_stage', scholarMatchLabel:'match_label',
  scholarMatchCount:'match_count', scholarMatchUpdatedAt:'match_updated_at',
};

export function leadToLegacy(r) {
  return {
    id: r.ext_id || `lead_db_${r.id}`, org: r.org || '', project: r.project || '',
    amount: r.amount || '', stage: r.stage || '', contact: r.contact || '',
    ideas: r.ideas || '', notes: r.notes || '', status: r.status || '跟进中',
    archived: !!r.deleted_at, createdAt: r.created_at,
  };
}
export const LEAD_FIELD = {
  org:'org', project:'project', amount:'amount', stage:'stage', contact:'contact',
  ideas:'ideas', notes:'notes', status:'status',
};

export function briefingToLegacy(r) {
  return {
    id: r.ext_id || `brief_db_${r.id}`, date: r.date || '', title: r.title || '',
    contentHtml: r.content_html || '',
    ...(r.data_json ? { dataJson: JSON.parse(r.data_json) } : {}),
    createdAt: r.created_at,
  };
}

export const MATCH_FIELD = {
  tag:'tag', desc:'descr', companyPageRef:'company_page_ref',
  followUpStatus:'follow_up_status', verifiedNote:'verified_note',
};
