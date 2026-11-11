import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), extension = path.join(root, 'extension');
const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8'));
assert.equal(manifest.version, JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version, '源码与安装包版本必须一致');
assert.equal(manifest.manifest_version, 3); assert.equal(manifest.action.default_popup, undefined, '工具栏图标必须直接切换开关');
assert.deepEqual(manifest.host_permissions, ['<all_urls>'], '跨网页注入和真实视口截图所需的网页权限');
assert.equal(manifest.content_scripts, undefined, '关闭时不自动注入');
let checked = 0;
for (const name of await fs.readdir(extension)) if (name.endsWith('.js')) {
  const result = spawnSync(process.execPath, ['--check', path.join(extension, name)], { encoding: 'utf8' });
  if (result.status) throw new Error(result.stderr); checked++;
  const source = await fs.readFile(path.join(extension, name), 'utf8'); assert(!/\beval\s*\(|new Function\s*\(|setInterval\s*\(/.test(source), name + ': 不使用动态脚本或定时状态查询');
}
for (const target of [manifest.background.service_worker, manifest.options_ui.page]) await fs.access(path.join(extension, target));
const html = await fs.readFile(path.join(extension, 'library.html'), 'utf8');
for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) if (!match[1].startsWith('#')) await fs.access(path.join(extension, match[1]));
console.log(`检查通过：MV3清单、单图标开关、${checked}份JavaScript语法、本地资源链接。`);
