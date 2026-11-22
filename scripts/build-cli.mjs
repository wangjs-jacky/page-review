import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildLightCli, writeCliManifest } from "./build-cli-light.mjs";
import { CLI_VERSION as VERSION } from "../cloud/cli-release.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  bun =
    process.env.PAGE_REVIEW_BUN ||
    path.join(root, ".local/toolchain/bun-darwin-aarch64/bun");
const dir = path.join(root, "dist/cli/releases", VERSION);
await fs.mkdir(dir, { recursive: true });
await fs.mkdir(path.join(root, ".local"), { recursive: true });
await buildLightCli();
const sums = [];
for (const arch of ["arm64", "x64"]) {
  const staging = await fs.mkdtemp(path.join(root, ".local/cli-build-"));
  try {
    execFileSync(
      bun,
      [
        "build",
        "cli/page-review.mjs",
        "--compile",
        "--target=bun-darwin-" + arch,
        "--outfile",
        path.join(staging, "page-review"),
      ],
      { cwd: root, stdio: "inherit" },
    );
    const name = "page-review-darwin-" + arch + ".tar.gz";
    execFileSync("/usr/bin/tar", [
      "-czf",
      path.join(dir, name),
      "-C",
      staging,
      "page-review",
    ]);
    sums.push(
      createHash("sha256")
        .update(await fs.readFile(path.join(dir, name)))
        .digest("hex") +
        "  " +
        name,
    );
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
await fs.writeFile(path.join(dir, "SHA256SUMS"), sums.join("\n") + "\n");
await writeCliManifest();
await fs.copyFile(
  path.join(root, "dist/cli/install.sh"),
  path.join(dir, "install.sh"),
);
console.log("CLI制品就绪：dist/cli；尚未发布");
