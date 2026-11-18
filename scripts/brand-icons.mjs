import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Rendering editable SVG and resizing approved bitmap assets is deterministic.
// PNGs are checked in; ordinary extension builds require no Sharp installation.
const sharp = createRequire(import.meta.url)(
  process.env.PAGE_REVIEW_SHARP_MODULE || "sharp",
);
await fs.mkdir(path.join(root, "extension/icons"), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const source = path.join(
    root,
    "design/brand",
    size <= 32 ? "f5-small.svg" : "f5-production.png",
  );
  await sharp(source)
    .resize(size, size)
    .png()
    .toFile(path.join(root, `extension/icons/${size}.png`));
}
console.log("F5：16/32px透明光学校正版、48/128px透明选稿资源已生成。");
