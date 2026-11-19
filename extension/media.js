(function (root) {
  "use strict";
  function region(rect, viewport) {
    if (
      !rect ||
      !viewport ||
      ![
        rect.left,
        rect.top,
        rect.width,
        rect.height,
        viewport.width,
        viewport.height,
      ].every(Number.isFinite) ||
      viewport.width < 1 ||
      viewport.height < 1 ||
      rect.left < 0 ||
      rect.top < 0 ||
      rect.width < 40 ||
      rect.height < 40 ||
      rect.left + rect.width > viewport.width ||
      rect.top + rect.height > viewport.height
    )
      throw Error("请在页面内框选至少40 × 40的区域");
    return {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.floor(rect.width),
      height: Math.floor(rect.height),
    };
  }
  function crop(rect, viewport, width, height) {
    region(rect, viewport);
    const x = Math.round((rect.left * width) / viewport.width),
      y = Math.round((rect.top * height) / viewport.height),
      w = Math.min(
        width - x,
        Math.round((rect.width * width) / viewport.width),
      ),
      h = Math.min(
        height - y,
        Math.round((rect.height * height) / viewport.height),
      );
    if (w < 2 || h < 2) throw Error("选区过小");
    return { x, y, width: w, height: h };
  }
  function controls(rect, viewport, size = { width: 278, height: 48 }) {
    const gap = 12,
      candidates = [
        { left: rect.left, top: rect.top - size.height - gap },
        { left: rect.left, top: rect.top + rect.height + gap },
        { left: rect.left - size.width - gap, top: rect.top },
        { left: rect.left + rect.width + gap, top: rect.top },
      ];
    return (
      candidates
        .map((p) => ({
          ...p,
          left: Math.max(8, Math.min(viewport.width - size.width - 8, p.left)),
          width: size.width,
          height: size.height,
        }))
        .find(
          (p) =>
            p.left >= 0 &&
            p.top >= 8 &&
            p.left + p.width <= viewport.width - 8 &&
            p.top + p.height <= viewport.height - 8 &&
            (p.left + p.width <= rect.left ||
              p.left >= rect.left + rect.width ||
              p.top + p.height <= rect.top ||
              p.top >= rect.top + rect.height),
        ) || null
    );
  }
  function activeControls(rect, viewport) {
    const width = Math.min(310, viewport.width - 24);
    if (width < 144) return null;
    return controls(rect, viewport, { width, height: 48 });
  }
  const api = { region, crop, controls, activeControls };
  root.PageReviewMedia = api;
  if (typeof module !== "undefined") module.exports = api;
})(globalThis);
