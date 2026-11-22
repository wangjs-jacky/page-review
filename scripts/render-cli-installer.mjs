import fs from "node:fs/promises";
import { CLI_VERSION, READ_PROTOCOL } from "../cloud/cli-release.mjs";

const root = new URL("../", import.meta.url);
const skillRoot = new URL("agent-skills/page-review/", root);
const files = [
  "SKILL.md",
  "references/connect.md",
  "scripts/connect.mjs",
  "scripts/connection.mjs",
  "scripts/read.mjs",
];

export async function renderCliInstaller(origin) {
  if (new URL(origin).protocol !== "https:" || new URL(origin).origin !== origin)
    throw Error("分发需要固定HTTPS源");
  const template = await fs.readFile(new URL("cli/install.sh", root), "utf8");
  const commands = await Promise.all(files.map(async file => {
    const source = await fs.readFile(new URL(file, skillRoot), "utf8");
    const delimiter = "PAGE_REVIEW_SKILL_EOF";
    if (!source.endsWith("\n") || source.split("\n").includes(delimiter))
      throw Error("无法嵌入 Skill 文件：" + file);
    return `cat > "$work/skill/${file}" <<'${delimiter}' || exit 1\n${source}${delimiter}`;
  }));
  return template.replace("__API_ORIGIN__", () => origin)
    .replace("__CLI_VERSION__", () => CLI_VERSION)
    .replace("__READ_PROTOCOL__", () => String(READ_PROTOCOL))
    .replace("# __SKILL_PAYLOAD__", () => commands.join("\n"));
}
