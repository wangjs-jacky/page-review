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
        "releases/0.4.3/manifest.json",
        JSON.stringify({ version: "0.4.3", files: names }),
      ],
      ["releases/0.4.3/install.sh", "public installer"],
      ["installers/0.4.3-r1.sh", "updated installer"],
      ["releases/0.4.3/page-review-node.tar.gz", "node release bytes"],
      ["releases/0.4.3/SHA256SUMS.node", "node checksum"],
      ["install.sh", "legacy installer"],
      ["releases/0.4.0/page-review-darwin-arm64.tar.gz", "legacy binary"],
      ...names.map((n) => ["releases/0.4.3/" + n, "test release bytes"]),
    ]);
  const calls = [];
  const metadata = key => objects.has(key) ? { size: Buffer.byteLength(objects.get(key)),
    httpEtag: '"' + require('node:crypto').createHash('sha256').update(objects.get(key)).digest('hex') + '"',
    uploaded: new Date('2026-11-18T00:00:00Z') } : null;
  return {
    objects,
    calls,
    async get(key, options) {
      calls.push({ method: 'get', key, options });
      const meta = metadata(key); if (!meta) return null;
      const bytes = Buffer.from(objects.get(key)), range = options?.range;
      return { ...meta, body: new Response(range ? bytes.subarray(range.offset, range.offset + range.length) : bytes).body };
    },
    async head(key) {
      calls.push({ method: 'head', key });
      return metadata(key);
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
  assert.equal(await installer.text(), "updated installer");
  assert.equal(installer.headers.get('cache-control'), 'no-store');
  assert.equal(
    (await t.request("/releases/0.4.3/private-data", { token: null })).status,
    404,
  );
  assert.equal(
    (
      await t.request(
        "/releases/0.4.3/nested/page-review-darwin-arm64.tar.gz",
        { token: null },
      )
    ).status,
    404,
  );
  t.env.RELEASES.objects.delete("installers/0.4.3-r1.sh");
  assert.equal(
    (await (await t.request("/v1/capabilities")).json()).cliAvailable,
    false,
  );
  t.env.RELEASES.objects.set("installers/0.4.3-r1.sh", "updated installer");
  t.env.RELEASES.objects.delete("releases/0.4.3/page-review-darwin-x64.tar.gz");
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
    "updated installer",
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

const publicUrl = 'https://test.invalid/releases/0.4.3/page-review-node.tar.gz';
test('公开包冷读只访问目标；Range、HEAD、If-Range和非法范围可正确恢复下载', async () => {
  const { distributionRoute } = await import('../cloud/distribution.mjs'), env={RELEASES:releases()};
  const req = (headers={},method='GET')=>distributionRoute(new Request(publicUrl,{headers,method}),env);
  let r=await req({range:'bytes=5-'});assert.equal(r.status,206);assert.equal(r.headers.get('content-range'),'bytes 5-17/18');assert.equal(await r.text(),'release bytes');
  assert.deepEqual(env.RELEASES.calls.map(x=>x.method),['head','get']);
  r=await req({range:'bytes=-5'});assert.equal(r.status,206);assert.equal(await r.text(),'bytes');
  r=await req({range:'bytes=0-3'},'HEAD');assert.equal(r.status,206);assert.equal(r.headers.get('content-length'),'4');assert.equal(await r.text(),'');
  for(const range of ['bytes=99-','bytes=4-2','bytes=-0','bytes=0-1,5-6','bytes=NaN-']){r=await req({range});assert.equal(r.status,416);assert.equal(r.headers.get('content-range'),'bytes */18');}
  r=await req({'range':'bytes=5-','if-range':'"stale"'});assert.equal(r.status,200);const etag=r.headers.get('etag');assert.equal(await r.text(),'node release bytes');
  r=await req({'range':'bytes=5-','if-range':etag});assert.equal(r.status,206);await r.arrayBuffer();
  r=await req({'if-none-match':etag});assert.equal(r.status,304);assert.equal(await r.text(),'');
  env.RELEASES.calls.length=0;r=await req();assert.equal(r.status,200);await r.arrayBuffer();assert.deepEqual(env.RELEASES.calls.map(x=>x.key),['releases/0.4.3/page-review-node.tar.gz']);
  r=await distributionRoute(new Request(publicUrl.replace('page-review-node.tar.gz','../private')),env);assert.equal(r.status,404);
});

test('边缘缓存只允许公开版本文件：命中、范围命中均不回R2，脚本和私人API不缓存', async () => {
  const {distributionRoute}=await import('../cloud/distribution.mjs'),stored=new Map(),puts=[],env={RELEASES:releases()},old=globalThis.caches;
  globalThis.caches={default:{async put(key,response){puts.push(key.url);stored.set(key.url,{bytes:Buffer.from(await response.arrayBuffer()),headers:new Headers(response.headers)})},async match(key){const o=stored.get(key.url);if(!o)return undefined;const h=new Headers(o.headers),range=key.headers.get('range');if(range){const [,a,b]=/bytes=(\d+)-(\d+)/.exec(range),bytes=o.bytes.subarray(+a,+b+1);h.set('content-range',`bytes ${a}-${b}/${o.bytes.length}`);h.set('content-length',String(bytes.length));return new Response(bytes,{status:206,headers:h})}return new Response(o.bytes,{headers:h})}}};
  try{
    let r=await distributionRoute(new Request(publicUrl+'?one',{headers:{Authorization:'private-marker'}}),env);assert.equal(r.headers.get('x-page-review-cache'),'MISS');await r.arrayBuffer();assert.deepEqual(puts,[publicUrl]);
    env.RELEASES.calls.length=0;r=await distributionRoute(new Request(publicUrl+'?two'),env);assert.equal(r.headers.get('x-page-review-cache'),'HIT');assert.equal(await r.text(),'node release bytes');assert.equal(env.RELEASES.calls.length,0);
    r=await distributionRoute(new Request(publicUrl,{headers:{range:'bytes=5-8'}}),env);assert.equal(r.status,206);assert.equal(r.headers.get('x-page-review-cache'),'HIT');assert.equal(await r.text(),'rele');assert.equal(env.RELEASES.calls.length,0);
    assert.equal(await distributionRoute(new Request('https://test.invalid/v1/assets/private'),env),null);
    r=await distributionRoute(new Request('https://test.invalid/install.sh'),env);assert.equal(r.headers.get('cache-control'),'no-store');await r.arrayBuffer();assert.deepEqual(puts,[publicUrl]);
  }finally{if(old===undefined)delete globalThis.caches;else globalThis.caches=old}
});
