import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url), Core = require('../extension/core.js');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'extension/manifest.json'), 'utf8'));
const files = ['manifest.json', 'core.js', 'db.js', 'background.js', 'content.js', 'library.html', 'library.css', 'library.js', 'cloud.js', 'cloud-config.js'];
const output = path.join(root, 'dist/page-review'); await fs.mkdir(output, { recursive: true });
for (const file of files) await fs.copyFile(path.join(root, 'extension', file), path.join(output, file));
await fs.writeFile(path.join(output, 'content-style.js'), 'globalThis.PageReviewStyles = ' + JSON.stringify(await fs.readFile(path.join(root, 'extension/content.css'), 'utf8')) + ';\n');
files.push('content-style.js');
function pngChunk(type, data) {
  const name = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4); size.writeUInt32BE(data.length); crc.writeUInt32BE(Core.crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, crc]);
}
function icon(size) {
  const supersample = 4, raw = Buffer.alloc((size * 4 + 1) * size);
  function color(x, y) {
    const corner = 0.2, dx = Math.max(corner - x, 0, x - (1 - corner)), dy = Math.max(corner - y, 0, y - (1 - corner));
    if (dx * dx + dy * dy > corner * corner) return [0, 0, 0, 0];
    const line = Math.abs(x + y - 1.02) / Math.SQRT2;
    if (line < 0.06 && x > 0.28 && x < 0.73 && y > 0.27 && y < 0.74) return [255, 255, 255, 255];
    if (x > 0.25 && x < 0.34 && y > 0.69 && y < 0.78) return [255, 255, 255, 255];
    return [40, 100, 239, 255];
  }
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const sum = [0, 0, 0, 0];
      for (let sy = 0; sy < supersample; sy++) for (let sx = 0; sx < supersample; sx++) { const c = color((x + (sx + 0.5) / supersample) / size, (y + (sy + 0.5) / supersample) / size); for (let i = 0; i < 4; i++) sum[i] += c[i]; }
      for (let i = 0; i < 4; i++) raw[y * (size * 4 + 1) + 1 + x * 4 + i] = Math.round(sum[i] / supersample ** 2);
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}
await fs.mkdir(path.join(output, 'icons'), { recursive: true });
for (const size of [16, 32, 48, 128]) { const name = `icons/${size}.png`; await fs.writeFile(path.join(output, name), icon(size)); files.push(name); }
const selectedOrigin = process.env.PAGE_REVIEW_CLOUD_ORIGIN || 'https://review.paws.rodeo';
if (selectedOrigin) { const url = new URL(selectedOrigin); if (url.protocol !== 'https:' || url.origin !== selectedOrigin) throw new Error('云空间需要确定的HTTPS源地址'); }
const builtManifest = { ...manifest, content_security_policy: { extension_pages: manifest.content_security_policy.extension_pages.replace("connect-src 'none'", selectedOrigin ? 'connect-src ' + selectedOrigin : "connect-src 'none'") } };
await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(builtManifest, null, 2) + '\n');
await fs.writeFile(path.join(output, 'cloud-config.js'), 'globalThis.PageReviewCloudConfig = ' + JSON.stringify({ apiOrigin: selectedOrigin }) + ';\n');
const archive = Core.zip(await Promise.all(files.map(async name => ({ name, data: await fs.readFile(path.join(output, name)) }))));
const archiveName = `page-review-${manifest.version}.zip`; await fs.writeFile(path.join(root, 'dist', archiveName), archive);
await fs.writeFile(path.join(root, 'dist', archiveName + '.sha256'), createHash('sha256').update(archive).digest('hex') + '  ' + archiveName + '\n');
console.log(`构建完成：dist/page-review/（${files.length}个文件）与dist/${archiveName}（${archive.length}字节）`);
