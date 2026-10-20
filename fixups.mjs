// 执行用户确认过的三条数据修正（2026-09-20）
import Database from 'better-sqlite3';
const db = new Database('/var/lib/scholaros/scholaros.db');
db.pragma('foreign_keys = ON');

const tx = db.transaction(() => {
  // ===== 修正 1：李泽豪 两条记录合并，两份简历都挂上 =====
  const recs = db.prepare(
    `SELECT id,name,source,wechat,notes,channel FROM scholars
     WHERE email='lizehao26@ioz.ac.cn' ORDER BY id`).all();
  if (recs.length !== 2) throw new Error(`李泽豪记录数异常: ${recs.length}`);
  const [a, b] = recs;   // a=手动新增(无微信无简历), b=小红书导入(有微信有简历)

  // 以 b 为主体，补上 a 的信息
  db.prepare(`UPDATE scholars SET
      name = '李泽豪',
      name_en = 'Zehao Li',
      homepage = 'https://github.com/zehaoli0324-cloud',
      source = ?,
      notes = ?,
      updated_at = ?
    WHERE id = ?`).run(
      b.source + ' ｜ 另经 Nicole 手动新增-简历评估（求职意向小荷健康）',
      b.notes + '\n（2026-09-20 迁移时合并两条重复记录：原有「Zehao Li（李泽豪）」与「李泽豪」两条，同一邮箱，已合并保留全部信息。）',
      Date.now(), b.id);

  // 孤儿简历挂到他名下，并设为主简历
  db.prepare(`UPDATE resumes SET scholar_id=?, is_primary=1,
      note='2026-09-20 迁移时人工认领：经 PDF 内容确认为李泽豪本人，较另一份更新'
      WHERE blob_key='resume_1789134221099_hoc1c526'`).run(b.id);
  db.prepare(`UPDATE resumes SET is_primary=0
      WHERE blob_key='resume_1789134208506_3l4rxjgz'`).run();

  // 软删除重复的那条
  db.prepare(`UPDATE scholars SET deleted_at=?,
      notes=COALESCE(notes,'')||'（2026-09-20 迁移时判定为重复记录，已合并至 id='||?||'，软删除保留）'
      WHERE id=?`).run(Date.now(), b.id, a.id);

  console.log(`修正1 李泽豪: 保留 id=${b.id}，重复记录 id=${a.id} 已软删除，两份简历均已挂到 id=${b.id}`);

  // ===== 修正 2：补录 Jia Liu（刘佳） =====
  const exists = db.prepare(`SELECT id FROM scholars WHERE email='234207007@csu.edu.cn'`).get();
  if (exists) { console.log('修正2 跳过：Jia Liu 已存在'); }
  else {
    const r = db.prepare(`INSERT INTO scholars
      (name,name_en,email,affiliation,country,interest,wechat,status,source,source_type,
       notes,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      '刘佳','Jia Liu','234207007@csu.edu.cn',
      '中南大学 交通运输工程学院 交通装备与信息工程（博士在读，导师 Prof. Bing Yi）',
      '中国',
      'Scientific Machine Learning、AI for PDEs、生成模型',
      '+86 17707373159','未联系',
      '投递简历（2026-09-15），原记录缺失，2026-09-20 迁移时补录',
      '简历投递',
      '添加后无联系。（2026-09-20 迁移时补录：该学者 2026-09-15 上传过简历，但候选人记录未建成，简历一度为孤儿文件。信息从简历 PDF 中提取：男，本科2019-2023中南大学交通设备与控制工程 GPA 86.62/100 前10%，博士2023.09至今 GPA 3.85/4.0。）',
      Date.now(), Date.now());
    db.prepare(`UPDATE resumes SET scholar_id=?, is_primary=1,
        filename='Jia_Liu_CV.pdf',
        note='2026-09-20 迁移时人工认领：经 PDF 内容确认'
        WHERE blob_key='resume_1789468797407_9slts0y7'`).run(r.lastInsertRowid);
    console.log(`修正2 刘佳 Jia Liu: 已补录 id=${r.lastInsertRowid}，简历已关联`);
  }

  // ===== 修正 3：Nan Sheng 的网址型简历 =====
  const ns = db.prepare(
    `SELECT id FROM scholars WHERE name LIKE '%Nan Sheng%' AND affiliation LIKE '%Stanford%'`).get();
  if (!ns) throw new Error('未找到 Nan Sheng');
  const had = db.prepare(`SELECT id FROM resumes WHERE scholar_id=? AND kind='url'`).get(ns.id);
  if (had) { console.log('修正3 跳过：已存在网址型简历'); }
  else {
    db.prepare(`INSERT INTO resumes (scholar_id,kind,url,is_primary,uploaded_at,note)
      VALUES (?,'url',?,1,?,?)`).run(ns.id,'https://nansheng.me',Date.now(),
      '2026-09-20 用户说明：他的简历是个人网站，不是上传的文件');
    console.log(`修正3 Nan Sheng: 已记录网址型简历 https://nansheng.me (学者 id=${ns.id})`);
  }

  // 同步全文检索索引
  // 注意：这是挂在 scholars 主表上的影子索引表，不能用 DELETE 清空，
  // 必须用 FTS5 自带的 rebuild 命令让它按主表重算。
  db.exec(`INSERT INTO scholars_fts(scholars_fts) VALUES('rebuild')`);
  console.log('全文检索索引已重建');
});

tx();
db.close();
console.log('\n三条修正全部完成（单事务，出错会整体回滚）');
