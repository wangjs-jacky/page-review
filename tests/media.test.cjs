const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  M = require("../extension/media.js");
test("录制以CSS区域对应真实视频像素，非整屏伪裁剪；越界和微小选区拒绝", () => {
  assert.deepEqual(
    M.crop(
      { left: 100, top: 80, width: 320, height: 180 },
      { width: 1000, height: 700 },
      2000,
      1400,
    ),
    { x: 200, y: 160, width: 640, height: 360 },
  );
  for (const rect of [
    { left: -1, top: 0, width: 100, height: 100 },
    { left: 0, top: 0, width: 20, height: 100 },
    { left: 950, top: 0, width: 100, height: 100 },
  ])
    assert.throws(() => M.region(rect, { width: 1000, height: 700 }));
});
test("录制控件必须完全在选区外，空间不足时要求重新选择", () => {
  const r = { left: 100, top: 150, width: 460, height: 190 },
    v = { width: 1100, height: 800 },
    c = M.controls(r, v);
  assert(c && c.top + c.height <= r.top);
  assert.equal(
    M.controls(
      { left: 0, top: 0, width: 390, height: 650 },
      { width: 390, height: 650 },
    ),
    null,
  );
});

test("窄窗口的录制控制条使用可直接渲染的选区外尺寸", () => {
  const viewport = { width: 190, height: 240 };
  const rect = { left: 0, top: 68, width: 190, height: 172 };
  assert.deepEqual(M.activeControls(rect, viewport), {
    left: 8, top: 8, width: 166, height: 48,
  });
  assert.equal(M.activeControls(rect, { width: 150, height: 240 }), null);
});
