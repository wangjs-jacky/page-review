import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CLI_VERSION, READ_PROTOCOL } from "../cloud/cli-release.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const release = path.join(root, "dist/cli/releases", CLI_VERSION);
const name = "page-review-node.tar.gz";
const archive = await fs.readFile(path.join(release, name));
const checksums = await fs.readFile(path.join(release, "SHA256SUMS.node"), "utf8");
assert(checksums.split("\n").includes(
  createHash("sha256").update(archive).digest("hex") + "  " + name,
), "捆绑CLI与分发摘要不一致");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "page-review-bundle-check-"));
try {
  execFileSync("tar", ["-xzf", path.join(release, name), "-C", temporary]);
  const executable = path.join(temporary, "page-review");
  const probe = flag => execFileSync(process.execPath, [executable, flag], { encoding: "utf8" }).trim();
  assert.equal(probe("--version"), CLI_VERSION);
  assert.equal(probe("--protocol-version"), String(READ_PROTOCOL));
  const result = spawnSync(process.execPath, ["--test", "tests/cli.test.cjs", "tests/cli-release.test.cjs"], {
    cwd: root,
    env: { ...process.env, PAGE_REVIEW_TEST_BUNDLE: pathToFileURL(executable).href },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
