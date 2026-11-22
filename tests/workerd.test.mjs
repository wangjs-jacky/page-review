import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import { readHandoff } from "../cli/page-review.mjs";
import { livePageId } from "../cloud/handoff.mjs";
import { CLI_VERSION, READ_PROTOCOL, CLI_FILES, INSTALLER_KEY } from "../cloud/cli-release.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID, createHash } from "node:crypto";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
test("当前Worker源码在真实workerd/D1/R2读取60条固定清单；修改不漂移，删除拒绝", async (t) => {
  if (!process.env.PAGE_REVIEW_MINIFLARE_MODULE) {
    t.skip("需指定已有Miniflare模块");
    return;
  }
  const runtime = await import(process.env.PAGE_REVIEW_MINIFLARE_MODULE),
    options = {
      modules: [
        "worker.mjs",
        "login.mjs",
        "handoff.mjs",
        "distribution.mjs", "cli-release.mjs",
      ].map((name) => ({
        type: "ESModule",
        path: path.join(root, "cloud", name),
      })),
      modulesRoot: path.join(root, "cloud"),
      compatibilityDate: "2026-10-12",
      host: "127.0.0.1",
      port: 0,
      d1Databases: ["DB"],
      r2Buckets: ["FILES", "RELEASES"],
      bindings: { API_ORIGIN: "https://integration.invalid" },
    },
    mf = new runtime.Miniflare(
      runtime.convertV4MiniflareOptions
        ? runtime.convertV4MiniflareOptions(options)
        : options,
    );
  try {
    const apiUrl = (await mf.ready).origin;
    const db = await mf.getD1Database("DB");
    for (const name of ["0001.sql", "0002-login.sql", "0003-handoff.sql", "0004-terminal-intent.sql", "0005-live-pages.sql", "0006-cli-read-protocol.sql"])
      for (const sql of (
        await fs.readFile(path.join(root, "cloud/migrations", name), "utf8")
      )
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean))
        await db.prepare(sql).run();
    const releases = await mf.getR2Bucket("RELEASES");
    await releases.put(`releases/${CLI_VERSION}/manifest.json`, JSON.stringify({
      version: CLI_VERSION, readProtocol: READ_PROTOCOL, files: CLI_FILES,
    }));
    await Promise.all([
      releases.put(INSTALLER_KEY, "fixture installer"),
      ...CLI_FILES.map((name) => releases.put(`releases/${CLI_VERSION}/${name}`, "fixture release")),
    ]);
    const token = "pr_" + randomBytes(32).toString("hex"),
      workspaceId = randomUUID(),
      hash = (value) => createHash("sha256").update(value).digest("hex");
    await db
      .prepare("INSERT INTO workspaces(id,created_at) VALUES(?,?)")
      .bind(workspaceId, new Date().toISOString())
      .run();
    await db
      .prepare(
        "INSERT INTO tokens(id,workspace_id,token_hash,kind,name,created_at) VALUES(?,?,?,'writer','test',?)",
      )
      .bind(randomUUID(), workspaceId, hash(token), new Date().toISOString())
      .run();
    async function request(
      resource,
      { method = "GET", data, raw, type, auth = token } = {},
    ) {
      return mf.dispatchFetch("https://integration.invalid" + resource, {
        method,
        headers: {
          authorization: "Bearer " + auth,
          ...(data
            ? { "content-type": "application/json" }
            : type
              ? { "content-type": type }
              : {}),
        },
        ...(data ? { body: JSON.stringify(data) } : raw ? { body: raw } : {}),
      });
    }
    const created = await request("/v1/connections", {
        method: "POST",
        data: { name: "test reader" },
      }),
      reader = await created.json();
    assert.equal(created.status, 201);
    assert.equal(
      (
        await request("/v1/cli/confirm", {
          method: "POST",
          auth: reader.token,
          data: { deviceName: "test Mac", clientVersion: CLI_VERSION, readProtocol: READ_PROTOCOL },
        })
      ).status,
      200,
    );
    const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0e0AAAAASUVORK5CYII=",
        "base64",
      ),
      sha = hash(png);
    assert.equal(
      (
        await request("/v1/uploads/" + sha, {
          method: "PUT",
          raw: png,
          type: "image/png",
        })
      ).status,
      200,
    );
    const note = {
      url: "https://example.com/guide?utm_source=test",
      pageId: "https://wrong.invalid",
      type: "page",
      comment: "原评注",
      feedback: null,
      hasImage: false,
      createdAt: new Date().toISOString(),
    };
    for (let i = 0; i < 60; i++) {
      const assets =
          i === 0 ? [{ id: sha, role: "viewport", width: 1, height: 1 }] : [],
        r = await request("/v1/annotations/annotation-" + i, {
          method: "PUT",
          data: {
            note: { ...note, hasImage: !!assets.length },
            assets,
            expectedRevision: 0,
            requestId: randomUUID(),
          },
        });
      assert.equal(r.status, 200, await r.text());
    }
    const create = await request("/v1/handoffs", {
        method: "POST",
        data: { pageUrl: "https://example.com/guide", localRecords: [] },
      }),
      fixed = await create.json();
    assert.equal(create.status, 201, JSON.stringify(fixed));
    assert.equal(fixed.count, 60);
    const read = await request("/v1/handoffs/" + fixed.id, {
        auth: reader.token,
      }),
      context = await read.json();
    assert.equal(read.status, 200);
    assert.equal(context.records.length, 60);
    const asset = context.records.find((n) => n.assets.length).assets[0],
      image = await request(asset.path, { auth: reader.token });
    assert.equal(hash(Buffer.from(await image.arrayBuffer())), sha);
    assert.equal(
      (
        await request("/v1/annotations/annotation-1", {
          method: "PUT",
          data: {
            note: { ...note, comment: "新文本" },
            assets: [],
            expectedRevision: 1,
            requestId: randomUUID(),
          },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await (
          await request("/v1/handoffs/" + fixed.id, { auth: reader.token })
        ).json()
      ).records.find((n) => n.id === "annotation-1").comment,
      "原评注",
    );
    assert.equal(
      (
        await request("/v1/annotations/annotation-2", {
          method: "DELETE",
          data: { expectedRevision: 1, requestId: randomUUID() },
        })
      ).status,
      200,
    );
    assert.equal(
      (await request("/v1/handoffs/" + fixed.id, { auth: reader.token }))
        .status,
      410,
    );
    const live = await livePageId(workspaceId, "https://example.com/guide");
    await db.prepare("DELETE FROM live_pages WHERE workspace_id=? AND id=?")
      .bind(workspaceId, live).run();
    const recovered = await request("/v1/handoffs/" + live, { auth: reader.token });
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).pageUrl, "https://example.com/guide");
    const marker = randomUUID();
    const out = await fs.mkdtemp(path.join(os.tmpdir(), "page-review-live-"));
    const config = { apiUrl, token: reader.token };
    try {
      const destination = path.join(out, "reading");
      await assert.rejects(readHandoff(config, live, destination, { after: marker }), /409/);
      await assert.rejects(fs.stat(destination), { code: "ENOENT" });
      const saved = await request("/v1/annotations/annotation-1", {
        method: "PUT",
        data: {
          note: { ...note, comment: "实时引用的新截图", hasImage: true },
          assets: [{ id: sha, role: "viewport", width: 1, height: 1 }],
          expectedRevision: 2,
          requestId: randomUUID(),
          syncMarkers: [marker],
        },
      });
      assert.equal(saved.status, 200, await saved.text());
      const latest = await readHandoff(config, "page-review-" + live, destination, { after: marker });
      assert.equal(latest.annotations, 59);
      assert.equal(latest.assets, 1);
      assert.equal(latest.records.find((n) => n.id === "annotation-1").comment, "实时引用的新截图");
      assert.equal(hash(await fs.readFile(path.join(destination, sha + ".png"))), sha);
    } finally {
      await fs.rm(out, { recursive: true });
    }
    console.log(
      "真实workerd：60条当前页规范化历史、私有R2摘要、固定修订与删除410通过。",
    );
  } finally {
    await mf.dispose();
  }
});
