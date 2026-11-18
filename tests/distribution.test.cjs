const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  { setup } = require("./helpers/cloud.cjs");
function releases() {
  const names = [
      "page-review-darwin-arm64.tar.gz",
      "page-review-darwin-x64.tar.gz",
      "SHA256SUMS",
    ],
    objects = new Map([
      [
        "releases/0.4.2/manifest.json",
        JSON.stringify({ version: "0.4.2", files: names }),
      ],
      ["releases/0.4.2/install.sh", "public installer"],
      ["install.sh", "legacy installer"],
      ["releases/0.4.0/page-review-darwin-arm64.tar.gz", "legacy binary"],
      ...names.map((n) => ["releases/0.4.2/" + n, "test release bytes"]),
    ]);
  return {
    objects,
    async get(key) {
      return objects.has(key) ? { body: objects.get(key) } : null;
    },
    async head(key) {
      return objects.has(key) ? {} : null;
    },
  };
}
test("CLI分发缺失时不宣称已发布；完整制品才显示安装入口，公开路由不读取私有FILES", async () => {
  const t = await setup();
  t.env.API_ORIGIN = "https://install.example";
  assert.equal((await t.request("/install.sh", { token: null })).status, 503);
  assert.equal(
    (await (await t.request("/v1/capabilities")).json()).cliAvailable,
    false,
  );
  t.env.RELEASES = releases();
  let c = await (await t.request("/v1/capabilities")).json();
  assert.equal(c.cliAvailable, true);
  assert.equal(c.installUrl, "https://install.example/install.sh");
  const installer = await t.request("/install.sh", { token: null });
  assert.equal(installer.status, 200);
  assert.equal(await installer.text(), "public installer");
  assert.equal(
    (await t.request("/releases/0.4.2/private-data", { token: null })).status,
    404,
  );
  assert.equal(
    (
      await t.request(
        "/releases/0.4.2/nested/page-review-darwin-arm64.tar.gz",
        { token: null },
      )
    ).status,
    404,
  );
  t.env.RELEASES.objects.delete("releases/0.4.2/install.sh");
  assert.equal(
    (await (await t.request("/v1/capabilities")).json()).cliAvailable,
    false,
  );
  t.env.RELEASES.objects.set("releases/0.4.2/install.sh", "public installer");
  t.env.RELEASES.objects.delete("releases/0.4.2/page-review-darwin-x64.tar.gz");
  c = await (await t.request("/v1/capabilities")).json();
  assert.equal(c.cliAvailable, false);
  assert.equal(c.installUrl, null);
  assert.equal((await t.request("/install.sh", { token: null })).status, 503);
});

test("新版安装脚本按版本切换，旧缓存安装器仍能下载已发布CLI", async () => {
  const t = await setup();
  t.env.RELEASES = releases();
  assert.equal(
    await (await t.request("/install.sh", { token: null })).text(),
    "public installer",
  );
  assert.equal(
    await (
      await t.request("/releases/0.4.0/page-review-darwin-arm64.tar.gz", {
        token: null,
      })
    ).text(),
    "legacy binary",
  );
  assert.equal(
    (await t.request("/releases/0.4.0/private-data", { token: null })).status,
    404,
  );
});
