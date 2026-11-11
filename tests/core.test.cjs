const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Core = require('../extension/core.js');
test('同一阅读页去除追踪和段落hash，保留功能查询和SPA路由', () => {
  assert.equal(Core.pageKey('https://example.com/read?utm_source=x&topic=design#chapter'), 'https://example.com/read?topic=design');
  assert.notEqual(Core.pageKey('https://example.com/?topic=a'), Core.pageKey('https://example.com/?topic=b'));
  assert.notEqual(Core.pageKey('https://example.com/#/a'), Core.pageKey('https://example.com/#/b'));
  assert.throws(() => Core.pageKey('chrome://settings'));
});
const anchor = { tag: 'h1', text: '让好内容，更容易被找到。设计值得关注的阅读路径。', selector: 'main > h1', context: '内容策略，阅读路径和渐进披露。', attrs: { id: 'reading-title' } };
test('布局位置改变仍能识别同内容，CSS路径相同但内容替换不强行定位', () => {
  assert.equal(Core.rankAnchors(anchor, [{ ...anchor, selector: '#new-place' }]).status, 'found');
  assert.equal(Core.rankAnchors(anchor, [{ tag: 'h1', text: 'Annual financial report 2030', selector: anchor.selector, context: 'Investor relations', attrs: {} }]).status, 'missing');
});
test('重复内容存在歧义时暂停贴回，不能只靠CSS路径破同分', () => {
  const a = { ...anchor, attrs: {} }; const result = Core.rankAnchors(a, [a, { ...a, selector: 'article h1' }]); assert.equal(result.status, 'uncertain'); assert.equal(result.index, -1);
});
test('无文字的图片需要稳定属性与上下文，普通空div不会被认成原图', () => {
  const image = { tag: 'img', text: '', attrs: { alt: '阅读路径地图', id: 'reading-map' }, label: '阅读路径地图', context: '阅读路径示意图', selector: '#reading-map' };
  assert.equal(Core.rankAnchors(image, [image]).status, 'found');
  assert.equal(Core.rankAnchors(image, [{ ...image, attrs: {}, label: '', context: '' }]).status, 'missing');
});
test('中文页面显著变化可与局部小改区分', () => {
  const a = '这篇文章讨论信息组织，如何通过目录与关联内容帮助读者查找资料。';
  assert(Core.similarity(a, a + '补充一个新例子。') > 0.8); assert(Core.similarity(a, 'Welcome to the company investor presentation 2027') < 0.46);
});
test('拒绝空评注、超长输入和非网页来源；原始口语不被重写', () => {
  const note = { url: 'https://example.com/read', comment: '  不喜欢这里。说明能少点，但资料来源不要删。  ', type: 'element' };
  assert.equal(Core.safeNote(note).comment, '不喜欢这里。说明能少点，但资料来源不要删。');
  assert.throws(() => Core.safeNote({ ...note, comment: '' })); assert.throws(() => Core.safeNote({ ...note, comment: 'a'.repeat(12001) })); assert.throws(() => Core.safeNote({ ...note, url: 'javascript:alert(1)' }));
});
test('CRC32符合标准向量，ZIP支持中文、二进制与外部unzip解包', () => {
  assert.equal(Core.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const bytes = Core.zip([{ name: '中文说明.md', data: '人的关注点' }, { name: 'asset.bin', data: Uint8Array.from([0, 255, 1, 128]) }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-review-test-')), file = path.join(dir, 'bundle.zip');
  try { fs.writeFileSync(file, bytes); execFileSync('unzip', ['-t', file]); assert.deepEqual(execFileSync('unzip', ['-p', file, 'asset.bin']), Buffer.from([0, 255, 1, 128])); } finally { fs.rmSync(dir, { recursive: true }); }
  assert.throws(() => Core.zip([{ name: '../unsafe', data: 'x' }]));
});
test('多页AI包保留原话、负例、历史、采纳理由和图片对应；缺图不冒充完成', () => {
  const notes = [{ id: 'note-0001', pageId: 'https://one.example/', url: 'https://one.example/', title: '一', type: 'element', comment: '说明太多，但更新时间要保留', kind: 'problem', createdAt: '2026-11-11', originalComment: '原意见', history: [{ comment: '原意见' }], outcome: { status: 'rejected', reason: '保留必要信息' } }, { id: 'note-0002', pageId: 'https://two.example/', url: 'https://two.example/', title: '二', comment: '分区悬停很清晰', type: 'region', screenshotError: '未获截图权限', createdAt: '2026-11-11' }];
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const pack = Core.readingPackage(notes, { 'note-0001': { viewport: png, crop: png } }, '比较内容组织');
  assert.equal(pack.manifest.pages.length, 2); assert.equal(pack.manifest.annotations[0].images.viewport, 'assets/note-0001/viewport.png'); assert.equal(pack.manifest.annotations[0].outcome.reason, '保留必要信息'); assert(pack.markdown.includes('说明太多，但更新时间要保留')); assert(pack.markdown.includes('没有截图：未获截图权限'));
});
test('评论浮层跟随选中内容附近，而不是固定在右下角入口', () => {
  const position = Core.placePopover({ left: 200, top: 200, width: 500, height: 200 }, { width: 1440, height: 1000 }, { width: 360, height: 240 });
  assert.deepEqual(position, { left: 300, top: 416 });
});
test('靠近视口边缘或短视口的评论框仍可完整操作', () => {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 1440, height: 300 }]) {
    const panel = { width: Math.min(360, viewport.width - 30), height: Math.min(260, viewport.height - 30) };
    const position = Core.placePopover({ left: viewport.width - 20, top: viewport.height - 20, width: 20, height: 20 }, viewport, panel);
    assert(position.left >= 15); assert(position.left + panel.width <= viewport.width - 15); assert(position.top >= 15); assert(position.top + panel.height <= viewport.height - 15);
  }
});
