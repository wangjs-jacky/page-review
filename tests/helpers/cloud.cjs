const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs'), crypto = require('node:crypto');
const schema = ['0001.sql','0002-login.sql','0003-handoff.sql','0004-terminal-intent.sql','0005-live-pages.sql','0006-cli-read-protocol.sql'].map(f=>fs.readFileSync(require('node:path').join(__dirname,'../../cloud/migrations',f),'utf8')).join('\n');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0e0AAAAASUVORK5CYII=', 'base64');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
async function setup() {
  const { default: worker } = await import('../../cloud/worker.mjs'); const sql = new DatabaseSync(':memory:'); sql.exec(schema);
  const writer = 'pr_' + 'w'.repeat(64), other = 'pr_' + 'o'.repeat(64);
  for (const [workspace, token] of [['workspace-1', writer], ['workspace-2', other]]) { sql.prepare('INSERT INTO workspaces VALUES(?,?)').run(workspace, new Date().toISOString()); sql.prepare('INSERT INTO tokens(id,workspace_id,token_hash,kind,name,created_at) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), workspace, sha(token), 'writer', 'owner', new Date().toISOString()); }
  const db = { prepare(statement) { const execute = (args = []) => { const s = sql.prepare(statement); return { bind(...args) { return execute(args); }, async first() { return s.get(...args) || null; }, async all() { return { results: s.all(...args) }; }, async run() { return { meta: s.run(...args) }; } }; }; return execute(); }, async batch(list) { sql.exec('BEGIN'); try { const results = []; for (const item of list) results.push(await item.run()); sql.exec('COMMIT'); return results; } catch (error) { sql.exec('ROLLBACK'); throw error; } }, withSession() { return this; } };
  const objects = new Map(), env = { DB: db, FILES: { async put(key, bytes) { objects.set(key, new Uint8Array(bytes)); }, async get(key) { return objects.has(key) ? { body: objects.get(key) } : null; } } };
  async function request(path, { token = writer, method = 'GET', data, raw, contentType } = {}) { const headers = {}; if (token) headers.Authorization = 'Bearer ' + token; if (data !== undefined) headers['Content-Type'] = 'application/json'; if (contentType) headers['Content-Type'] = contentType; return worker.fetch(new Request('https://test.invalid' + path, { method, headers, ...(data !== undefined ? { body: JSON.stringify(data) } : raw ? { body: raw } : {}) }), env); }
  const note = { url: 'https://example.com/guide', pageId: 'https://example.com/guide', title: '导航与资料', comment: '导航分类容易找到入口，来源需要保留。', feedback: null, type: 'element', createdAt: new Date().toISOString(), hasImage: false, history: [], anchor: { text: '按任务查找资料' }, viewport: { width: 1000, height: 700 } };
  async function save(id = 'annotation-1', changes = {}, expectedRevision = 0, requestId = crypto.randomUUID(), assets = []) { return request('/v1/annotations/' + id, { method: 'PUT', data: { note: { ...note, ...changes }, assets, requestId, expectedRevision } }); }
  async function upload() { const id = sha(png), r = await request('/v1/uploads/' + id, { method: 'PUT', raw: png, contentType: 'image/png' }); assert.equal(r.status, 200); return { id, role: 'viewport', width: 1, height: 1 }; }
  async function reader() { const r = await request('/v1/connections', { method: 'POST', data: { name: 'Agent' } }); assert.equal(r.status, 201); return r.json(); }
  return { env, sql, objects, request, save, upload, reader, note, writer, other };
}

module.exports={setup,sha,png};
