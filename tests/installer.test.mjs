import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile),
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
test("macOS curl HTTPS安装无需Node/npx/sudo；错误摘要不覆盖已有CLI", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("需要真实macOS");
    return;
  }
  try {
    await fs.access(
      path.join(
        root,
        "dist/cli/releases/0.4.0/page-review-darwin-arm64.tar.gz",
      ),
    );
  } catch {
    t.skip("先运行build:cli");
    return;
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "page-review-install-")),
    cert = path.join(dir, "cert.pem"),
    key = path.join(dir, "key.pem");
  await exec("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
  ]);
  await fs.chmod(key, 0o600);
  let origin,
    bad = false;
  const server = https.createServer(
    { key: await fs.readFile(key), cert: await fs.readFile(cert) },
    async (req, res) => {
      try {
        let data;
        if (req.url === "/install.sh")
          data = (
            await fs.readFile(path.join(root, "cli/install.sh"), "utf8")
          ).replace("__API_ORIGIN__", origin);
        else if (
          /^\/releases\/0\.4\.0\/(SHA256SUMS|page-review-darwin-(arm64|x64)\.tar\.gz)$/.test(
            req.url,
          )
        )
          data = await fs.readFile(path.join(root, "dist/cli", req.url));
        else {
          res.writeHead(404);
          res.end();
          return;
        }
        if (bad && req.url.endsWith("/SHA256SUMS"))
          data = String(data).replace(/^[a-f0-9]{64}/gm, "0".repeat(64));
        res.end(data);
      } catch {
        res.writeHead(500);
        res.end();
      }
    },
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = "https://127.0.0.1:" + server.address().port;
  const installDir = path.join(dir, "bin"),
    env = {
      ...process.env,
      PAGE_REVIEW_INSTALL_DIR: installDir,
      CURL_CA_BUNDLE: cert,
    };
  try {
    const result = await exec(
      "/bin/sh",
      ["-c", `curl -fsSL '${origin}/install.sh' | sh`],
      { env, maxBuffer: 1000000 },
    );
    assert.match(result.stdout, /已安装/);
    const binary = path.join(installDir, "page-review");
    assert.equal((await exec(binary, ["--version"])).stdout.trim(), "0.4.0");
    const hash = () =>
        fs
          .readFile(binary)
          .then((b) => createHash("sha256").update(b).digest("hex")),
      before = await hash();
    bad = true;
    await assert.rejects(
      exec("/bin/sh", ["-c", `curl -fsSL '${origin}/install.sh' | sh`], {
        env,
      }),
      (e) => /校验失败/.test(e.stderr),
    );
    assert.equal(await hash(), before);
    console.log("HTTPS curl安装与摘要失败回滚均通过，未修改用户安装目录。");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
