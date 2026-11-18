import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url),
  Core = require("../extension/core.js");
const manifest = JSON.parse(
  await fs.readFile(path.join(root, "extension/manifest.json"), "utf8"),
);
const files = [
  "manifest.json",
  "core.js",
  "db.js",
  "background.js",
  "content.js",
  "library.html",
  "library.css",
  "library.js",
  "cloud.js",
  "cloud-config.js",
  "media.js",
  "recorder.js",
  "offscreen.html",
  "offscreen.js",
];
const isDev = process.env.PAGE_REVIEW_DEV === "1";
const output = path.join(
  root,
  isDev ? ".local/native-extension" : "dist/page-review",
);
await fs.mkdir(output, { recursive: true });
for (const file of files)
  await fs.copyFile(
    path.join(root, "extension", file),
    path.join(output, file),
  );
await fs.writeFile(
  path.join(output, "content-style.js"),
  "globalThis.PageReviewStyles = " +
    JSON.stringify(
      await fs.readFile(path.join(root, "extension/content.css"), "utf8"),
    ) +
    ";\n",
);
files.push("content-style.js");
await fs.mkdir(path.join(output,"icons"),{recursive:true});
for (const size of [16,32,48,128]) { const name=`icons/${size}.png`; await fs.copyFile(path.join(root,"extension",name),path.join(output,name)); files.push(name); }
const selectedOrigin =
  process.env.PAGE_REVIEW_CLOUD_ORIGIN || "https://review.paws.rodeo";
if (selectedOrigin) {
  const url = new URL(selectedOrigin);
  if (
    !(
      url.protocol === "https:" ||
      (isDev && url.protocol === "http:" && url.hostname === "127.0.0.1")
    ) ||
    url.origin !== selectedOrigin
  )
    throw new Error("云空间需要确定的HTTPS源地址");
}
const builtManifest = {
  ...manifest,
  ...(isDev
    ? {
        name: "Page Review · 开发验收",
        host_permissions: ["http://127.0.0.1/*"],
        web_accessible_resources: [{ resources:["icons/48.png"], matches:["http://127.0.0.1/*"] }],
      }
    : {}),
  content_security_policy: {
    extension_pages: manifest.content_security_policy.extension_pages.replace(
      "connect-src 'none'",
      selectedOrigin ? "connect-src " + selectedOrigin : "connect-src 'none'",
    ),
  },
};
await fs.writeFile(
  path.join(output, "manifest.json"),
  JSON.stringify(builtManifest, null, 2) + "\n",
);
await fs.writeFile(
  path.join(output, "cloud-config.js"),
  "globalThis.PageReviewCloudConfig = " +
    JSON.stringify({
      apiOrigin: selectedOrigin,
      ...(isDev ? { pageOrigins: ["http://127.0.0.1/*"] } : {}),
    }) +
    ";\n",
);
const archive = Core.zip(
  await Promise.all(
    files.map(async (name) => ({
      name,
      data: await fs.readFile(path.join(output, name)),
    })),
  ),
);
const archiveName = `page-review-${manifest.version}${isDev ? "-dev" : ""}.zip`;
await fs.writeFile(path.join(root, "dist", archiveName), archive);
await fs.writeFile(
  path.join(root, "dist", archiveName + ".sha256"),
  createHash("sha256").update(archive).digest("hex") +
    "  " +
    archiveName +
    "\n",
);
console.log(
  `构建完成：${path.relative(root, output)}/（${files.length}个文件）与dist/${archiveName}（${archive.length}字节）`,
);
