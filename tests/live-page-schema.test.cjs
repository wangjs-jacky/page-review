const { test } = require("node:test");
const assert = require("node:assert/strict");
const { setup } = require("./helpers/cloud.cjs");

test("live协议就绪检查要求两张网页表及终端协议登记迁移", async (t) => {
  const cloud = await setup();
  t.after(() => cloud.sql.close());
  const handoff = await import("../cloud/handoff.mjs");
  assert.equal(typeof handoff.supportsLivePageSchema, "function", "live协议必须可核对持久化schema");
  assert.equal(await handoff.supportsLivePageSchema(cloud.env.DB), true);
  cloud.sql.exec("DROP TABLE live_page_saves");
  assert.equal(await handoff.supportsLivePageSchema(cloud.env.DB), false);
  cloud.sql.exec("DROP TABLE live_pages");
  assert.equal(await handoff.supportsLivePageSchema(cloud.env.DB), false);
});

test("live协议schema不可读取时不宣告能力就绪", async () => {
  const cloud = await setup();
  cloud.sql.close();
  const handoff = await import("../cloud/handoff.mjs");
  assert.equal(typeof handoff.supportsLivePageSchema, "function", "live协议必须可核对持久化schema");
  assert.equal(await handoff.supportsLivePageSchema(cloud.env.DB), false);
});

test("只有live网页表但尚未迁移终端协议字段时能力仍未就绪", async (t) => {
  const cloud = await setup();
  t.after(() => cloud.sql.close());
  const { supportsLivePageSchema } = await import("../cloud/handoff.mjs");
  cloud.sql.exec("ALTER TABLE cli_connections DROP COLUMN read_protocol");
  assert.equal(await supportsLivePageSchema(cloud.env.DB), false);
});
