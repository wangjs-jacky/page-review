(function (root) {
  'use strict';
  root.PageReviewCloudFactory = function ({ db, storage, fetcher = fetch, apiOrigin = root.PageReviewCloudConfig?.apiOrigin }) {
    let chain = Promise.resolve();
    const config = async () => (await storage.get('cloudConnection')).cloudConnection || null;
    const workspace = async () => (await config())?.workspaceId;
    const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
    async function request(c, path, options = {}, binary = false) {
      const response = await fetcher(c.apiUrl + path, { ...options, redirect: 'manual', signal: AbortSignal.timeout(20000), headers: { ...options.headers, Authorization: 'Bearer ' + c.token } });
      if (!response.ok) { let error; try { error = await response.json(); } catch { error = { message: '云空间请求失败（' + response.status + '）' }; } const e = new Error(error.message); Object.assign(e, error, { status: response.status }); throw e; }
      return binary ? response : response.json();
    }
    async function status() {
      const c = await config(), pending = await db.pending?.();
      return { configured: Boolean(c), apiUrl: c?.apiUrl || apiOrigin || '', serviceConfigured: Boolean(apiOrigin), workspaceId: c?.workspaceId || null, pending: (pending || []).filter(x => x.workspaceId === c?.workspaceId).map(x => ({ id: x.id, kind: x.kind, conflict: Boolean(x.conflict), error: x.error || '', localComment: x.note.comment, remoteRevision: x.remoteConflictRevision })), last: (await storage.get('cloudSyncResult')).cloudSyncResult || null };
    }
    async function connect({ apiUrl, token, migrateExisting = false }) {
      if (!apiOrigin || new URL(apiUrl).origin !== apiOrigin || new URL(apiUrl).href.replace(/\/$/, '') !== apiOrigin) throw new Error('请使用安装包配置的云空间地址');
      if (!/^pr_[A-Za-z0-9_-]{32,}$/.test(token || '')) throw new Error('写入连接凭证格式无效');
      const proposed = { apiUrl: apiOrigin, token }, who = await request(proposed, '/v1/me');
      if (who.access !== 'writer') throw new Error('插件需要拥有者写入连接，不能使用Agent只读连接');
      const previous = await config(), pending = await db.pending();
      if ((previous && previous.workspaceId !== who.workspaceId) || pending.some(x => x.workspaceId !== who.workspaceId) || (db.list && (await db.list()).some(n => n.cloud?.workspaceId && n.cloud.workspaceId !== who.workspaceId))) throw new Error('存在另一云空间的记录，请先处理原连接，不能自动混合资料');
      await storage.set({ cloudConnection: { ...proposed, workspaceId: who.workspaceId } });
      if (migrateExisting) await db.enroll(who.workspaceId);
      return status();
    }
    async function upload(c, image) {
      const refs = []; if (!image) return refs;
      for (const role of ['viewport', 'crop']) {
        if (!image[role]) continue;
        const match = image[role].match(/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/); if (!match) throw new Error('本机画面格式无效');
        const bytes = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0)), id = await hash(bytes);
        await request(c, '/v1/uploads/' + id, { method: 'PUT', headers: { 'Content-Type': match[1] }, body: bytes });
        const png = match[1] === 'image/png' && bytes.length >= 24 ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
        refs.push({ id, role, width: png ? png.getUint32(16) : image.width, height: png ? png.getUint32(20) : image.height });
      } return refs;
    }
    async function runBatch() {
      const c = await config(); if (!c) return status();
      const entries = (await db.pending(c.workspaceId)).slice(0, 100); let synced = 0, failed = 0;
      for (const entry of entries) {
        if (entry.conflict) { failed++; continue; }
        try {
          const assets = entry.kind === 'delete' ? [] : await upload(c, await db.asset(entry.id));
          const payload = { requestId: entry.requestId, expectedRevision: entry.remoteRevision, ...(entry.kind === 'delete' ? {} : { note: entry.note, assets }) };
          const response = await request(c, '/v1/annotations/' + entry.id, { method: entry.kind === 'delete' ? 'DELETE' : 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
          await db.acknowledge(entry, response); synced++;
        } catch (error) { await db.markFailure(entry, error); failed++; if ([401, 403].includes(error.status) || !error.status) break; }
      }
      await storage.set({ cloudSyncResult: { at: new Date().toISOString(), synced, failed } });
      return status();
    }
    // One finite batch per actual save/startup/online/manual event; no timer or query loop.
    function sync() { const work = chain.catch(() => {}).then(runBatch); chain = work; return work; }
    async function disconnect() { await chain.catch(() => {}); await storage.remove('cloudConnection'); return status(); }
    async function connections() { const c = await config(); if (!c) return { items: [] }; return request(c, '/v1/connections'); }
    async function createConnection(name) { const c = await config(); if (!c) throw new Error('请先连接云空间'); return request(c, '/v1/connections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }); }
    async function revoke(id) { const c = await config(); if (!c) throw new Error('请先连接云空间'); return request(c, '/v1/connections/' + encodeURIComponent(id), { method: 'DELETE' }); }
    async function remote(id) { const c = await config(); if (!c) throw new Error('请先连接云空间'); return request(c, '/v1/annotations/' + encodeURIComponent(id)); }
    async function fork(id) {
      const c = await config(); if (!c) throw new Error('请先连接云空间'); let record;
      try { record = await remote(id); } catch (error) { if (error.status !== 404) throw error; record = null; }
      let image;
      if (record?.assets.length) {
        image = {};
        for (const asset of record.assets) {
          const response = await request(c, '/v1/assets/' + asset.id, {}, true), data = new Uint8Array(await response.arrayBuffer());
          if (data.length > 8000000 || await hash(data) !== asset.id) throw new Error('云端画面校验失败，未替换本机记录');
          let text = ''; for (let i = 0; i < data.length; i += 16384) text += String.fromCharCode(...data.subarray(i, i + 16384));
          image[asset.role] = 'data:' + response.headers.get('content-type') + ';base64,' + btoa(text);
          if (asset.role === 'viewport') { image.width = asset.width; image.height = asset.height; } else { image.cropWidth = asset.width; image.cropHeight = asset.height; }
        }
      }
      await db.forkConflict(id, c.workspaceId, record, image); return sync();
    }
    return { status, workspace, connect, sync, disconnect, connections, createConnection, revoke, remote, fork };
  };
})(globalThis);
