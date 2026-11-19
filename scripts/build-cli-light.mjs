import { renderCliInstaller } from "./render-cli-installer.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { VERSION } from "../cli/page-review.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export async function buildLightCli() {
  const bun = process.env.PAGE_REVIEW_BUN || path.join(root, ".local/toolchain/bun-darwin-aarch64/bun");
  const dir = path.join(root, "dist/cli/releases", VERSION);
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(path.join(root, ".local"), { recursive: true });
  const staging = await fs.mkdtemp(path.join(root, ".local/cli-light-"));
  try {
    // Bundle local imports into one executable script; Node built-ins stay external.
    execFileSync(bun, ["build", "cli/page-review.mjs", "--target=node", "--format=esm",
      "--minify", "--outfile", path.join(staging, "page-review")], { cwd: root, stdio: "inherit" });
    await fs.chmod(path.join(staging, "page-review"), 0o755);
    const name = "page-review-node.tar.gz";
    execFileSync("/usr/bin/tar", ["-czf", path.join(dir, name), "-C", staging, "page-review"]);
    const bytes = await fs.readFile(path.join(dir, name));
    const sum = createHash("sha256").update(bytes).digest("hex") + "  " + name;
    await fs.writeFile(path.join(dir, "SHA256SUMS.node"), sum + "\n");
    const origin = process.env.PAGE_REVIEW_CLOUD_ORIGIN || "https://review.paws.rodeo";
    const installer = await renderCliInstaller(origin);
    await fs.mkdir(path.join(root, "dist/cli/installers"), { recursive: true });
    await fs.writeFile(path.join(root, "dist/cli/installers", VERSION + "-r1.sh"), installer);
    await fs.writeFile(path.join(root, "dist/cli/install.sh"), installer);
    console.log(`Node轻量CLI：${bytes.length}字节；尚未发布`);
    return { name, sum };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) await buildLightCli();
