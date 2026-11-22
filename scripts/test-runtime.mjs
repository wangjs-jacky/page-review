import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
let runtime;
try {
  runtime = require.resolve("miniflare");
} catch {
  console.error("缺少项目 Miniflare 开发依赖，请先运行 npm ci；真实运行时回归未执行。");
  process.exit(1);
}

const result = spawnSync(process.execPath, [
  "--test",
  "tests/workerd.test.mjs",
  "tests/distribution-runtime.test.mjs",
], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env, PAGE_REVIEW_MINIFLARE_MODULE: pathToFileURL(runtime).href },
  stdio: "inherit",
});
if (result.error) console.error("无法运行真实运行时回归：" + result.error.message);
process.exitCode = result.status ?? 1;
