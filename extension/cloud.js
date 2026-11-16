(function (root) {
  "use strict";
  root.PageReviewCloudFactory = function ({
    db,
    storage,
    fetcher = fetch,
    apiOrigin = root.PageReviewCloudConfig?.apiOrigin,
    identity = root.chrome?.identity,
  }) {
    let chain = Promise.resolve();
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
        throw new Error(
          "此浏览器保留了另一个账号的资料，请先使用原账号处理，未混合或上传这些记录",
        );
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
    async function login({ migrateExisting = false } = {}) {
      if (
        !apiOrigin ||
        !identity?.launchWebAuthFlow ||
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
      const returned = await identity.launchWebAuthFlow({
        url: start.href,
        interactive: true,
      });
      if (!returned) throw new Error("登录已取消，本机标注仍保留");
      const url = new URL(returned);
      if (
        url.origin + url.pathname !== callback ||
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
      return sync();
    }
    async function upload(c, image) {
      const refs = [];
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
        await request(c, "/v1/uploads/" + id, {
          method: "PUT",
          headers: { "Content-Type": match[1] },
          body: bytes,
        });
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
      return refs;
    }
    async function runBatch() {
      const c = await config();
      if (
        !c ||
        c.authenticationRequired ||
        c.apiUrl !== apiOrigin ||
        (c.expiresAt && Date.parse(c.expiresAt) <= Date.now())
      )
        return status();
      const entries = (await db.pending(c.workspaceId)).slice(0, 100);
      let synced = 0,
        failed = 0;
      for (const entry of entries) {
        if (entry.conflict) {
          failed++;
          continue;
        }
        try {
          const image =
            entry.kind === "delete" ? null : await db.asset(entry.id);
          const assets =
            entry.kind === "delete"
              ? []
              : image
                ? await upload(c, image)
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
          if ([401, 403].includes(error.status) || !error.status) break;
        }
      }
      await storage.set({
        cloudSyncResult: { at: new Date().toISOString(), synced, failed },
      });
      return status();
    }
    // One finite batch per actual save/startup/online/manual event; no timer or query loop.
    function sync() {
      const work = chain.catch(() => {}).then(runBatch);
      chain = work;
      return work;
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
    async function refreshLibrary(filters = {}) {
      const st = await status();
      if (!st.configured) return { complete: true, localOnly: true };
      const c = await config(),
        params = new URLSearchParams();
      for (const key of ["from", "to"])
        if (filters[key]) params.set(key, filters[key]);
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
        await db.importPage(page, items, c.workspaceId, false);
      return { complete: true };
    }
    async function refreshPage(page) {
      const st = await status();
      if (!st.configured) return { complete: true, localOnly: true };
      const c = await config(),
        remote = await request(c, "/v1/pages?url=" + encodeURIComponent(page));
      if (!remote.complete || !Array.isArray(remote.items))
        throw Error("本页历史尚未读取完整");
      await db.importPage(page, remote.items, c.workspaceId);
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
    async function enrollPage(page) {
      const c = await config();
      if (!c) throw Error("请先登录");
      for (const note of await db.list(page)) {
        if (note.cloud?.workspaceId && note.cloud.workspaceId !== c.workspaceId)
          throw Error("本页保留了另一个账号的记录");
        if (!note.cloud?.workspaceId)
          await db.patch(note.id, (n) => ({ ...n }), c.workspaceId);
      }
      return sync();
    }
    async function handoff(page) {
      await sync();
      await chain.catch(() => {});
      const c = await config(),
        st = await status();
      if (!st.configured) throw Error("请先登录账号");
      await refreshPage(page);
      const notes = await db.list(page);
      if (notes.some((n) => n.cloud?.workspaceId !== c.workspaceId))
        throw Error("本页有仅保存在本机的评注，请先同步本页");
      if (
        notes.some(
          (n) =>
            n.cloud?.status !== "synced" ||
            n.cloud.syncedLocalRevision !== n.revision,
        ) ||
        (await db.pending(c.workspaceId)).some((n) => n.note.pageId === page)
      )
        throw Error("本页评注尚未完整同步，请在设置中重试");
      const fixed = await request(c, "/v1/handoffs", {
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
      restoreDeleted,
      refreshLibrary,
      refreshPage,
      asset,
      setup,
      enrollPage,
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
