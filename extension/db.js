(function (root) {
  'use strict';
  let opened;
  const value = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const done = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('保存被中止')); });
  function open() {
    if (!opened) opened = new Promise((resolve, reject) => {
      const request = indexedDB.open('page-review', 2);
      request.onupgradeneeded = event => {
        const db = request.result;
        if (event.oldVersion < 1) { const notes = db.createObjectStore('notes', { keyPath: 'id' }); notes.createIndex('byPage', 'pageId'); db.createObjectStore('assets', { keyPath: 'id' }); }
        if (event.oldVersion < 2) db.createObjectStore('outbox', { keyPath: 'id' });
      };
      request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); opened = null; }; resolve(db); };
      request.onerror = () => { opened = null; reject(request.error); };
    });
    return opened;
  }
  function enqueue(tx, note, workspaceId, kind = 'upsert') {
    workspaceId = workspaceId || note.cloud?.workspaceId;
    if (!workspaceId) return note;
    const previous = note.cloud?.workspaceId === workspaceId ? note.cloud : {};
    note = { ...note, cloud: { workspaceId, remoteRevision: previous.remoteRevision || 0, syncedLocalRevision: previous.syncedLocalRevision || 0, status: 'pending' } };
    tx.objectStore('outbox').put({ id: note.id, requestId: crypto.randomUUID(), workspaceId, remoteRevision: note.cloud.remoteRevision, localRevision: note.revision, kind, note });
    return note;
  }
  async function list(pageId) { const db = await open(), store = db.transaction('notes', 'readonly').objectStore('notes'); const notes = await value(pageId ? store.index('byPage').getAll(pageId) : store.getAll()); return notes.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async function get(id) { const db = await open(); return value(db.transaction('notes', 'readonly').objectStore('notes').get(id)); }
  async function asset(id) { const db = await open(); return value(db.transaction('assets', 'readonly').objectStore('assets').get(id)); }
  async function pending(workspaceId) { const db = await open(); return (await value(db.transaction('outbox', 'readonly').objectStore('outbox').getAll())).filter(x => !workspaceId || x.workspaceId === workspaceId); }
  async function save(note, image, workspaceId) {
    const db = await open(), tx = db.transaction(['notes', 'assets', 'outbox'], 'readwrite'), completion = done(tx);
    const saved = enqueue(tx, note, workspaceId); tx.objectStore('notes').put(saved); if (image) tx.objectStore('assets').put({ ...image, id: note.id }); await completion; return saved;
  }
  async function remove(id, workspaceId) {
    const db = await open(), tx = db.transaction(['notes', 'assets', 'outbox'], 'readwrite'), completion = done(tx);
    const request = tx.objectStore('notes').get(id);
    request.onsuccess = () => { const note = request.result; if (note?.cloud?.workspaceId) enqueue(tx, note, workspaceId || note.cloud.workspaceId, 'delete'); tx.objectStore('notes').delete(id); tx.objectStore('assets').delete(id); };
    await completion;
  }
  async function patch(id, update, workspaceId) {
    const db = await open(), tx = db.transaction(['notes', 'outbox'], 'readwrite'), completion = done(tx); let result, failure;
    const request = tx.objectStore('notes').get(id);
    request.onsuccess = () => { try { if (!request.result) throw new Error('记录不存在，请刷新保存库'); const changed = update(request.result); result = changed ? enqueue(tx, changed, workspaceId) : request.result; if (changed) tx.objectStore('notes').put(result); } catch (error) { failure = error; tx.abort(); } };
    try { await completion; } catch (error) { throw failure || error; } return result;
  }
  async function acknowledge(entry, remote) {
    const db = await open(), tx = db.transaction(['notes', 'outbox'], 'readwrite'), completion = done(tx);
    const notes = tx.objectStore('notes'), outbox = tx.objectStore('outbox');
    outbox.get(entry.id).onsuccess = event => { const current = event.target.result;
      if (current?.requestId === entry.requestId) outbox.delete(entry.id);
      else if (current?.workspaceId === entry.workspaceId && current.remoteRevision === entry.remoteRevision) outbox.put({ ...current, remoteRevision: remote.revision, requestId: crypto.randomUUID() });
    };
    notes.get(entry.id).onsuccess = event => { const note = event.target.result; if (!note || note.cloud?.workspaceId !== entry.workspaceId) return;
      notes.put({ ...note, cloud: { ...note.cloud, remoteRevision: remote.revision, syncedLocalRevision: entry.localRevision, status: note.revision === entry.localRevision ? 'synced' : 'pending' } });
    }; await completion;
  }
  async function markFailure(entry, error) {
    const db = await open(), tx = db.transaction(['notes', 'outbox'], 'readwrite'), completion = done(tx), outbox = tx.objectStore('outbox'), notes = tx.objectStore('notes');
    outbox.get(entry.id).onsuccess = event => { const current = event.target.result; if (current?.requestId !== entry.requestId) return; outbox.put({ ...current, error: error.message, conflict: error.code === 'revision_conflict', remoteConflictRevision: error.remoteRevision }); };
    notes.get(entry.id).onsuccess = event => { const note = event.target.result; if (note?.cloud?.workspaceId === entry.workspaceId) notes.put({ ...note, cloud: { ...note.cloud, status: error.code === 'revision_conflict' ? 'conflict' : 'pending', error: error.message } }); }; await completion;
  }
  async function enroll(workspaceId) { for (const note of await list()) if (note.cloud?.workspaceId !== workspaceId) await patch(note.id, n => ({ ...n }), workspaceId); }
  async function forkConflict(id, workspaceId, remote, remoteImage) {
    const note = await get(id); if (!note) throw new Error('原记录已删除，需先处理云端删除冲突');
    const image = await asset(id), copy = { ...note, id: crypto.randomUUID(), revision: 1, cloud: undefined, createdAt: new Date().toISOString() };
    const database = await open(), tx = database.transaction(['notes', 'assets', 'outbox'], 'readwrite'), completion = done(tx);
    const notes = tx.objectStore('notes'), outbox = tx.objectStore('outbox'), assets = tx.objectStore('assets'); let failure, savedCopy;
    notes.get(id).onsuccess = event => {
      const current = event.target.result;
      if (!current || current.revision !== note.revision || current.cloud?.workspaceId !== workspaceId) { failure = new Error('本机记录又有变化，请重新对照'); tx.abort(); return; }
      savedCopy = enqueue(tx, copy, workspaceId); notes.put(savedCopy); if (image) assets.put({ ...image, id: copy.id });
      outbox.delete(id);
      if (remote) {
        const revision = note.revision + 1;
        notes.put({ ...remote.note, id, revision, cloud: { workspaceId, remoteRevision: remote.revision, syncedLocalRevision: revision, status: 'synced' } });
        if (remoteImage) assets.put({ ...remoteImage, id }); else assets.delete(id);
      } else { notes.delete(id); assets.delete(id); }
    };
    try { await completion; } catch (error) { throw failure || error; } return savedCopy;
  }
  root.PageReviewDB = { open, list, get, asset, save, remove, patch, pending, acknowledge, markFailure, enroll, forkConflict };
})(globalThis);
