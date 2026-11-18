import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
test("真实workerd/R2：公开完整包缓存、206续传、条件读取及私有路径隔离", async t => {
  if (!process.env.PAGE_REVIEW_MINIFLARE_MODULE) return t.skip("需指定已有Miniflare模块");
  const runtime = await import(process.env.PAGE_REVIEW_MINIFLARE_MODULE);
  const options = {
    modules: ["worker.mjs", "login.mjs", "handoff.mjs", "distribution.mjs"].map(name => ({
      type: "ESModule", path: path.join(root, "cloud", name),
    })),
    modulesRoot: path.join(root, "cloud"),
    compatibilityDate: "2026-10-19", host: "127.0.0.1", port: 0,
    r2Buckets: ["RELEASES", "FILES"], d1Databases: ["DB"],
  };
  const mf = new runtime.Miniflare(runtime.convertV4MiniflareOptions ? runtime.convertV4MiniflareOptions(options) : options);
  try {
    await mf.ready;
    const bucket = await mf.getR2Bucket("RELEASES"), bytes = "0123456789abcdef";
    const get = (headers = {}, method = "GET") => mf.dispatchFetch("https://delivery.invalid/releases/0.4.2/page-review-node.tar.gz", { method, headers });
    await bucket.put("releases/0.4.2/page-review-node.tar.gz", bytes);
    const cold = await get({range: "bytes=4-7"});
    assert.equal(cold.status, 206); assert.equal(await cold.text(), "4567");
    assert.equal(cold.headers.get("content-range"), "bytes 4-7/16");
    assert.equal(cold.headers.get("x-page-review-cache"), "RANGE");
    const full = await get();
    assert.equal(full.status, 200); assert.equal(await full.text(), bytes);
    assert.equal(full.headers.get("x-page-review-cache"), "MISS");
    const hot = await get();
    assert.equal(hot.headers.get("x-page-review-cache"), "HIT"); assert.equal(await hot.text(), bytes);
    const resumed = await get({range: "bytes=8-"});
    assert.equal(resumed.status, 206); assert.equal(await resumed.text(), "89abcdef");
    assert.equal(resumed.headers.get("x-page-review-cache"), "HIT");
    const unchanged = await get({"if-none-match": full.headers.get("etag"),range:"bytes=0-1"});
    assert.equal(unchanged.status, 304); assert.equal(await unchanged.text(), "");
    assert.equal(unchanged.headers.get("content-range"), null);
    const old = await get({range:"bytes=0-1","if-range":'"old"'});
    assert.equal(old.status, 200); assert.equal(await old.text(), bytes);
    const sameDate = await get({range:"bytes=0-1","if-range":full.headers.get("last-modified")});
    assert.equal(sameDate.status, 206); assert.equal(await sameDate.text(), "01");
    assert.equal((await get({range:"bytes=16-"})).status, 416);
    const head = await get({}, "HEAD"); assert.equal(head.status, 200); assert.equal(await head.text(), "");
    assert.equal((await mf.dispatchFetch("https://delivery.invalid/releases/0.4.2/private.txt")).status, 404);
    assert.equal((await mf.dispatchFetch("https://delivery.invalid/v1/annotations")).status, 401);
  } finally { await mf.dispose(); }
});
