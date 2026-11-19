(function (root) {
  "use strict";
  root.PageReviewCloudFactory = function ({
    db,
    storage,
    fetcher = fetch,
    apiOrigin = root.PageReviewCloudConfig?.apiOrigin,
    identity = root.chrome?.identity,
    tabLogin,
  }) {
    let chain = Promise.resolve();
    let refreshChain = Promise.resolve();
    const failure = (message, code) => Object.assign(new Error(message), { code });
    const config = async () =>
      (await storage.get("cloudConnection")).cloudConnection || null;
    const workspace = async () => (await config())?.workspaceId;
    const hash = async (bytes) =>
      [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
    async function request(c, path, options = {}, binary = false) {
      const response = await fetcher(c.apiUrl + path, {
        ...options,
        redirect: "manual",
        signal: AbortSignal.timeout(20000),
        headers: { ...options.headers, Authorization: "Bearer " + c.token },
      });
      if (!response.ok) {
        if (response.status === 401) {
          const current = await config();
          if (current?.token === c.token)
            await storage.set({
              cloudConnection: { ...current, authenticationRequired: true },
            });
        }
        let error;
        try {
          error = await response.json();
        } catch {
          error = { message: "云空间请求失败（" + response.status + "）" };
        }
        const e = new Error(
          response.status === 401
            ? "登录已失效，请重新登录；本机标注仍保留"
            : error.message,
        );
        Object.assign(e, error, { status: response.status });
        if (response.status === 401) e.code = "login_required";
        throw e;
      }
      return binary ? response : response.json();
    }
    async function status() {
      const c = await config(),
        pending = await db.pending?.();
      return {
        configured: Boolean(
          c &&
            !c.authenticationRequired &&
            c.apiUrl === apiOrigin &&
            (!c.expiresAt || Date.parse(c.expiresAt) > Date.now()),
        ),
        name: c?.name || "",
        apiUrl: apiOrigin || "",
        serviceConfigured: Boolean(apiOrigin),
        workspaceId: c?.workspaceId || null,
        pending: (pending || [])
          .filter((x) => x.workspaceId === c?.workspaceId)
          .map((x) => ({
            id: x.id,
            kind: x.kind,
            conflict: Boolean(x.conflict),
            error: x.error || "",
            localComment: x.note.comment,
            remoteRevision: x.remoteConflictRevision,
          })),
        last: (await storage.get("cloudSyncResult")).cloudSyncResult || null,
      };
    }
    async function connect({
      apiUrl,
      token,
      migrateExisting = false,
      expiresAt,
      name,
    }) {
      if (
        !apiOrigin ||
        new URL(apiUrl).origin !== apiOrigin ||
        new URL(apiUrl).href.replace(/\/$/, "") !== apiOrigin
      )
        throw new Error("请使用安装包配置的云空间地址");
      if (!/^pr_[A-Za-z0-9_-]{32,}$/.test(token || ""))
        throw new Error("写入连接凭证格式无效");
      const proposed = { apiUrl: apiOrigin, token },
        who = await request(proposed, "/v1/me");
      if (who.access !== "writer")
        throw new Error("插件需要拥有者写入连接，不能使用Agent只读连接");
      const pending = await db.pending();
      if (
        pending.some((x) => x.workspaceId !== who.workspaceId) ||
        (db.list &&
          (await db.list()).some(
            (n) =>
              n.cloud?.workspaceId && n.cloud.workspaceId !== who.workspaceId,
          ))
      )
        throw failure("请登录保存这些评注的账号", "account_mismatch");
      await storage.set({
        cloudConnection: {
          ...proposed,
          workspaceId: who.workspaceId,
          ...(expiresAt ? { expiresAt } : {}),
          name: name || who.name || "",
        },
      });
      if (migrateExisting) await db.enroll(who.workspaceId);
      return status();
    }
    async function login({ migrateExisting = false, sourceTab, resume } = {}) {
      if (
        !apiOrigin ||
        (!tabLogin && !identity?.launchWebAuthFlow) ||
        !identity?.getRedirectURL
      )
        throw new Error("此安装包暂不能发起账号登录");
      const b64 = (bytes) =>
        btoa(String.fromCharCode(...new Uint8Array(bytes)))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
      const verifier = b64(crypto.getRandomValues(new Uint8Array(32))),
        state = b64(crypto.getRandomValues(new Uint8Array(32)));
      const challenge = b64(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(verifier),
          ),
        ),
        callback = identity.getRedirectURL("page-review");
      const start = new URL("/auth/start", apiOrigin);
      for (const [key, value] of Object.entries({
        redirect_uri: callback,
        state,
        code_challenge: challenge,
      }))
        start.searchParams.set(key, value);
      if (tabLogin) {
        const proof = b64(crypto.getRandomValues(new Uint8Array(32)));
        const intentChallenge = b64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(proof)));
        return tabLogin.launch(async () => {
          const response = await fetcher(apiOrigin + "/auth/extension/start", {
            method: "POST", redirect: "manual", signal: AbortSignal.timeout(20000),
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callback, state, challenge, intentChallenge,
              workspaceId: (await config())?.workspaceId }),
          });
          if (!response.ok) throw Error("登录服务暂不可用，请重新登录");
          return { ...await response.json(), proof };
        }, { verifier, state, callback, migrateExisting, resume, backgroundSync: true }, sourceTab);
      }
      const returned = await identity.launchWebAuthFlow({
        url: start.href,
        interactive: true,
      });
      return finishLogin({ verifier, state, callback, migrateExisting }, returned);
    }
    async function finishLogin({ verifier, state, callback, migrateExisting, resume, backgroundSync }, returned) {
      if (!returned) throw new Error("登录已取消，本机标注仍保留");
      const url = new URL(returned);
      if (
        url.origin + url.pathname !== callback ||
        url.hash || url.searchParams.size !== 2 ||
        [...url.searchParams.keys()].some(k => !["code", "state"].includes(k)) ||
        url.searchParams.get("state") !== state ||
        !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("code") || "")
      )
        throw new Error("登录回跳校验失败，未保存任何连接");
      const response = await fetcher(apiOrigin + "/auth/exchange", {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(20000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: url.searchParams.get("code"), verifier }),
      });
      if (!response.ok) throw new Error("登录未完成，请重新登录");
      const signed = await response.json();
      try {
        await connect({ apiUrl: apiOrigin, ...signed, migrateExisting });
      } catch (error) {
        await request(
          { apiUrl: apiOrigin, token: signed.token },
          "/v1/session",
          { method: "DELETE" },
        ).catch(() => {});
        throw error;
      }
      // The original copy resumes without waiting for unrelated page uploads.
      if (resume === "copy") return status();
      if (!backgroundSync) return sync();
      sync().catch(() => {});
      return status();
    }
    async function parallel(items, operation) {
      let next = 0, error;
      await Promise.all(Array.from({ length: Math.min(3, items.length) }, async () => {
        while (!error && next < items.length) {
          const item = items[next++];
          try { await operation(item); } catch (e) { error ||= e; }
        }
      }));
      if (error) throw error;
    }
    async function upload(c, image, uploaded) {
      const refs = [], unique = new Map();
      if (!image) return refs;
      for (const role of [
        "viewport",
        "crop",
        "video",
        ...(image.frames || []).map((_, i) => "frame-" + i),
      ]) {
        const data = role.startsWith("frame-")
          ? image.frames[Number(role.slice(6))]?.data
          : image[role];
        if (!data) continue;
        const match = data.match(
          /^data:((?:image\/(?:png|jpeg))|video\/webm);base64,([A-Za-z0-9+/=]+)$/,
        );
        if (!match) throw new Error("本机画面格式无效");
        const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0)),
          id = await hash(bytes);
        if (!uploaded.has(id)) unique.set(id, { data, mime: match[1] });
        const png =
          match[1] === "image/png" && bytes.length >= 24
            ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
            : null;
        refs.push({
          id,
          role,
          width: png ? png.getUint32(16) : image.width,
          height: png ? png.getUint32(20) : image.height,
        });
      }
      await parallel([...unique], async ([id, { data, mime }]) => {
        // Decode only the active uploads; roles share one content-addressed object.
        const match = data.slice(data.indexOf(",") + 1);
        const bytes = Uint8Array.from(atob(match), (c) => c.charCodeAt(0));
        await request(c, "/v1/uploads/" + id, {
          method: "PUT", headers: { "Content-Type": mime }, body: bytes,
        });
        uploaded.add(id);
      });
      return refs;
    }
    async function runBatch({ page, strict = false } = {}) {
      const c = await config();
      if (
        !c ||
        c.authenticationRequired ||
        c.apiUrl !== apiOrigin ||
        (c.expiresAt && Date.parse(c.expiresAt) <= Date.now())
      )
        return status();
      // A page copy consumes one complete, finite snapshot, not a queue poll.
      const pending = await db.pending(c.workspaceId);
      const entries = page
        ? pending.filter((entry) => entry.note.pageId === page)
        : pending.slice(0, 100);
      const uploaded = new Set();
      let synced = 0,
        failed = 0,
        firstError;
      for (const entry of entries) {
        if (entry.conflict) {
          failed++;
          firstError ||= failure("评注有更新，请先处理冲突", "revision_conflict");
          continue;
        }
        try {
          const image =
            entry.kind === "delete" ? null : await db.asset(entry.id);
          if (entry.kind !== "delete" && entry.note.hasImage && !image &&
              !entry.note.cloud?.assets?.length)
            throw failure("附件读取失败", "asset_unavailable");
          const assets =
            entry.kind === "delete"
              ? []
              : image
                ? await upload(c, image, uploaded)
                : entry.note.cloud?.assets || [];
          const payload = {
            requestId: entry.requestId,
            expectedRevision: entry.remoteRevision,
            ...(entry.kind === "delete" ? {} : { note: entry.note, assets }),
          };
          const response = await request(c, "/v1/annotations/" + entry.id, {
            method: entry.kind === "delete" ? "DELETE" : "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          await db.acknowledge(entry, response);
          synced++;
        } catch (error) {
          await db.markFailure(entry, error);
          failed++;
          firstError ||= error;
          if ([401, 403].includes(error.status) || !error.status) break;
        }
      }
      await storage.set({
        cloudSyncResult: { at: new Date().toISOString(), synced, failed },
      });
      if (strict && firstError) throw firstError;
      return status();
    }
    // One finite batch per actual save/startup/online/manual event; no timer or query loop.
    function queued(operation) {
      const work = chain.catch(() => {}).then(operation);
      chain = work;
      return work;
    }
    function sync(options = {}) {
      return queued(() => runBatch(options));
    }
    async function disconnect() {
      await chain.catch(() => {});
      const c = await config();
      if (c && c.apiUrl === apiOrigin)
        await request(c, "/v1/session", { method: "DELETE" });
      await storage.remove("cloudConnection");
      return status();
    }
    async function connections() {
      const c = await config();
      if (!c) return { items: [] };
      return request(c, "/v1/connections");
    }
    async function createConnection(name) {
      const c = await config();
      if (!c) throw new Error("请先登录账号");
      return request(c, "/v1/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
    }
    async function revoke(id) {
      const c = await config();
      if (!c) throw new Error("请先登录账号");
      return request(c, "/v1/connections/" + encodeURIComponent(id), {
        method: "DELETE",
      });
    }
    async function remote(id) {
      const c = await config();
      if (!c) throw new Error("请先登录账号");
      return request(c, "/v1/annotations/" + encodeURIComponent(id));
    }
    async function fork(id) {
      const c = await config();
      if (!c) throw new Error("请先登录账号");
      let record;
      try {
        record = await remote(id);
      } catch (error) {
        if (error.status !== 404) throw error;
        record = null;
      }
      const image = record?.assets.length
        ? await downloadAssets(c, record)
        : undefined;
      await db.forkConflict(id, c.workspaceId, record, image);
      return sync();
    }
    // Page and library reads share one order through their IndexedDB merge.
    // Handoff can enqueue a refresh while holding the separate sync queue.
    function queuedRefresh(operation) {
      const work = refreshChain.then(operation);
      refreshChain = work.catch(() => {});
      return work;
    }
    function refreshLibrary(filters = {}) {
      return queuedRefresh(() => readLibrary(filters));
    }
    async function readLibrary(filters) {
      const st = await status();
      if (!st.configured) return { complete: true, localOnly: true };
      const c = await config(),
        params = new URLSearchParams();
      for (const key of ["from", "to"])
        if (filters[key]) params.set(key, filters[key]);
      const version = await db.refreshVersion(c.workspaceId);
      const remote = await request(c, "/v1/library?" + params);
      if (!remote.complete || !Array.isArray(remote.items))
        throw Error("历史尚未读取完整");
      const pages = new Map();
      for (const n of remote.items) {
        const page = PageReviewCore.pageKey(n.note.url);
        if (!pages.has(page)) pages.set(page, []);
        pages.get(page).push(n);
      }
      for (const [page, items] of pages)
        await db.importPage(page, items, c.workspaceId, version, false);
      return { complete: true };
    }
    function refreshPage(page) {
      return queuedRefresh(() => readPage(page));
    }
    async function readPage(page) {
      const st = await status();
      if (!st.configured) return { complete: true, localOnly: true };
      const c = await config(),
        version = await db.refreshVersion(c.workspaceId),
        remote = await request(c, "/v1/pages?url=" + encodeURIComponent(page));
      if (!remote.complete || !Array.isArray(remote.items))
        throw Error("本页历史尚未读取完整");
      await db.importPage(page, remote.items, c.workspaceId, version);
      return { complete: true };
    }
    async function downloadAssets(c, record) {
      const image = { frames: [], recording: record.note.recording };
      for (const a of record.assets) {
        const r = await request(c, "/v1/assets/" + a.id, {}, true),
          data = new Uint8Array(await r.arrayBuffer());
        if (
          data.length > (a.role === "video" ? 32000000 : 8000000) ||
          (await hash(data)) !== a.id
        )
          throw Error("附件校验失败");
        let text = "";
        for (let i = 0; i < data.length; i += 16384)
          text += String.fromCharCode(...data.subarray(i, i + 16384));
        const value =
          "data:" + r.headers.get("content-type") + ";base64," + btoa(text);
        if (a.role.startsWith("frame-"))
          image.frames[Number(a.role.slice(6))] = {
            at:
              record.note.recording.frames.find((f) => f.role === a.role)?.at ||
              0,
            data: value,
          };
        else image[a.role] = value;
        if (a.role === "viewport") {
          image.width = a.width;
          image.height = a.height;
        }
      }
      return image;
    }
    async function asset(note) {
      const c = await config();
      if (!c || note.cloud?.workspaceId !== c.workspaceId)
        throw Error("请使用原账号读取附件");
      const record = await remote(note.id);
      if (record.revision !== note.cloud.remoteRevision)
        throw Error("这条评注已有更新，请重新打开");
      const image = await downloadAssets(c, record);
      await db.cacheAsset(note.id, image);
      return image;
    }
    async function setup() {
      const current = await status();
      if (!current.configured)
        return { ...current, cliConnections: [], capabilities: null };
      const c = await config();
      try {
        const [caps, connections] = await Promise.all([
          request(c, "/v1/capabilities"),
          request(c, "/v1/cli/connections"),
        ]);
        return {
          ...current,
          capabilities: caps,
          cliConnections: connections.items.filter(
            (x) =>
              !x.revoked_at &&
              (!x.expires_at || Date.parse(x.expires_at) > Date.now()),
          ),
        };
      } catch (error) {
        return {
          ...current,
          capabilities: null,
          cliConnections: [],
          setupError: error.message,
        };
      }
    }
    async function restoreDeleted(id) {
      const c = await config();
      if (!c) throw Error("请先登录");
      const entry = (await db.pending(c.workspaceId)).find(
        (n) => n.id === id && n.kind === "delete",
      );
      if (!entry) throw Error("待删除记录已变化");
      let record;
      try {
        record = await remote(id);
      } catch (e) {
        if (e.status !== 404) throw e;
      }
      await db.restoreDeleted(entry, record);
      return status();
    }
    async function preparePage(page) {
      const c = await config();
      if (!c) throw Error("请先登录");
      const notes = await db.list(page);
      if (notes.some((n) => n.cloud?.workspaceId && n.cloud.workspaceId !== c.workspaceId))
        throw failure("请登录保存这些评注的账号", "account_mismatch");
      for (const note of notes) {
        if (!note.cloud?.workspaceId)
          await db.patch(note.id, (n) => ({ ...n }), c.workspaceId);
      }
      return runBatch({ page, strict: true });
    }
    function handoff(page) {
      return queued(() => prepareHandoff(page));
    }
    async function prepareHandoff(page) {
      const c = await config(),
        st = await status();
      if (!st.configured) throw failure("请登录账号", "login_required");
      await preparePage(page);
      if (!(await status()).configured)
        throw failure("请登录账号", "login_required");
      if ((await config())?.token !== c.token)
        throw failure("账号已变化，请重新复制", "account_mismatch");
      // The handoff endpoint reads the complete current page and validates every
      // local revision itself. A preceding GET adds latency and no stronger check.
      const notes = await db.list(page);
      if (notes.some((n) => n.cloud?.workspaceId !== c.workspaceId))
        throw failure("请登录保存这些评注的账号", "account_mismatch");
      if (
        notes.some(
          (n) =>
            n.cloud?.status !== "synced" ||
            n.cloud.syncedLocalRevision !== n.revision,
        ) ||
        (await db.pending(c.workspaceId)).some((n) => n.note.pageId === page)
      )
        throw failure("评注有变化，请重试", "page_changed");
      let fixed;
      try {
        fixed = await request(c, "/v1/handoffs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pageUrl: page,
          localRecords: notes.map((n) => ({
            id: n.id,
            revision: n.cloud.remoteRevision,
          })),
        }),
      });
      } catch (error) {
        if (error.code !== "not_fully_synced") throw error;
        // A stale revision is an explicit conflict response, not a query loop.
        // Refresh once and let the same Retry action create a fresh snapshot.
        await refreshPage(page);
        throw failure("云端评注已有更新，已刷新，请重试复制", "page_changed");
      }
      return {
        ...fixed,
        text:
          "请读取以下网页评注及附件，按我的评注继续完成任务。先运行：\npage-review read " +
          fixed.id +
          " --api " +
          c.apiUrl +
          "\n读取输出的 context.json，并查看其中的截图、关键帧和录制。请保留我的原话；需要改什么，以我的评注为准。",
      };
    }
    return {
      finishLogin,
      restoreDeleted,
      refreshLibrary,
      refreshPage,
      asset,
      setup,
      handoff,
      status,
      workspace,
      connect,
      login,
      sync,
      disconnect,
      connections,
      createConnection,
      revoke,
      remote,
      fork,
    };
  };
})(globalThis);
