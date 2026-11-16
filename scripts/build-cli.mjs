import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { VERSION } from "../cli/page-review.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  bun =
    process.env.PAGE_REVIEW_BUN ||
    path.join(root, ".local/toolchain/bun-darwin-aarch64/bun");
const origin =
    process.env.PAGE_REVIEW_CLOUD_ORIGIN || "https://review.paws.rodeo",
  u = new URL(origin);
if (u.protocol !== "https:" || u.origin !== origin)
  throw Error("分发需要固定HTTPS源");
const dir = path.join(root, "dist/cli/releases", VERSION);
await fs.mkdir(dir, { recursive: true });
const sums = [],
  files = [];
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
    files.push(name);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
await fs.writeFile(path.join(dir, "SHA256SUMS"), sums.join("\n") + "\n");
files.push("SHA256SUMS");
await fs.writeFile(
  path.join(dir, "manifest.json"),
  JSON.stringify({ version: VERSION, files }) + "\n",
);
await fs.writeFile(
  path.join(root, "dist/cli/install.sh"),
  (await fs.readFile(path.join(root, "cli/install.sh"), "utf8")).replace(
    "__API_ORIGIN__",
    origin,
  ),
);
console.log("CLI制品就绪：dist/cli；尚未发布");
