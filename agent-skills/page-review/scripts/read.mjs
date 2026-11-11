import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export async function consume(argv, env = process.env) {
  const [command, ...args] = argv, options = {}, positional = [];
  for (let i = 0; i < args.length; i++) { if (args[i].startsWith('--')) { const key = args[i].slice(2); if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('参数缺少值：' + key); options[key] = args[++i]; } else positional.push(args[i]); }
  let config = {}; if (env.PAGE_REVIEW_CONFIG) config = JSON.parse(await fs.readFile(env.PAGE_REVIEW_CONFIG, 'utf8'));
  const origin = new URL(env.PAGE_REVIEW_API_URL || config.apiUrl || 'https://missing.invalid');
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname)))) throw new Error('配置需要HTTPS源地址；本机验证允许loopback');
  const token = env.PAGE_REVIEW_TOKEN || config.token; if (!/^pr_[A-Za-z0-9_-]{32,}$/.test(token || '')) throw new Error('请先配置Agent只读连接');
  let target;
  if (command === 'search') { target = new URL('/v1/annotations', origin); for (const key of ['q', 'domain', 'feedback', 'cursor', 'limit']) if (options[key]) target.searchParams.set(key, options[key]); }
  else if (command === 'context' && /^[a-zA-Z0-9-]{8,80}$/.test(positional[0] || '')) target = new URL('/v1/annotations/' + positional[0] + '/context', origin);
  else if (command === 'image' && /^[a-f0-9]{64}$/.test(positional[0] || '') && path.isAbsolute(options.out || '')) target = new URL('/v1/assets/' + positional[0], origin);
  else throw new Error('用法：search [--q 关键词] | context ID | image SHA256 --out 绝对路径');
  const response = await fetch(target, { headers: { Authorization: 'Bearer ' + token }, redirect: 'manual', signal: AbortSignal.timeout(20000) });
  if (!response.ok) { let message; try { message = (await response.json()).message; } catch {} throw new Error('读取失败 ' + response.status + '：' + (message || '连接或权限无效')); }
  if (command !== 'image') return response.json();
  if (!['image/png', 'image/jpeg'].includes(response.headers.get('content-type')?.split(';')[0])) throw new Error('接口未返回PNG/JPEG');
  const chunks = []; let length = 0;
  for await (const chunk of response.body) { length += chunk.length; if (length > 8_000_000) throw new Error('图片超过读取上限'); chunks.push(chunk); }
  const data = Buffer.concat(chunks), sha = createHash('sha256').update(data).digest('hex'); if (sha !== positional[0]) throw new Error('图片摘要不符');
  await fs.mkdir(path.dirname(options.out), { recursive: true }); await fs.writeFile(options.out, data, { flag: 'wx', mode: 0o600 });
  return { file: options.out, sha256: sha, bytes: data.length };
}
if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  try { console.log(JSON.stringify(await consume(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
