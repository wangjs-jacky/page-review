(function (root) {
  'use strict';
  let opened;
  function open() {
    if (!opened) opened = new Promise((resolve, reject) => {
      const request = indexedDB.open('page-review', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        const notes = db.createObjectStore('notes', { keyPath: 'id' }); notes.createIndex('byPage', 'pageId');
        db.createObjectStore('assets', { keyPath: 'id' });
      };
      request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); opened = null; }; resolve(db); };
      request.onerror = () => { opened = null; reject(request.error); };
    });
    return opened;
  }
  const value = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const done = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('保存被中止')); });
  async function list(pageId) {
    const db = await open(), tx = db.transaction('notes', 'readonly');
    const notes = pageId ? await value(tx.objectStore('notes').index('byPage').getAll(pageId)) : await value(tx.objectStore('notes').getAll());
    return notes.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async function get(id) { const db = await open(); return value(db.transaction('notes', 'readonly').objectStore('notes').get(id)); }
  async function asset(id) { const db = await open(); return value(db.transaction('assets', 'readonly').objectStore('assets').get(id)); }
  async function save(note, image) {
    const db = await open(), tx = db.transaction(['notes', 'assets'], 'readwrite'), completion = done(tx);
    tx.objectStore('notes').put(note); if (image) tx.objectStore('assets').put({ ...image, id: note.id });
    await completion; return note;
  }
  async function remove(id) {
    const db = await open(), tx = db.transaction(['notes', 'assets'], 'readwrite'), completion = done(tx);
    tx.objectStore('notes').delete(id); tx.objectStore('assets').delete(id); await completion;
  }
  async function patch(id, update) {
    const db = await open(), tx = db.transaction('notes', 'readwrite'), completion = done(tx);
    let result, failure;
    const request = tx.objectStore('notes').get(id);
    request.onsuccess = () => {
      try {
        if (!request.result) throw new Error('记录不存在，请刷新保存库');
        const changed = update(request.result); result = changed || request.result;
        if (changed) tx.objectStore('notes').put(changed);
      } catch (error) { failure = error; tx.abort(); }
    };
    try { await completion; } catch (error) { throw failure || error; }
    return result;
  }
  root.PageReviewDB = { open, list, get, asset, save, remove, patch };
})(globalThis);
