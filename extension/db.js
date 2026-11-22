(function (root) {
  "use strict";
  let opened;
  // Draft IDs are strings. Array keys let sync metadata coexist in the v3
  // database so an older extension still opens it after a rollback.
  const syncStore = "drafts";
  const syncKey = (...parts) => ["cloudSync", ...parts];
  const value = (request) =>
    new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  const done = (tx) =>
    new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("保存被中止"));
    });
  function open() {
    if (!opened)
      opened = new Promise((resolve, reject) => {
        const request = indexedDB.open("page-review", 3);
        request.onupgradeneeded = (event) => {
          const db = request.result;
          if (event.oldVersion < 1) {
            const notes = db.createObjectStore("notes", { keyPath: "id" });
            notes.createIndex("byPage", "pageId");
            db.createObjectStore("assets", { keyPath: "id" });
          }
          if (event.oldVersion < 2)
            db.createObjectStore("outbox", { keyPath: "id" });
          if (event.oldVersion < 3)
            db.createObjectStore("drafts", { keyPath: "id" });
        };
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => {
            db.close();
            opened = null;
          };
          resolve(db);
        };
        request.onerror = () => {
          opened = null;
          reject(request.error);
        };
      });
    return opened;
  }
  function enqueue(tx, note, workspaceId, kind = "upsert") {
    workspaceId = workspaceId || note.cloud?.workspaceId;
    if (!workspaceId) return note;
    if (note.cloud?.workspaceId && note.cloud.workspaceId !== workspaceId)
      throw Object.assign(new Error("请登录保存这些评注的账号"), {
        code: "account_mismatch",
      });
    const previous = note.cloud?.workspaceId === workspaceId ? note.cloud : {};
    note = {
      ...note,
      cloud: {
        workspaceId,
        ...(previous.assets ? { assets: previous.assets } : {}),
        remoteRevision: previous.remoteRevision || 0,
        syncedLocalRevision: previous.syncedLocalRevision || 0,
        status: "pending",
      },
    };
    const outbox = tx.objectStore("outbox"),
      marker = crypto.randomUUID();
    outbox.get(note.id).onsuccess = ({ target }) => {
      const prior = target.result;
      outbox.put({
        id: note.id,
        requestId: marker,
        syncMarkers: [
          ...(prior?.workspaceId === workspaceId ? prior.syncMarkers || [prior.requestId] : []),
          marker,
        ],
        workspaceId,
        remoteRevision: note.cloud.remoteRevision,
        localRevision: note.revision,
        kind,
        note,
      });
    };
    return note;
  }
  async function refreshVersion(workspaceId) {
    const db = await open();
    const state = db.transaction(syncStore, "readonly").objectStore(syncStore);
    return (await value(state.get(syncKey("clock", workspaceId))))?.version ?? 0;
  }
  // Stamp the affected pages and workspace clock in the change's transaction.
  function recordPageChanges(tx, workspaceId, ...pages) {
    const state = tx.objectStore(syncStore);
    const clock = syncKey("clock", workspaceId);
    state.get(clock).onsuccess = (event) => {
      const version = (event.target.result?.version ?? 0) + 1;
      state.put({ id: clock, version });
      for (const page of new Set(pages))
        state.put({ id: syncKey("page", workspaceId, page), version });
    };
  }
  async function list(pageId) {
    const db = await open(),
      store = db.transaction("notes", "readonly").objectStore("notes");
    const notes = await value(
      pageId ? store.index("byPage").getAll(pageId) : store.getAll(),
    );
    return notes.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async function get(id) {
    const db = await open();
    return value(
      db.transaction("notes", "readonly").objectStore("notes").get(id),
    );
  }
  async function asset(id) {
    const db = await open();
    return value(
      db.transaction("assets", "readonly").objectStore("assets").get(id),
    );
  }
  async function pending(workspaceId) {
    const db = await open();
    return (
      await value(
        db.transaction("outbox", "readonly").objectStore("outbox").getAll(),
      )
    ).filter((x) => !workspaceId || x.workspaceId === workspaceId);
  }
  async function save(note, image, workspaceId) {
    const db = await open(),
      tx = db.transaction(["notes", "assets", "outbox"], "readwrite"),
      completion = done(tx);
    const saved = enqueue(tx, note, workspaceId);
    tx.objectStore("notes").put(saved);
    if (image) tx.objectStore("assets").put({ ...image, id: note.id });
    await completion;
    return saved;
  }
  async function remove(id, workspaceId) {
    const db = await open(),
      tx = db.transaction(["notes", "assets", "outbox"], "readwrite"),
      completion = done(tx);
    let failure;
    const request = tx.objectStore("notes").get(id);
    request.onsuccess = () => {
      try {
        const note = request.result;
        if (note?.cloud?.workspaceId)
          enqueue(tx, note, workspaceId || note.cloud.workspaceId, "delete");
        tx.objectStore("notes").delete(id);
        tx.objectStore("assets").delete(id);
      } catch (error) {
        failure = error;
        tx.abort();
      }
    };
    try {
      await completion;
    } catch (error) {
      throw failure || error;
    }
  }
  async function patch(id, update, workspaceId, { localOnly = false } = {}) {
    const db = await open(),
      tx = db.transaction(["notes", "outbox"], "readwrite"),
      completion = done(tx);
    let result, failure;
    const request = tx.objectStore("notes").get(id);
    request.onsuccess = () => {
      try {
        if (!request.result) throw new Error("记录不存在，请刷新保存库");
        const changed = update(request.result);
        result = changed
          ? localOnly
            ? changed
            : enqueue(tx, changed, workspaceId)
          : request.result;
        if (changed) tx.objectStore("notes").put(result);
      } catch (error) {
        failure = error;
        tx.abort();
      }
    };
    try {
      await completion;
    } catch (error) {
      throw failure || error;
    }
    return result;
  }
  async function acknowledge(entry, remote) {
    const db = await open(),
      tx = db.transaction(["notes", "outbox", syncStore], "readwrite"),
      completion = done(tx);
    const notes = tx.objectStore("notes"),
      outbox = tx.objectStore("outbox");
    recordPageChanges(tx, entry.workspaceId, entry.note.pageId);
    // A successful server deletion permanently retires that annotation ID.
    if (entry.kind === "delete")
      tx.objectStore(syncStore).put({
        id: syncKey("deleted", entry.workspaceId, entry.id),
      });
    outbox.get(entry.id).onsuccess = (event) => {
      const current = event.target.result;
      if (current?.requestId === entry.requestId) outbox.delete(entry.id);
      else if (
        current?.workspaceId === entry.workspaceId &&
        current.remoteRevision === entry.remoteRevision
      )
        outbox.put({
          ...current,
          remoteRevision: remote.revision,
          syncMarkers: (current.syncMarkers || [current.requestId]).filter(
            (marker) => !(entry.syncMarkers || [entry.requestId]).includes(marker),
          ),
          requestId: crypto.randomUUID(),
        });
    };
    notes.get(entry.id).onsuccess = (event) => {
      const note = event.target.result;
      if (!note || note.cloud?.workspaceId !== entry.workspaceId) return;
      notes.put({
        ...note,
        cloud: {
          ...note.cloud,
          remoteRevision: remote.revision,
          syncedLocalRevision: entry.localRevision,
          status: note.revision === entry.localRevision ? "synced" : "pending",
        },
      });
    };
    await completion;
  }
  async function markFailure(entry, error) {
    const db = await open(),
      tx = db.transaction(["notes", "outbox"], "readwrite"),
      completion = done(tx),
      outbox = tx.objectStore("outbox"),
      notes = tx.objectStore("notes");
    outbox.get(entry.id).onsuccess = (event) => {
      const current = event.target.result;
      if (current?.requestId !== entry.requestId) return;
      outbox.put({
        ...current,
        error: error.message,
        conflict: error.code === "revision_conflict",
        remoteConflictRevision: error.remoteRevision,
      });
    };
    notes.get(entry.id).onsuccess = (event) => {
      const note = event.target.result;
      if (note?.cloud?.workspaceId === entry.workspaceId)
        notes.put({
          ...note,
          cloud: {
            ...note.cloud,
            status: error.code === "revision_conflict" ? "conflict" : "pending",
            error: error.message,
          },
        });
    };
    await completion;
  }
  async function enroll(workspaceId) {
    for (const note of await list())
      if (!note.cloud?.workspaceId)
        await patch(note.id, (n) => ({ ...n }), workspaceId);
  }
  async function forkConflict(id, workspaceId, remote, remoteImage) {
    const note = await get(id);
    if (!note) throw new Error("原记录已删除，需先处理云端删除冲突");
    const image = await asset(id),
      copy = {
        ...note,
        id: crypto.randomUUID(),
        revision: 1,
        cloud: undefined,
        createdAt: new Date().toISOString(),
      };
    const database = await open(),
      tx = database.transaction(
        ["notes", "assets", "outbox", syncStore],
        "readwrite",
      ),
      completion = done(tx);
    const notes = tx.objectStore("notes"),
      outbox = tx.objectStore("outbox"),
      assets = tx.objectStore("assets");
    let failure, savedCopy;
    notes.get(id).onsuccess = (event) => {
      const current = event.target.result;
      if (
        !current ||
        current.revision !== note.revision ||
        current.cloud?.workspaceId !== workspaceId
      ) {
        failure = new Error("本机记录又有变化，请重新对照");
        tx.abort();
        return;
      }
      savedCopy = enqueue(tx, copy, workspaceId);
      notes.put(savedCopy);
      if (image) assets.put({ ...image, id: copy.id });
      outbox.delete(id);
      recordPageChanges(
        tx,
        workspaceId,
        current.pageId,
        remote?.note.pageId || current.pageId,
      );
      if (remote) {
        const revision = note.revision + 1;
        notes.put({
          ...remote.note,
          id,
          revision,
          cloud: {
            workspaceId,
            remoteRevision: remote.revision,
            syncedLocalRevision: revision,
            status: "synced",
          },
        });
        if (remoteImage) assets.put({ ...remoteImage, id });
        else assets.delete(id);
      } else {
        notes.delete(id);
        assets.delete(id);
      }
    };
    try {
      await completion;
    } catch (error) {
      throw failure || error;
    }
    return savedCopy;
  }
  async function restoreDeleted(entry, remote) {
    const db = await open(),
      tx = db.transaction(["notes", "outbox", syncStore], "readwrite"),
      completion = done(tx),
      outbox = tx.objectStore("outbox");
    let failure;
    outbox.get(entry.id).onsuccess = (e) => {
      const current = e.target.result;
      if (current?.requestId !== entry.requestId || current.kind !== "delete") {
        failure = Error("删除状态已变化，请刷新");
        tx.abort();
        return;
      }
      outbox.delete(entry.id);
      recordPageChanges(
        tx,
        entry.workspaceId,
        current.note.pageId,
        remote?.note.pageId || current.note.pageId,
      );
      if (remote)
        tx.objectStore("notes").put({
          ...remote.note,
          id: remote.id,
          revision: 1,
          cloud: {
            workspaceId: entry.workspaceId,
            remoteRevision: remote.revision,
            syncedLocalRevision: 1,
            status: "synced",
            assets: remote.assets,
          },
        });
    };
    try {
      await completion;
    } catch (e) {
      throw failure || e;
    }
  }
  async function importPage(page, items, workspaceId, version, prune = true) {
    const db = await open(),
      tx = db.transaction(
        ["notes", "assets", "outbox", syncStore],
        "readwrite",
      ),
      completion = done(tx),
      notes = tx.objectStore("notes"),
      assets = tx.objectStore("assets"),
      outbox = tx.objectStore("outbox"),
      state = tx.objectStore(syncStore);
    const merged = Promise.all([
      value(state.get(syncKey("page", workspaceId, page))),
      value(notes.index("byPage").getAll(page)),
      value(outbox.getAllKeys()),
    ]).then(async ([pageState, current, queued]) => {
      const unchanged = (pageState?.version ?? 0) <= version,
        map = new Map(current.map((n) => [n.id, n])),
        pending = new Set(queued),
        supplied = new Set(items.map((n) => n.id));
      const isSynced = (n) =>
        n.cloud?.workspaceId === workspaceId &&
        n.cloud.status === "synced" &&
        n.cloud.syncedLocalRevision === n.revision;
      // A revision can safely advance, but presence and absence alone cannot
      // be ordered if another read or local acknowledgement changed the page.
      const candidates = await Promise.all(
        items.map(async (remote) => {
          if (pending.has(remote.id)) return;
          // The ID is global in this database even if its remote page changed.
          const n = map.get(remote.id) || (await value(notes.get(remote.id)));
          if (n) {
            if (!isSynced(n) || !(remote.revision > n.cloud.remoteRevision)) return;
          } else if (
            !unchanged ||
            (await value(state.get(syncKey("deleted", workspaceId, remote.id))))
          ) {
            return;
          }
          return { remote, n };
        }),
      );
      const updates = candidates.filter(Boolean);
      const touched = new Set([page]);
      for (const { remote, n } of updates) {
        if (n) touched.add(n.pageId);
        const revision = (n?.revision || 0) + 1;
        notes.put({
          ...remote.note,
          id: remote.id,
          pageId: page,
          revision,
          cloud: {
            workspaceId,
            remoteRevision: remote.revision,
            syncedLocalRevision: revision,
            status: "synced",
            assets: remote.assets,
          },
        });
        assets.delete(remote.id);
      }
      if (prune && unchanged)
        for (const n of current) {
          if (!isSynced(n) || pending.has(n.id) || supplied.has(n.id)) continue;
          notes.delete(n.id);
          assets.delete(n.id);
        }
      if (unchanged || updates.length) recordPageChanges(tx, workspaceId, ...touched);
    });
    try {
      await Promise.all([merged, completion]);
    } catch (error) {
      // A failed merge must never leave only part of the snapshot applied.
      try {
        tx.abort();
      } catch {}
      throw error;
    }
  }
  async function cacheAsset(id, image) {
    const db = await open(),
      tx = db.transaction("assets", "readwrite"),
      completion = done(tx);
    tx.objectStore("assets").put({ ...image, id });
    await completion;
  }
  async function draft(id) {
    if (typeof id !== "string") return;
    const db = await open();
    return value(
      db.transaction("drafts", "readonly").objectStore("drafts").get(id),
    );
  }
  async function putDraft(record) {
    if (typeof record?.id !== "string") throw new TypeError("录制草稿标识无效");
    const db = await open(),
      tx = db.transaction("drafts", "readwrite"),
      completion = done(tx);
    tx.objectStore("drafts").put(record);
    await completion;
  }
  async function deleteDraft(id) {
    if (typeof id !== "string") return;
    const db = await open(),
      tx = db.transaction("drafts", "readwrite"),
      completion = done(tx);
    tx.objectStore("drafts").delete(id);
    await completion;
  }
  root.PageReviewDB = {
    restoreDeleted,
    refreshVersion,
    importPage,
    cacheAsset,
    draft,
    putDraft,
    deleteDraft,
    open,
    list,
    get,
    asset,
    save,
    remove,
    patch,
    pending,
    acknowledge,
    markFailure,
    enroll,
    forkConflict,
  };
})(globalThis);
