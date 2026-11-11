// Generates a one-time owner connection and hash-only D1 seed. Does not provision or deploy by itself.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
const args = process.argv.slice(2), origin = args[0], output = path.resolve(args[1] || '.local');
if (!origin || new URL(origin).origin !== origin || new URL(origin).protocol !== 'https:') throw new Error('用法：node cloud/provision-owner.mjs https://your-api.example .local');
const token = 'pr_' + randomBytes(32).toString('hex'), workspaceId = randomUUID(), now = new Date().toISOString();
await fs.mkdir(output, { recursive: true });
await fs.writeFile(path.join(output, 'owner.json'), JSON.stringify({ apiUrl: origin, token, workspaceId }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const seed = `INSERT INTO workspaces(id,created_at) VALUES('${workspaceId}','${now}');\nINSERT INTO tokens(id,workspace_id,token_hash,kind,name,created_at) VALUES('${randomUUID()}','${workspaceId}','${createHash('sha256').update(token).digest('hex')}','writer','Owner','${now}');\n`;
await fs.writeFile(path.join(output, 'owner-seed.sql'), seed, { flag: 'wx', mode: 0o600 });
console.log('拥有者配置与仅含摘要的初始化SQL已写入指定私有目录；凭证未输出。');
