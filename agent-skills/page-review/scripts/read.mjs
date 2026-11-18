import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig, request, verifyReader } from './connection.mjs';

export async function consume(argv, env = process.env) {
  const [command, ...args] = argv, options = {}, positional = [];
  for (let i = 0; i < args.length; i++) { if (args[i].startsWith('--')) { const key = args[i].slice(2); if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('参数缺少值：' + key); options[key] = args[++i]; } else positional.push(args[i]); }
  const config = await loadConfig(env), origin = config.apiUrl;
  if (command === 'status') {
    await verifyReader(config);
    const result = await (await request(config, '/v1/annotations?limit=1')).json();
    return { connected: true, access: 'reader', library: result.items.length ? 'has_synced_records' : 'empty', scope: '已同步的网页评注、摘录、历史与记录时截图' };
  }
  let target;
  if (command === 'search') { target = new URL('/v1/annotations', origin); for (const key of ['q', 'domain', 'feedback', 'cursor', 'limit']) if (options[key]) target.searchParams.set(key, options[key]); }
  else if (command === 'context' && /^[a-zA-Z0-9-]{8,80}$/.test(positional[0] || '')) target = new URL('/v1/annotations/' + positional[0] + '/context', origin);
  else if (command === 'image' && /^[a-f0-9]{64}$/.test(positional[0] || '') && path.isAbsolute(options.out || '')) target = new URL('/v1/assets/' + positional[0], origin);
  else throw new Error('用法：status | search [--q 关键词] | context ID | image SHA256 --out 绝对路径');
  const response = await request(config, target.pathname + target.search);
  if (command !== 'image') return response.json();
  if (!['image/png', 'image/jpeg'].includes(response.headers.get('content-type')?.split(';')[0])) throw new Error('接口未返回PNG/JPEG');
  const chunks = []; let length = 0;
  for await (const chunk of response.body) { length += chunk.length; if (length > 8_000_000) throw new Error('图片超过读取上限'); chunks.push(chunk); }
  const data = Buffer.concat(chunks), sha = createHash('sha256').update(data).digest('hex'); if (sha !== positional[0]) throw new Error('图片摘要不符');
  await fs.mkdir(path.dirname(options.out), { recursive: true }); await fs.writeFile(options.out, data, { flag: 'wx', mode: 0o600 });
  return { file: options.out, sha256: sha, bytes: data.length };
}
if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await consume(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
