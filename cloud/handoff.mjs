// Fixed references are identifiers, never bearer credentials. All reads retain workspace authorization.
export function pageKey(value) {
  const u = new URL(value);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
    throw Error("网页地址无效");
  for (const k of [...u.searchParams.keys()])
    if (/^(utm_|fbclid$|gclid$|msclkid$)/i.test(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  if (!/^#(?:\/|!)/.test(u.hash)) u.hash = "";
  return u.href;
}
// Encode a workspace-scoped snapshot digest as a UUIDv8 for existing readers.
async function snapshotId(workspace, page, records) {
  const input = new TextEncoder().encode(JSON.stringify([
    "page-review-handoff-v1", workspace, page, records,
  ]));
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", input), 0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16),
    hex.slice(16, 20), hex.slice(20)].join("-");
}
export async function handoffRoute(
  request,
  env,
  db,
  who,
  { body, json, requireThat, context },
) {
  const u = new URL(request.url),
    path = u.pathname,
    method = request.method,
    workspace = who.workspace_id;
  if (path === "/v1/library" && method === "GET") {
    requireThat(
      who.kind === "writer",
      403,
      "owner_required",
      "仅拥有者可读取历史",
    );
    const args = [workspace],
      where = ["workspace_id=?", "deleted_at IS NULL"];
    for (const [key, op] of [
      ["from", ">="],
      ["to", "<="],
    ])
      if (u.searchParams.has(key)) {
        const date = u.searchParams.get(key);
        requireThat(
          Number.isFinite(Date.parse(date)),
          400,
          "invalid_date",
          "时间无效",
        );
        where.push("json_extract(body_json,'$.note.createdAt')" + op + "?");
        args.push(new Date(date).toISOString());
      }
    const rows =
      (
        await db
          .prepare(
            "SELECT * FROM annotations WHERE " +
              where.join(" AND ") +
              " ORDER BY updated_at DESC,id DESC LIMIT 501",
          )
          .bind(...args)
          .all()
      ).results || [];
    requireThat(
      rows.length <= 500,
      413,
      "history_too_large",
      "历史较多，请按时间缩小范围",
    );
    return json({
      complete: true,
      items: rows.map((row) => ({
        id: row.id,
        revision: row.revision,
        ...JSON.parse(row.body_json),
      })),
    });
  }
  if (path === "/v1/pages" && method === "GET") {
    requireThat(
      who.kind === "writer",
      403,
      "owner_required",
      "仅拥有者可读取网页记录",
    );
    let page;
    try {
      page = pageKey(u.searchParams.get("url"));
    } catch {
      requireThat(false, 400, "invalid_page", "网页地址无效");
    }
    const rows =
      (
        await db
          .prepare(
            "SELECT * FROM annotations WHERE workspace_id=? AND deleted_at IS NULL AND json_extract(body_json,'$.note.pageId')=? ORDER BY updated_at DESC,id DESC LIMIT 501",
          )
          .bind(workspace, page)
          .all()
      ).results || [];
    requireThat(
      rows.length <= 500,
      413,
      "page_too_large",
      "本页超过500条，未返回部分记录",
    );
    return json({
      complete: true,
      items: rows.map((row) => ({
        id: row.id,
        revision: row.revision,
        ...JSON.parse(row.body_json),
      })),
    });
  }
  if (path === "/v1/cli/confirm" && method === "POST") {
    requireThat(
      who.kind === "reader",
      403,
      "reader_required",
      "终端需要独立只读授权",
    );
    const input = await body(request),
      name = String(input.deviceName || "我的终端")
        .trim()
        .slice(0, 80),
      at = new Date().toISOString();
    requireThat(name, 400, "invalid_name", "执行机器名称无效");
    await db
      .prepare(
        "INSERT INTO cli_connections(token_id,workspace_id,device_name,verified_at) VALUES(?,?,?,?) ON CONFLICT(token_id) DO UPDATE SET device_name=excluded.device_name,verified_at=excluded.verified_at",
      )
      .bind(who.id, workspace, name, at)
      .run();
    return json({
      connected: true,
      access: "reader",
      deviceName: name,
      verifiedAt: at,
    });
  }
  if (path === "/v1/cli/connections" && method === "GET") {
    requireThat(
      who.kind === "writer",
      403,
      "owner_required",
      "仅拥有者可查看终端连接",
    );
    const rows = await db
      .prepare(
        "SELECT c.token_id AS id,c.device_name,c.verified_at,t.revoked_at,t.expires_at FROM cli_connections c JOIN tokens t ON t.id=c.token_id WHERE c.workspace_id=? ORDER BY c.verified_at DESC",
      )
      .bind(workspace)
      .all();
    return json({ items: rows.results || [] });
  }
  if (path === "/v1/handoffs" && method === "POST") {
    requireThat(
      who.kind === "writer",
      403,
      "owner_required",
      "仅拥有者可生成交接",
    );
    const input = await body(request);
    let page;
    try {
      page = pageKey(input.pageUrl);
    } catch {
      requireThat(false, 400, "invalid_page", "网页地址无效");
    }
    requireThat(
      Array.isArray(input.localRecords) &&
        input.localRecords.length <= 500 &&
        new Set(input.localRecords.map((n) => n.id)).size ===
          input.localRecords.length &&
        input.localRecords.every(
          (n) =>
            /^[a-zA-Z0-9-]{8,80}$/.test(n.id) &&
            Number.isSafeInteger(n.revision) &&
            n.revision > 0,
        ),
      400,
      "invalid_records",
      "本机评注清单无效",
    );
    const ready = await db
      .prepare(
        "SELECT c.token_id FROM cli_connections c JOIN tokens t ON t.id=c.token_id WHERE c.workspace_id=? AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>?) LIMIT 1",
      )
      .bind(workspace, new Date().toISOString())
      .first();
    requireThat(ready, 409, "cli_not_connected", "先在终端完成一次连接");
    const result = await db
        .prepare(
          "SELECT * FROM annotations WHERE workspace_id=? AND deleted_at IS NULL AND json_extract(body_json,'$.note.pageId')=? ORDER BY updated_at DESC,id DESC LIMIT 501",
        )
        .bind(workspace, page)
        .all(),
      rows = result.results || [];
    requireThat(
      rows.length && rows.length <= 500,
      409,
      rows.length ? "page_too_large" : "empty_page",
      rows.length ? "本页超过500条，未生成部分交接" : "本页还没有已同步评注",
    );
    for (const n of input.localRecords) {
      const row = rows.find((r) => r.id === n.id);
      requireThat(
        row && row.revision === n.revision,
        409,
        "not_fully_synced",
        "本页评注尚未完整同步，请重试",
      );
    }
    const records = rows.map((row) => ({
      id: row.id,
      revision: row.revision,
      body: JSON.parse(row.body_json),
    }));
    const assetIds = [
      ...new Set(records.flatMap((n) => n.body.assets.map((a) => a.id))),
    ];
    requireThat(
      assetIds.length <= 500,
      413,
      "page_too_large",
      "本页附件超过500个，未生成部分交接",
    );
    const objects =
      (
        await db
          .prepare(
            "SELECT id,object_key FROM assets WHERE workspace_id=? AND id IN (SELECT value FROM json_each(?))",
          )
          .bind(workspace, JSON.stringify(assetIds))
          .all()
      ).results || [];
    requireThat(
      objects.length === assetIds.length,
      409,
      "asset_not_ready",
      "附件尚未就绪",
    );
    if (env.FILES.head)
      for (let i = 0; i < objects.length; i += 5) {
        const ready = await Promise.all(
          objects.slice(i, i + 5).map((a) => env.FILES.head(a.object_key)),
        );
        requireThat(
          ready.every(Boolean),
          409,
          "asset_not_ready",
          "附件尚未就绪",
        );
      }
    const id = await snapshotId(workspace, page, records),
      createdAt = new Date().toISOString(),
      data = {
        format: "page-review-handoff",
        version: 1,
        id,
        pageUrl: page,
        createdAt,
        records,
      };
    const serialized = JSON.stringify(data);
    requireThat(
      new TextEncoder().encode(serialized).length <= 1500000,
      413,
      "page_too_large",
      "本页内容过大，未生成部分交接",
    );
    const inserted = await db
      .prepare(
        "INSERT INTO handoffs(workspace_id,id,page_id,body_json,created_at) VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,id) DO NOTHING RETURNING created_at",
      )
      .bind(workspace, id, page, serialized, createdAt)
      .first();
    const stored = inserted || await db
      .prepare("SELECT created_at FROM handoffs WHERE workspace_id=? AND id=?")
      .bind(workspace, id)
      .first();
    return json({
      id, pageUrl: page, count: records.length, createdAt: stored.created_at,
    }, inserted ? 201 : 200);
  }
  const match = path.match(
    /^\/v1\/handoffs\/([a-zA-Z0-9-]{8,80})(?:\/assets\/([a-f0-9]{64}))?$/,
  );
  if (match && method === "GET") {
    const row = await db
      .prepare("SELECT body_json FROM handoffs WHERE workspace_id=? AND id=?")
      .bind(workspace, match[1])
      .first();
    requireThat(row, 404, "not_found", "交接不存在或不在授权范围");
    const fixed = JSON.parse(row.body_json);
    const current =
      (
        await db
          .prepare(
            "SELECT id,deleted_at FROM annotations WHERE workspace_id=? AND id IN (SELECT value FROM json_each(?))",
          )
          .bind(workspace, JSON.stringify(fixed.records.map((n) => n.id)))
          .all()
      ).results || [];
    requireThat(
      current.length === fixed.records.length &&
        current.every((n) => !n.deleted_at),
      410,
      "record_deleted",
      "交接中的评注已删除，请重新复制当前页",
    );
    if (match[2]) {
      requireThat(
        fixed.records.some((n) => n.body.assets.some((a) => a.id === match[2])),
        404,
        "not_found",
        "附件不在本次交接中",
      );
      const meta = await db
        .prepare("SELECT * FROM assets WHERE workspace_id=? AND id=?")
        .bind(workspace, match[2])
        .first();
      requireThat(meta, 404, "not_found", "附件不存在");
      const object = await env.FILES.get(meta.object_key);
      requireThat(object, 404, "not_found", "附件不存在");
      return new Response(object.body, {
        headers: {
          "content-type": meta.mime,
          "content-length": String(meta.byte_length),
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }
    return json({
      ...fixed,
      records: fixed.records.map((n) => ({
        ...context({
          id: n.id,
          revision: n.revision,
          updated_at: n.body.note.updatedAt || fixed.createdAt,
          body_json: JSON.stringify(n.body),
        }),
        assets: n.body.assets.map((a) => ({
          ...a,
          sha256: a.id,
          path: `/v1/handoffs/${fixed.id}/assets/${a.id}`,
        })),
      })),
    });
  }
  return null;
}
