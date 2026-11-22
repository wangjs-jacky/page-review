const { test } = require("node:test");
const assert = require("node:assert/strict");
const { setup } = require("./helpers/cloud.cjs");

test("旧终端确认保持协议0，新终端确认持久化并回读同步门禁能力", async (t) => {
  const cloud = await setup(); t.after(() => cloud.sql.close());
  const reader = await cloud.reader();
  const legacy = await cloud.request("/v1/cli/confirm", { method:"POST", token:reader.token, data:{deviceName:"Test Mac"} });
  assert.equal(legacy.status, 200);
  assert.equal((await legacy.json()).readProtocol, 0);
  const update = await cloud.request("/v1/cli/confirm", { method:"POST", token:reader.token, data:{deviceName:"Test Mac",clientVersion:"0.4.4",readProtocol:1} });
  assert.equal(update.status, 200);
  const confirmation = await update.json();
  assert.equal(confirmation.readProtocol, 1);
  assert.equal(confirmation.clientVersion, "0.4.4");
  const list = await (await cloud.request("/v1/cli/connections")).json();
  assert.equal(list.items[0].read_protocol, 1);
  assert.equal(list.items[0].client_version, "0.4.4");
  assert.equal((await cloud.request("/v1/cli/connections", {token:reader.token})).status, 403);
});

test("终端确认拒绝无效协议声明，不写入兼容能力", async (t) => {
  const cloud = await setup(); t.after(() => cloud.sql.close());
  const reader = await cloud.reader();
  for (const claims of [{readProtocol:-1},{readProtocol:1.5},{readProtocol:"1"},{readProtocol:1,clientVersion:42}]) {
    const response = await cloud.request("/v1/cli/confirm", { method:"POST", token:reader.token, data:{deviceName:"Test Mac",...claims} });
    assert.equal(response.status, 400);
  }
  assert.equal(cloud.sql.prepare("SELECT COUNT(*) AS count FROM cli_connections").get().count, 0);
});
