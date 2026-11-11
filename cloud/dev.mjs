// Uses an already installed Miniflare, or the module URL explicitly provided by the developer.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = await import(process.env.PAGE_REVIEW_MINIFLARE_MODULE || 'miniflare');
const { Miniflare } = runtime;
const options = { modules: true, scriptPath: path.join(root, 'cloud/worker.mjs'), compatibilityDate: '2026-10-19', host: '127.0.0.1', port: Number(process.env.PAGE_REVIEW_DEV_PORT || 8798), d1Databases: ['DB'], r2Buckets: ['FILES'], resourcePersistencePath: path.join(root, '.local/state') };
const mf = new Miniflare(runtime.convertV4MiniflareOptions ? runtime.convertV4MiniflareOptions(options) : options);
await mf.ready;
const db = await mf.getD1Database('DB');
for (const statement of (await fs.readFile(path.join(root, 'cloud/migrations/0001.sql'), 'utf8')).split(';').map(x => x.trim()).filter(Boolean)) await db.prepare(statement).run();
const columns=(await db.prepare('PRAGMA table_info(tokens)').all()).results;
for(const statement of (await fs.readFile(path.join(root,'cloud/migrations/0002-login.sql'),'utf8')).split(';').map(x=>x.trim()).filter(Boolean)){if(statement.startsWith('ALTER TABLE')&&columns.some(c=>c.name==='expires_at'))continue;await db.prepare(statement).run();}
const file = path.join(root, '.local/owner.json'); let owner;
try { owner = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; owner = { apiUrl: (await mf.ready).origin, token: 'pr_' + randomBytes(32).toString('hex'), workspaceId: randomUUID() }; await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(owner, null, 2), { mode: 0o600, flag: 'wx' }); }
await db.prepare('INSERT OR IGNORE INTO workspaces(id,created_at) VALUES(?,?)').bind(owner.workspaceId, new Date().toISOString()).run();
await db.prepare("INSERT OR IGNORE INTO tokens(id,workspace_id,token_hash,kind,name,created_at) VALUES(?,?,?,'writer','本机验证',?)").bind(randomUUID(), owner.workspaceId, createHash('sha256').update(owner.token).digest('hex'), new Date().toISOString()).run();
console.log('真实workerd+D1/R2本机服务：' + (await mf.ready).origin + '；拥有者凭证仅保存于.local/owner.json，不输出。');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await mf.dispose(); process.exit(0); });
