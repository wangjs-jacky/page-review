import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configPath, readConfigFile, verifyReader } from './connection.mjs';

export async function connect(argv, env = process.env) {
  if (argv.length !== 2 || argv[0] !== '--from' || !path.isAbsolute(argv[1])) throw new Error('用法：node scripts/connect.mjs --from 配置JSON的绝对路径；不要将密钥写入参数');
  if (env.PAGE_REVIEW_TOKEN || env.PAGE_REVIEW_API_URL) throw new Error('请先移除旧PAGE_REVIEW_TOKEN和PAGE_REVIEW_API_URL覆盖，再导入默认连接');
  const destination = configPath(env);
  try { await fs.lstat(destination); throw new Error('已有连接配置，未覆盖。更换账号前请在资料库撤销旧连接，并将旧配置移至私有备份后再导入'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const config = await readConfigFile(argv[1], { importing: true });
  await verifyReader(config);
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.writeFile(destination, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return { connected: true, access: 'reader', configFile: destination, next: '连接已验证。现在可以说：参考我在Page Review保存的导航案例，读取原评论和截图，给出建议。首次下载的配置仍含密钥，请妥善保管。' };
}
if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await connect(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
