import { loginRoute } from './login.mjs';
// Personal cloud library. No model execution, timers, scheduled tasks or public asset bucket.
const ID = /^[a-zA-Z0-9-]{8,80}$/, SHA = /^[a-f0-9]{64}$/;
const MAX_JSON = 700_000, MAX_IMAGE = 8_000_000;
const encoder = new TextEncoder();
export async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? encoder.encode(value) : value))].map(x => x.toString(16).padStart(2, '0')).join('');
}
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
class Failure extends Error { constructor(status, code, message, extra = {}) { super(message); Object.assign(this, { status, code, extra }); } }
function requireThat(ok, status, code, message) { if (!ok) throw new Failure(status, code, message); }
async function bytes(request, maximum) {
  requireThat(Number(request.headers.get('content-length') || 0) <= maximum, 413, 'too_large', '内容过大');
  const reader = request.body?.getReader(); if (!reader) return new Uint8Array();
  const chunks = []; let length = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength;
    if (length > maximum) { await reader.cancel(); throw new Failure(413, 'too_large', '内容过大'); } chunks.push(value); }
  const output = new Uint8Array(length); let offset = 0; for (const part of chunks) { output.set(part, offset); offset += part.length; } return output;
}
async function body(request) {
  requireThat(request.headers.get('content-type')?.split(';')[0] === 'application/json', 415, 'json_required', '需要JSON请求');
  try { return JSON.parse(new TextDecoder().decode(await bytes(request, MAX_JSON))); } catch (error) { if (error instanceof Failure) throw error; throw new Failure(400, 'invalid_json', 'JSON无效'); }
}
const result = x => x.results || [];
async function identity(request, db) {
  const token = request.headers.get('authorization')?.match(/^Bearer (pr_[A-Za-z0-9_-]{32,})$/)?.[1];
  requireThat(token, 401, 'unauthorized', '连接无效或已撤销');
  const who = await db.prepare('SELECT id,workspace_id,kind FROM tokens WHERE token_hash=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)').bind(await digest(token), new Date().toISOString()).first();
  requireThat(who, 401, 'unauthorized', '连接无效或已撤销'); return who;
}
function validateNote(note, assets) {
  requireThat(note && typeof note === 'object' && !Array.isArray(note), 400, 'invalid_note', '评注无效');
  requireThat(typeof note.comment === 'string' && note.comment.length <= 12000 && (note.comment.trim() || ['positive', 'negative'].includes(note.feedback)), 400, 'invalid_comment', '请保存评论或明确赞踩');
  requireThat([null, 'positive', 'negative'].includes(note.feedback), 400, 'invalid_feedback', '反馈无效');
  let url; try { url = new URL(note.url); } catch { throw new Failure(400, 'invalid_url', '网页地址无效'); }
  requireThat(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password, 400, 'invalid_url', '仅支持普通网页来源');
  requireThat(['element', 'region', 'page'].includes(note.type), 400, 'invalid_type', '标注类型无效');
  requireThat(Array.isArray(assets) && assets.length <= 2 && new Set(assets.map(a => a.role)).size === assets.length && assets.every(a => SHA.test(a.id) && ['viewport', 'crop'].includes(a.role) && Number.isInteger(a.width) && a.width > 0 && Number.isInteger(a.height) && a.height > 0), 400, 'invalid_assets', '画面引用无效');
  requireThat(!note.hasImage || assets.some(a => a.role === 'viewport'), 400, 'image_missing', '原画面尚未上传');
  requireThat(note.hasImage || !assets.length, 400, 'invalid_assets', '无图记录不能携带未声明画面');
  // Copy known fields only. Secrets, client workspace ids and arbitrary configuration never enter context.
  const keys = ['url', 'pageId', 'title', 'comment', 'feedback', 'type', 'label', 'anchor', 'region', 'pageSignature', 'state', 'viewport', 'capturedAt', 'createdAt', 'updatedAt', 'originalComment', 'history', 'outcome', 'originalAnchor', 'reboundAt', 'hasImage', 'screenshotError'];
  const clean = Object.fromEntries(keys.filter(k => Object.hasOwn(note, k)).map(k => [k, note[k]]));
  return { note: clean, assets, domain: url.hostname };
}
function summary(row) {
  const { note, assets } = JSON.parse(row.body_json);
  return { id: row.id, revision: row.revision, source: { url: note.url, title: note.title || '' }, comment: note.comment, feedback: note.feedback,
    capturedAt: note.capturedAt || note.createdAt, updatedAt: row.updated_at, hasImage: assets.length > 0, contextPath: `/v1/annotations/${row.id}/context` };
}
function context(row) {
  const { note, assets } = JSON.parse(row.body_json);
  return { ...summary(row), quotedText: String(note.anchor?.text || ''), anchorStatus: 'captured_only',
    capture: { status: assets.length ? 'ready' : 'explicitly_without_image', missingImageReason: assets.length ? null : note.screenshotError || '用户明确无图保存', viewport: note.viewport || {}, region: note.region || null, interactionState: note.state || {} },
    assets: assets.map(a => ({ ...a, sha256: a.id, path: `/v1/assets/${a.id}` })),
    history: note.history || [], outcome: note.outcome || { status: 'pending', reason: '' }, originalComment: note.originalComment ?? note.comment };
}
async function commit(request, db, who, id, deleting) {
  const input = await body(request), { expectedRevision, requestId } = input;
  requireThat(Number.isSafeInteger(expectedRevision) && expectedRevision >= 0 && ID.test(requestId), 400, 'invalid_revision', '需要修订和幂等请求ID');
  const clean = deleting ? null : validateNote(input.note, input.assets), workspace = who.workspace_id;
  if (clean) for (const asset of clean.assets) requireThat(await db.prepare('SELECT id FROM assets WHERE workspace_id=? AND id=?').bind(workspace, asset.id).first(), 409, 'asset_not_ready', '画面尚未就绪');
  const hash = await digest(JSON.stringify({ id, deleting, expectedRevision, clean }));
  const previous = await db.prepare('SELECT payload_hash,response_json FROM operations WHERE workspace_id=? AND request_id=?').bind(workspace, requestId).first();
  if (previous) { requireThat(previous.payload_hash === hash, 409, 'request_reused', '请求ID不能用于不同内容'); return json(JSON.parse(previous.response_json)); }
  const now = new Date().toISOString(), revision = expectedRevision + 1, response = { id, revision, deleted: deleting, updatedAt: now };
  const missingOperation = 'NOT EXISTS(SELECT 1 FROM operations WHERE workspace_id=? AND request_id=?)';
  const statements = [];
  if (deleting) {
    if (expectedRevision === 0) statements.push(db.prepare(`INSERT INTO annotations (workspace_id,id,revision,body_json,search_text,domain,feedback,updated_at,deleted_at,mutation_id) SELECT ?,?,1,'{}','','',NULL,?,?,? WHERE ${missingOperation} ON CONFLICT(workspace_id,id) DO NOTHING`).bind(workspace, id, now, now, requestId, workspace, requestId));
    else statements.push(db.prepare(`UPDATE annotations SET deleted_at=?,updated_at=?,revision=?,mutation_id=? WHERE workspace_id=? AND id=? AND revision=? AND deleted_at IS NULL AND ${missingOperation}`).bind(now, now, revision, requestId, workspace, id, expectedRevision, workspace, requestId));
  } else {
    const stored = JSON.stringify({ note: clean.note, assets: clean.assets });
    const search = [clean.note.title, clean.note.url, clean.note.comment, clean.note.anchor?.text].join(' ').toLowerCase();
    if (expectedRevision === 0) statements.push(db.prepare(`INSERT INTO annotations (workspace_id,id,revision,body_json,search_text,domain,feedback,updated_at,mutation_id) SELECT ?,?,?,?,?,?,?,?,? WHERE ${missingOperation} ON CONFLICT(workspace_id,id) DO NOTHING`).bind(workspace, id, revision, stored, search, clean.domain, clean.note.feedback, now, requestId, workspace, requestId));
    else statements.push(db.prepare(`UPDATE annotations SET revision=?,body_json=?,search_text=?,domain=?,feedback=?,updated_at=?,mutation_id=? WHERE workspace_id=? AND id=? AND revision=? AND deleted_at IS NULL AND ${missingOperation}`).bind(revision, stored, search, clean.domain, clean.note.feedback, now, requestId, workspace, id, expectedRevision, workspace, requestId));
  }
  statements.push(db.prepare('INSERT OR IGNORE INTO operations (workspace_id,request_id,payload_hash,response_json,created_at) SELECT ?,?,?,?,? FROM annotations WHERE workspace_id=? AND id=? AND mutation_id=?').bind(workspace, requestId, hash, JSON.stringify(response), now, workspace, id, requestId));
  await db.batch(statements);
  const saved = await db.prepare('SELECT payload_hash,response_json FROM operations WHERE workspace_id=? AND request_id=?').bind(workspace, requestId).first();
  if (saved) { requireThat(saved.payload_hash === hash, 409, 'request_reused', '请求ID已使用'); return json(JSON.parse(saved.response_json)); }
  const remote = await db.prepare('SELECT revision,deleted_at FROM annotations WHERE workspace_id=? AND id=?').bind(workspace, id).first();
  throw new Failure(409, 'revision_conflict', '云端存在其他修订；本机内容已保留，请处理冲突', { remoteRevision: remote?.revision ?? 0, deleted: Boolean(remote?.deleted_at) });
}
async function route(request, env) {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  if (path === '/health' && method === 'GET') return json({ service: 'page-review', version: '0.3.0' });
  const login = await loginRoute(request, env); if (login) return login;
  requireThat(path.startsWith('/v1/'), 404, 'not_found', '接口不存在');
  const db = env.DB.withSession ? env.DB.withSession('first-primary') : env.DB, who = await identity(request, db);
  if (method !== 'GET') requireThat(who.kind === 'writer', 403, 'read_only', 'Agent连接仅允许读取');
  if (path === '/v1/me' && method === 'GET') { const user = await db.prepare('SELECT name FROM users WHERE workspace_id=?').bind(who.workspace_id).first(); return json({ workspaceId: who.workspace_id, access: who.kind, name: user?.name || null }); }
  if (path === '/v1/session' && method === 'DELETE') { await db.prepare("UPDATE tokens SET revoked_at=? WHERE id=? AND kind='writer'").bind(new Date().toISOString(), who.id).run(); return json({ signedOut: true }); }
  if (path === '/v1/connections') {
    requireThat(who.kind === 'writer', 403, 'owner_required', '只有资料库拥有者可管理连接');
    if (method === 'GET') return json({ items: result(await db.prepare("SELECT id,name,created_at,revoked_at,last_read_at FROM tokens WHERE workspace_id=? AND kind='reader' ORDER BY created_at DESC").bind(who.workspace_id).all()) });
    if (method === 'POST') {
      const value = await body(request), name = String(value.name || '我的 Agent').trim(); requireThat(name.length > 0 && name.length <= 80, 400, 'invalid_name', '连接名称过长');
      const id = crypto.randomUUID(), raw = 'pr_' + [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2, '0')).join(''), createdAt = new Date().toISOString();
      await db.prepare("INSERT INTO tokens (id,workspace_id,token_hash,kind,name,created_at) VALUES(?,?,?,'reader',?,?)").bind(id, who.workspace_id, await digest(raw), name, createdAt).run();
      return json({ id, token: raw, createdAt, access: 'reader' }, 201);
    }
  }
  const connection = path.match(/^\/v1\/connections\/([a-zA-Z0-9-]{8,80})$/);
  if (connection && method === 'DELETE') {
    const id = connection[1]; await db.prepare("UPDATE tokens SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND workspace_id=? AND kind='reader'").bind(new Date().toISOString(), id, who.workspace_id).run(); return json({ revoked: true });
  }
  const upload = path.match(/^\/v1\/uploads\/([a-f0-9]{64})$/);
  if (upload && method === 'PUT') {
    const mime = request.headers.get('content-type')?.split(';')[0]; requireThat(['image/png', 'image/jpeg'].includes(mime), 415, 'image_required', '仅支持PNG/JPEG');
    const data = await bytes(request, MAX_IMAGE), hash = await digest(data), png = data[0] === 137 && data[1] === 80 && data[2] === 78 && data[3] === 71;
    requireThat(data.length > 8 && (mime === 'image/png' ? png : data[0] === 255 && data[1] === 216 && data[2] === 255), 400, 'invalid_image', '图片类型与字节不符');
    requireThat(hash === upload[1], 400, 'hash_mismatch', '图片摘要不符');
    const key = `${who.workspace_id}/${hash}`;
    await env.FILES.put(key, data, { sha256: hash, httpMetadata: { contentType: mime } });
    await db.prepare('INSERT OR IGNORE INTO assets(workspace_id,id,object_key,mime,byte_length,created_at) VALUES(?,?,?,?,?,?)').bind(who.workspace_id, hash, key, mime, data.length, new Date().toISOString()).run();
    return json({ id: hash, bytes: data.length });
  }
  if (path === '/v1/annotations' && method === 'GET') {
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') || 20))); requireThat(Number.isInteger(limit), 400, 'invalid_limit', '分页大小无效');
    const q = (url.searchParams.get('q') || '').toLowerCase(); requireThat(q.length <= 300, 400, 'invalid_query', '检索词过长');
    let cursor; try { cursor = url.searchParams.has('cursor') ? JSON.parse(atob(url.searchParams.get('cursor'))) : null; } catch { throw new Failure(400, 'invalid_cursor', '分页游标无效'); }
    requireThat(!cursor || Array.isArray(cursor) && cursor.length === 2 && cursor.every(x => typeof x === 'string'), 400, 'invalid_cursor', '分页游标无效');
    const where = ['workspace_id=?', 'deleted_at IS NULL'], args = [who.workspace_id];
    if (q) { where.push('instr(search_text,?)>0'); args.push(q); }
    if (url.searchParams.has('domain')) { where.push('domain=?'); args.push(url.searchParams.get('domain')); }
    const feedback = url.searchParams.get('feedback'); if (feedback) { requireThat(['positive', 'negative', 'unrated'].includes(feedback), 400, 'invalid_feedback', '筛选无效'); where.push(feedback === 'unrated' ? 'feedback IS NULL' : 'feedback=?'); if (feedback !== 'unrated') args.push(feedback); }
    if (cursor) { where.push('(updated_at<? OR (updated_at=? AND id<?))'); args.push(cursor[0], cursor[0], cursor[1]); }
    const rows = result(await db.prepare(`SELECT * FROM annotations WHERE ${where.join(' AND ')} ORDER BY updated_at DESC,id DESC LIMIT ?`).bind(...args, limit + 1).all()), more = rows.length > limit;
    const selected = rows.slice(0, limit), last = selected.at(-1);
    if (who.kind === 'reader') await db.prepare('UPDATE tokens SET last_read_at=? WHERE id=? AND revoked_at IS NULL').bind(new Date().toISOString(), who.id).run();
    return json({ items: selected.map(summary), nextCursor: more ? btoa(JSON.stringify([last.updated_at, last.id])) : null });
  }
  const annotation = path.match(/^\/v1\/annotations\/([a-zA-Z0-9-]{8,80})(\/context)?$/);
  if (annotation) {
    const id = annotation[1];
    if (method === 'GET') {
      const row = await db.prepare('SELECT * FROM annotations WHERE workspace_id=? AND id=? AND deleted_at IS NULL').bind(who.workspace_id, id).first(); requireThat(row, 404, 'not_found', '记录不存在或不在授权范围');
      if (annotation[2]) return json(context(row));
      requireThat(who.kind === 'writer', 403, 'context_required', '请使用只读上下文接口'); return json({ id, revision: row.revision, note: JSON.parse(row.body_json).note, assets: JSON.parse(row.body_json).assets });
    }
    if (!annotation[2] && ['PUT', 'DELETE'].includes(method)) return commit(request, db, who, id, method === 'DELETE');
  }
  const asset = path.match(/^\/v1\/assets\/([a-f0-9]{64})$/);
  if (asset && method === 'GET') {
    // A staged upload is not readable, even with a valid token. Tombstones also hide attachments.
    const row = await db.prepare("SELECT a.* FROM assets a WHERE a.workspace_id=? AND a.id=? AND EXISTS(SELECT 1 FROM annotations n,json_each(n.body_json,'$.assets') j WHERE n.workspace_id=a.workspace_id AND n.deleted_at IS NULL AND json_extract(j.value,'$.id')=a.id)").bind(who.workspace_id, asset[1]).first();
    requireThat(row, 404, 'not_found', '画面不存在或不在授权范围'); const object = await env.FILES.get(row.object_key); requireThat(object, 404, 'not_found', '原画面缺失');
    return new Response(object.body, { headers: { 'content-type': row.mime, 'content-length': String(row.byte_length), 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
  }
  throw new Failure(404, 'not_found', '接口不存在');
}
export default { async fetch(request, env) {
  try { return await route(request, env); }
  catch (error) { if (error instanceof Failure) return json({ code: error.code, message: error.message, ...error.extra }, error.status); return json({ code: 'service_error', message: '云空间暂时不可用；本机资料仍保留' }, 500); }
} };
