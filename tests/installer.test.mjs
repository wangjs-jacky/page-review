import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { VERSION } from "../cli/page-review.mjs";
const exec = promisify(execFile), root = path.resolve(import.meta.dirname, "..");

test("真实HTTPS安装：自动选择运行时、版本校验与失败恢复", async (t) => {
  if (process.platform !== "darwin") return t.skip("需要真实macOS");
  const release = path.join(root, "dist/cli/releases", VERSION);
  // Integration tests require real artifacts; absence is an error, not a false pass.
  const light = await fs.readFile(path.join(release, "page-review-node.tar.gz"));
  const nativeName = `page-review-darwin-${process.arch === "arm64" ? "arm64" : "x64"}.tar.gz`;
  const native = await fs.readFile(path.join(release, nativeName));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "page-review-install-"));
  const cert = path.join(dir, "cert.pem"), key = path.join(dir, "key.pem");
  await exec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
    "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"]);
  await fs.chmod(key, 0o600);
  const installer = await fs.readFile(path.join(root, "cli/install.sh"), "utf8");
  let origin, scenario;
  const server = https.createServer({ key: await fs.readFile(key), cert: await fs.readFile(cert) }, (req, res) => {
    scenario.requests.push(req.url);
    if (req.url === "/install.sh") return res.end(installer.replace("__API_ORIGIN__", origin));
    const name = req.url.split("/").at(-1);
    if (!req.url.startsWith(`/releases/${VERSION}/`)) { res.writeHead(404); return res.end(); }
    if (name.startsWith("SHA256SUMS")) {
      const bytes = scenario.payload || (scenario.selected === "node" ? light : native);
      return res.end((scenario.badHash ? "0".repeat(64) : createHash("sha256").update(bytes).digest("hex")) +
        "  " + scenario.artifact + "\n");
    }
    if (name !== scenario.artifact || scenario.downloadFailure) { res.writeHead(404); return res.end(); }
    res.end(scenario.payload || (scenario.selected === "node" ? light : native));
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  origin = "https://127.0.0.1:" + server.address().port;
  async function fixture(body) {
    const stage = await fs.mkdtemp(path.join(dir, "fixture-"));
    await fs.writeFile(path.join(stage, "page-review"), body, { mode: 0o755 });
    await exec("/usr/bin/tar", ["-czf", path.join(stage, "fixture.tar.gz"), "-C", stage, "page-review"]);
    return fs.readFile(path.join(stage, "fixture.tar.gz"));
  }
  async function check(label, { runtime = "current", selected = "node", arch, payload, badHash = false,
    downloadFailure = false, fail = false, installed = true, error } = {}) {
    await t.test(label, async () => {
      const sandbox = await fs.mkdtemp(path.join(dir, "case with spaces-"));
      const bin = path.join(sandbox, "bin"), installDir = path.join(sandbox, "install with spaces");
      await fs.mkdir(bin); await fs.mkdir(installDir);
      const target = path.join(installDir, "page-review"), config = path.join(sandbox, "connection.json");
      if (installed) await fs.writeFile(target, "previous-cli", { mode: 0o755 });
      await fs.writeFile(config, "preserve-connection", { mode: 0o600 });
      if (runtime === "current" || runtime.startsWith("/"))
        await fs.symlink(runtime === "current" ? process.execPath : runtime, path.join(bin, "node"));
      if (runtime === "old" || runtime === "broken") {
        await fs.writeFile(path.join(bin, "node"), runtime === "old" ?
          '#!/bin/sh\n# Simulate a running Node 23 whose version probe rejects compatibility.\nexit 1\n' :
          '#!/bin/sh\nexit 126\n', { mode: 0o755 });
      }
      if (arch) await fs.writeFile(path.join(bin, "uname"),
        `#!/bin/sh\ncase "$1" in -s) echo Darwin;; -m) echo ${arch};; esac\n`, { mode: 0o755 });
      scenario = { selected, payload, badHash, downloadFailure, requests: [],
        artifact: selected === "node" ? "page-review-node.tar.gz" :
          `page-review-darwin-${arch === "x86_64" ? "x64" : arch || process.arch}.tar.gz` };
      const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: sandbox,
        PAGE_REVIEW_INSTALL_DIR: installDir, PAGE_REVIEW_CONFIG: config, PAGE_REVIEW_CACHE_DIR: path.join(sandbox, "cache"),
        CURL_CA_BUNDLE: cert, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" };
      // Verify that the absence case really has no Node on its effective PATH.
      if (runtime === "missing") await assert.rejects(exec("/bin/sh", ["-c", "command -v node"], { env }));
      const run = () => exec("/bin/sh", ["-c", `curl -fsSL '${origin}/install.sh' | sh`], { env, timeout: 30000 });
      if (fail) {
        await assert.rejects(run(), e => error.test(e.stderr));
        if (installed) assert.equal(await fs.readFile(target, "utf8"), "previous-cli");
        else await assert.rejects(fs.access(target), { code: "ENOENT" });
      } else {
        const result = await run();
        assert.match(result.stdout, /版本 0\.4\.2 已验证/, result.stderr);
        assert.equal((await exec(target, ["--version"], { env })).stdout.trim(), VERSION);
        assert.equal((await fs.stat(target)).mode & 0o777, 0o755);
      }
      assert.equal(await fs.readFile(config, "utf8"), "preserve-connection");
      assert.deepEqual((await fs.readdir(installDir)).filter(n => n.startsWith(".page-review")), []);
      assert(scenario.requests.includes(`/releases/${VERSION}/${scenario.artifact}`));
      assert(scenario.requests.every(url => !url.endsWith(".tar.gz") || url.endsWith(scenario.artifact)));
    });
  }
  try {
    await check("已有Node 24：同一curl命令只下载真实轻量包");
    if (process.env.PAGE_REVIEW_TEST_NODE22)
      await check("已有Node 22：同一curl命令只下载真实轻量包", { runtime: process.env.PAGE_REVIEW_TEST_NODE22 });
    await check("没有Node：真实本机架构自包含包可运行", { runtime: "missing", selected: "standalone" });
    await check("旧Node：回退自包含包", { runtime: "old", selected: "standalone" });
    await check("Node无法启动：回退自包含包", { runtime: "broken", selected: "standalone" });
    const versionScript = `#!/bin/sh\nprintf '%s\\n' '${VERSION}'\n`;
    await check("Intel架构选择x64包（模拟架构，非Intel真机验收）", { runtime: "missing", selected: "standalone", arch: "x86_64", payload: await fixture(versionScript) });
    await check("摘要错误保留旧CLI", { badHash: true, fail: true, error: /安装包校验失败/ });
    await check("下载失败保留旧CLI", { downloadFailure: true, fail: true, error: /404/ });
    await check("错误版本即使零退出也拒绝覆盖", { runtime: "missing", selected: "standalone", payload: await fixture("#!/bin/sh\necho 0.0.0\n"), fail: true, error: /CLI版本校验失败|CLI版本命令未正常退出/ });
    await check("版本命令非零退出拒绝覆盖", { runtime: "missing", selected: "standalone", payload: await fixture(`#!/bin/sh\necho ${VERSION}\nexit 1\n`), fail: true, error: /CLI版本校验失败|CLI版本命令未正常退出/ });
    const basenameSensitive = await fixture(`#!/bin/sh\n[ "\${0##*/}" = page-review ] || exit 7\necho ${VERSION}\n`);
    await check("保留 CLI 文件名执行安装目录预检", {
      runtime: "missing", selected: "standalone", payload: basenameSensitive,
    });
    const stageFailure = await fixture(`#!/bin/sh\ncase "$0" in */.page-review-stage.*/*) exit 7;; esac\necho ${VERSION}\n`);
    await check("安装目录执行失败报告退出码并保留旧CLI", {
      runtime: "missing", selected: "standalone", payload: stageFailure, fail: true,
      error: /安装目录内的 CLI 版本命令执行失败（退出码 7）/,
    });
    const postFailure = await fixture(`#!/bin/sh\ncase "$0" in *"/install with spaces/page-review") echo wrong;; *) echo ${VERSION};; esac\n`);
    await check("最终安装路径版本验证失败恢复旧CLI", { runtime: "missing", selected: "standalone", payload: postFailure, fail: true, error: /安装后版本校验失败/ });
    await check("首次安装后验证失败移除新CLI", { runtime: "missing", selected: "standalone", payload: postFailure, installed: false, fail: true, error: /安装后版本校验失败/ });
    console.log(JSON.stringify({ lightArchiveBytes: light.length, nativeArchiveBytes: native.length, node: process.version, nativeArch: process.arch }));
  } finally {
    server.closeAllConnections(); await new Promise(r => server.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
