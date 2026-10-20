#!/usr/bin/env node
// 每晚自动任务：补学术数据（每晚最多 800 人）→ 重算学者×企业匹配
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
console.log(new Date().toISOString(), '夜间任务开始');
// 没有 OpenAlex 密钥时每天只有约 100 次免费额度，每晚查 90 人；有密钥查 800 人
const limit = process.env.OPENALEX_API_KEY ? '800' : '90';
try { execFileSync(process.execPath, [path.join(dir, 'openalex.mjs'), limit], { stdio: 'inherit', env: process.env }); }
catch (e) { console.error('学术数据补全出错：', e.message); }
try { execFileSync(process.execPath, [path.join(dir, 'oldsys_watch.mjs')], { stdio: 'inherit', env: process.env }); }
catch (e) { console.error('旧系统检查出错：', e.message); }
const { recomputeMatches } = await import('../lib/automation.mjs');
console.log('匹配重算：', JSON.stringify(recomputeMatches()));
console.log(new Date().toISOString(), '夜间任务结束');
