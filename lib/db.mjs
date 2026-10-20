import Database from 'better-sqlite3';
export const DB_PATH = process.env.SCHOLAROS_DB || '/var/lib/scholaros/scholaros.db';
export const RESUME_DIR = process.env.SCHOLAROS_RESUMES || '/var/lib/scholaros/resumes';

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');   // 允许读写并发
db.pragma('foreign_keys = ON');    // 外键约束（每次连接都要开）
db.pragma('busy_timeout = 5000');  // 遇到锁最多等5秒，而不是立刻报错
