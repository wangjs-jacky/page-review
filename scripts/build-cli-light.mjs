import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { VERSION } from "../cli/page-review.mjs";

// Bundle the same CLI for an already installed Node 24+. No runtime download.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  dir = path.join(root, "dist/cli/releases", VERSION),
  bun = process.env.PAGE_REVIEW_BUN || "bun";
await fs.mkdir(dir, { recursive: true });
await fs.mkdir(path.join(root, ".local"), { recursive: true });
const staging = await fs.mkdtemp(path.join(root, ".local/cli-light-"));
try {
  execFileSync(bun, ["build", "cli/page-review.mjs", "--target=node",
    "--format=esm", "--minify", "--outfile", path.join(staging, "page-review")],
    { cwd: root, stdio: "inherit" });
  await fs.chmod(path.join(staging, "page-review"), 0o755);
  const name = "page-review-node.tar.gz";
  execFileSync("/usr/bin/tar", ["-czf", path.join(dir, name), "-C", staging, "page-review"]);
  const bytes = await fs.readFile(path.join(dir, name));
  await fs.writeFile(path.join(dir, "SHA256SUMS.node"),
    createHash("sha256").update(bytes).digest("hex") + "  " + name + "\n");
  const installerDir = path.join(root, "dist/cli/installers");
  await fs.mkdir(installerDir, { recursive: true });
  const origin = process.env.PAGE_REVIEW_CLOUD_ORIGIN || "https://review.paws.rodeo";
  if (new URL(origin).protocol !== "https:" || new URL(origin).origin !== origin)
    throw Error("分发需要固定HTTPS源");
  await fs.writeFile(path.join(installerDir, VERSION + "-r1.sh"),
    (await fs.readFile(path.join(root, "cli/install.sh"), "utf8"))
      .replace("__API_ORIGIN__", origin));
  console.log(`Node轻量CLI：${bytes.length}字节；独立运行时包及原SHA清单未改。`);
} finally {
  await fs.rm(staging, { recursive: true, force: true });
}
