const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {setup,sha,png}=require('./helpers/cloud.cjs');
test('云接口拒绝匿名、错误和撤销凭证；只读连接不能写入或管理连接', async () => {
  const t = await setup(), r = await t.reader();
  assert.equal((await t.request('/v1/annotations', { token: null })).status, 401);
  assert.equal((await t.request('/v1/annotations', { token: 'pr_' + 'x'.repeat(64) })).status, 401);
  assert.equal((await t.request('/v1/annotations/annotation-1', { token: r.token, method: 'DELETE', data: {} })).status, 403);
  assert.equal((await t.request('/v1/connections', { token: r.token })).status, 403);
  await t.request('/v1/connections/' + r.id, { method: 'DELETE' }); assert.equal((await t.request('/v1/annotations', { token: r.token })).status, 401);
});
test('图片先上传：未提交附件不可读，缺图不能提交，错误摘要不入库', async () => {
  const t = await setup(), asset = await t.upload();
  assert.equal((await t.request('/v1/assets/' + asset.id)).status, 404);
  assert.equal((await t.save('annotation-1', { hasImage: true })).status, 400);
  assert.equal((await t.request('/v1/uploads/' + '0'.repeat(64), { method: 'PUT', raw: png, contentType: 'image/png' })).status, 400);
  assert.equal((await t.save('annotation-1', { hasImage: true }, 0, crypto.randomUUID(), [asset])).status, 200);
  const image = await t.request('/v1/assets/' + asset.id); assert.equal(image.status, 200); assert.equal(image.headers.get('cache-control'), 'private, no-store'); assert.equal(sha(Buffer.from(await image.arrayBuffer())), asset.id);
});
test('云修订幂等：丢失回执可重发；同ID不同内容与过期修订不能覆盖', async () => {
  const t = await setup(), requestId = crypto.randomUUID();
  const first = await (await t.save('annotation-1', {}, 0, requestId)).json(); assert.equal(first.revision, 1);
  assert.deepEqual(await (await t.save('annotation-1', {}, 0, requestId)).json(), first);
  assert.equal((await t.save('annotation-1', { comment: '另一条' }, 0, requestId)).status, 409);
  assert.equal((await t.save('annotation-1', { comment: '新修订' }, 1)).status, 200);
  const conflict = await t.save('annotation-1', { comment: '过期覆盖' }, 1); assert.equal(conflict.status, 409); assert.equal((await conflict.json()).remoteRevision, 2);
  assert.equal((await (await t.request('/v1/annotations/annotation-1/context')).json()).comment, '新修订');
});
test('workspace隔离同时覆盖元数据、原上下文和图片，即使知道完整ID', async () => {
  const t = await setup(), image = await t.upload(); await t.save('annotation-1', { hasImage: true }, 0, crypto.randomUUID(), [image]);
  for (const path of ['/v1/annotations/annotation-1', '/v1/annotations/annotation-1/context', '/v1/assets/' + image.id]) assert.equal((await t.request(path, { token: t.other })).status, 404);
  assert.equal((await (await t.request('/v1/annotations', { token: t.other })).json()).items.length, 0);
});
test('独立 Agent 授权无到期时间，撤销后评注与图片立即拒绝访问', async (testContext) => {
  const t = await setup();
  const image = await t.upload();
  assert.equal((await t.save('annotation-1', { hasImage: true }, 0, crypto.randomUUID(), [image])).status, 200);
  const reader = await t.reader();
  const grant = t.sql.prepare('SELECT expires_at FROM tokens WHERE id=?').get(reader.id);
  assert.equal(grant.expires_at, null);

  testContext.mock.timers.enable({ apis: ['Date'], now: Date.now() + 31 * 24 * 3600_000 });
  const paths = ['/v1/annotations', '/v1/annotations/annotation-1/context', '/v1/assets/' + image.id];
  for (const path of paths)
    assert.equal((await t.request(path, { token: reader.token })).status, 200);

  const revoke = await t.request('/v1/connections/' + reader.id, { method: 'DELETE' });
  assert.equal(revoke.status, 200);
  for (const path of paths)
    assert.equal((await t.request(path, { token: reader.token })).status, 401);

  const list = await (await t.request('/v1/connections')).text();
  assert(!list.includes(reader.token));
  assert(list.includes('revoked_at'));
});
test('删除立即隐藏上下文与图片，旧上传不能复活；未同步新记录也可留墓碑', async () => {
  const t = await setup(), image = await t.upload(); await t.save('annotation-1', { hasImage: true }, 0, crypto.randomUUID(), [image]);
  assert.equal((await t.request('/v1/annotations/annotation-1', { method: 'DELETE', data: { requestId: crypto.randomUUID(), expectedRevision: 1 } })).status, 200);
  assert.equal((await t.request('/v1/annotations/annotation-1/context')).status, 404); assert.equal((await t.request('/v1/assets/' + image.id)).status, 404); assert.equal((await t.save()).status, 409);
  assert.equal((await t.request('/v1/annotations/not-created-1', { method: 'DELETE', data: { requestId: crypto.randomUUID(), expectedRevision: 0 } })).status, 200);
  assert.equal((await t.save('not-created-1')).status, 409);
});
test('检索分页不会跨空间；中文/反馈/来源可组合，null不推断为喜好', async () => {
  const t = await setup(); await t.save('annotation-1'); await t.save('annotation-2', { feedback: 'positive' }); await t.save('annotation-3', { feedback: 'negative' });
  const list = await (await t.request('/v1/annotations?q=' + encodeURIComponent('导航') + '&domain=example.com&feedback=unrated')).json(); assert.equal(list.items.length, 1); assert.equal(list.items[0].feedback, null);
  const first = await (await t.request('/v1/annotations?limit=2')).json(), second = await (await t.request('/v1/annotations?limit=2&cursor=' + encodeURIComponent(first.nextCursor))).json(); assert.equal(new Set([...first.items, ...second.items].map(n => n.id)).size, 3);
  assert.equal((await (await t.request('/v1/annotations?q=%25')).json()).items.length, 0); assert.equal((await t.request('/v1/annotations?cursor=bad')).status, 400);
});
test('Agent上下文保留原话、历史、采纳理由和状态，页面资料不伪造当前定位', async () => {
  const t = await setup(); await t.save('annotation-1', { comment: '保留来源', originalComment: '原来的意见', history: [{ comment: '删掉过多说明', feedback: 'negative', at: '2026-11-01' }], outcome: { status: 'adopted', reason: '保留查找路径' }, state: { expanded: true } });
  const c = await (await t.request('/v1/annotations/annotation-1/context')).json(); assert.equal(c.feedback, null); assert.equal(c.originalComment, '原来的意见'); assert.equal(c.history[0].feedback, 'negative'); assert.equal(c.outcome.reason, '保留查找路径'); assert.equal(c.capture.interactionState.expanded, true); assert.equal(c.anchorStatus, 'captured_only'); assert.equal(c.capture.status, 'explicitly_without_image');
});
