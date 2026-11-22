#!/bin/sh
set -eu
umask 077
[ "$(uname -s)" = Darwin ] || { echo 'Page Review 首版仅支持 macOS' >&2; exit 1; }
case "$(uname -m)" in arm64) arch=arm64;; x86_64) arch=x64;; *) echo '暂不支持此 Mac 架构' >&2; exit 1;; esac
version=__CLI_VERSION__
read_protocol=__READ_PROTOCOL__
origin='__API_ORIGIN__'
flavor="${PAGE_REVIEW_CLI_FLAVOR:-auto}"
has_node=false
if command -v node >/dev/null 2>&1 && node --use-env-proxy -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' </dev/null 2>/dev/null; then has_node=true; fi
case "$flavor" in
  auto) if [ "$has_node" = true ]; then flavor=node; else flavor=standalone; fi;;
  node) [ "$has_node" = true ] || { echo '轻量版需要支持 --use-env-proxy 的 Node 22 或更高版本；可用PAGE_REVIEW_CLI_FLAVOR=standalone选择独立版' >&2; exit 1; };;
  standalone) :;;
  *) echo 'PAGE_REVIEW_CLI_FLAVOR只接受auto、node或standalone' >&2; exit 1;;
esac
if [ "$flavor" = node ]; then
  artifact=page-review-node.tar.gz
  sums=SHA256SUMS.node
  echo '[1/4] 使用已有Node，下载轻量CLI（不重复安装运行时）' >&2
else
  artifact="page-review-darwin-$arch.tar.gz"
  sums=SHA256SUMS
  if [ "${PAGE_REVIEW_CLI_FLAVOR:-auto}" = auto ] && command -v node >/dev/null 2>&1; then
    echo '[1/4] 当前 PATH 中的 Node 未通过轻量版兼容性检测（需 Node 22+ 且支持 --use-env-proxy）' >&2
  fi
  echo '[1/4] 使用独立CLI（约40MB，无需Node/Bun）；将显示下载进度' >&2
fi
work=$(mktemp -d)
staging=''
staging_dir=''
backup=''
pending=false
had_previous=false
cleanup() {
  result=$?
  trap - EXIT HUP INT TERM
  if [ "$pending" = true ]; then
    if [ "$had_previous" = true ]; then
      if ! mv -f "$backup/previous" "$target"; then
        echo "恢复原 CLI 失败，备份保留在：$backup" >&2
        backup=''
        result=1
      fi
    else
      rm -f "$target"
    fi
  fi
  rm -rf "$work"
  [ -z "$backup" ] || rm -rf "$backup"
  if [ -n "$staging" ]; then rm -f "$staging"; fi
  if [ -n "$staging_dir" ]; then rmdir "$staging_dir"; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
# A failed invocation retains only the bounded package partial, not credentials.
cache_dir="${PAGE_REVIEW_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/page-review}/$version/$flavor-$arch"
mkdir -p "$cache_dir"
[ -d "$cache_dir" ] && [ ! -L "$cache_dir" ] && [ -O "$cache_dir" ] || { echo '下载缓存目录不安全' >&2; exit 1; }
chmod 700 "$cache_dir"
curl -fLsS --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time 30 "$origin/releases/$version/$sums" -o "$work/SHA256SUMS"
expected=$(awk -v name="$artifact" '$2 == name {print $1}' "$work/SHA256SUMS")
[ ${#expected} -eq 64 ] || { echo '安装包校验清单无效' >&2; exit 1; }
case "$expected" in *[!0-9a-f]*) echo '安装包校验清单无效' >&2; exit 1;; esac
archive="$cache_dir/$expected-$artifact.part"
[ ! -L "$archive" ] && [ ! -d "$archive" ] || { echo '下载缓存文件不安全' >&2; exit 1; }
verified=false
if [ -f "$archive" ] && [ "$(shasum -a 256 "$archive" | awk '{print $1}')" = "$expected" ]; then verified=true; fi
if [ "$verified" = false ]; then
  echo '[2/4] 下载安装包；中断后保留已下载部分，再运行同一命令可续传' >&2
  if ! curl -fL --progress-bar --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time "${PAGE_REVIEW_DOWNLOAD_TIMEOUT:-300}" --speed-limit 1024 --speed-time 30 -C - "$origin/releases/$version/$artifact" -o "$archive" --write-out '%{http_code}' > "$work/download-status"; then
    if [ "$(cat "$work/download-status")" = 416 ]; then
      rm -f "$archive"
      echo '服务端拒绝续传范围，已清除无效缓存；再次运行可重新下载。' >&2
    fi
    echo '下载未完成，原CLI未改动。有效的部分下载将在下次运行时复用。' >&2
    echo '请检查网络后再次运行安装命令；不会自动重试或循环查询。' >&2
    exit 1
  fi
else
  echo '[2/4] 已有校验通过的完整缓存，跳过下载' >&2
fi
echo '[3/4] 校验SHA-256并检查安装包' >&2
actual=$(shasum -a 256 "$archive" | awk '{print $1}')
if [ "$actual" != "$expected" ]; then
  rm -f "$archive"
  echo '安装包校验失败，已清除损坏下载，原CLI未改动' >&2
  exit 1
fi
[ "$(tar -tzf "$archive")" = page-review ] || { echo '安装包内容无效，未安装' >&2; exit 1; }
case "$(tar -tvzf "$archive")" in -*) :;; *) echo '安装包必须包含普通文件' >&2; exit 1;; esac
tar -xzf "$archive" -C "$work"
[ -f "$work/page-review" ] && [ ! -L "$work/page-review" ] || exit 1
if [ "$flavor" = node ]; then
  # Reuse the terminal's existing HTTP(S)_PROXY and NO_PROXY in this process.
  # The archived JS stays immutable; normalize only its installed launch line.
  { printf '%s\n' '#!/usr/bin/env -S node --use-env-proxy'; tail -n +2 "$work/page-review"; } > "$work/node-cli"
  mv "$work/node-cli" "$work/page-review"
  chmod 755 "$work/page-review"
fi
if ! candidate_version=$("$work/page-review" --version </dev/null); then
  echo 'CLI版本命令未正常退出，原CLI未改动' >&2
  exit 1
fi
[ "$candidate_version" = "$version" ] || { echo 'CLI版本校验失败，未安装' >&2; exit 1; }
install_dir="${PAGE_REVIEW_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$install_dir"
target="$install_dir/page-review"
[ ! -d "$target" ] || { echo '安装目标是目录，未安装' >&2; exit 1; }
staging_dir=$(mktemp -d "$install_dir/.page-review-stage.XXXXXX")
staging="$staging_dir/page-review"
cp "$work/page-review" "$staging"
chmod 755 "$staging"
echo '[4/4] 安装到原目录；保留原连接配置' >&2
candidate_version=$("$staging" --version </dev/null) || {
  code=$?
  printf '安装目录内的 CLI 版本命令执行失败（退出码 %s），原CLI未改动\n' "$code" >&2
  exit 1
}
[ "$candidate_version" = "$version" ] || {
  printf '安装目录内的 CLI 未返回预期版本 %s，原CLI未改动\n' "$version" >&2
  exit 1
}
candidate_protocol=$("$staging" --protocol-version </dev/null) || { echo 'CLI读取协议校验失败，原CLI未改动' >&2; exit 1; }
[ "$candidate_protocol" = "$read_protocol" ] || { echo 'CLI读取协议不支持本版网页引用，原CLI未改动' >&2; exit 1; }
backup=$(mktemp -d "$install_dir/.page-review-backup.XXXXXX")
if [ -e "$target" ] || [ -L "$target" ]; then
  cp -Pp "$target" "$backup/previous"
  had_previous=true
fi
pending=true
mv -f "$staging" "$target"
installed_version=$("$target" --version </dev/null) || { echo '安装后版本校验失败，恢复原CLI' >&2; exit 1; }
[ "$installed_version" = "$version" ] || { echo '安装后版本校验失败，恢复原CLI' >&2; exit 1; }
installed_protocol=$("$target" --protocol-version </dev/null) || { echo '安装后读取协议校验失败，恢复原CLI' >&2; exit 1; }
[ "$installed_protocol" = "$read_protocol" ] || { echo '安装后读取协议校验失败，恢复原CLI' >&2; exit 1; }
pending=false
echo "已安装：${target}（${flavor}），版本 $version 已验证"
case ":$PATH:" in *":$install_dir:"*) echo '接着运行：page-review login';; *) echo '将 ~/.local/bin 加入 PATH，或运行：~/.local/bin/page-review login';; esac

# Paws uses the Skill directory of its selected execution host.
codex_home="$HOME/.agents"
claude_home=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
hosts=0
skill_failed=false
install_skill() {
  hosts=$((hosts + 1))
  skill_target="$2/skills/page-review"
  # Existing manually installed Skills and links may have another update source.
  if [ -L "$skill_target" ] || { [ -e "$skill_target" ] &&
      ! grep -Fqx '<!-- Managed by the Page Review CLI installer -->' "$skill_target/SKILL.md"; }; then
    echo "$1 Skill 已存在，保留原安装：$skill_target" >&2
    skill_failed=true
    return
  fi
  if ! (
    mkdir -p "$2/skills" || exit 1
    skill_stage=$(mktemp -d "$2/skills/.page-review-stage.XXXXXX") || exit 1
    trap 'rm -rf "$skill_stage"' EXIT
    cp -R "$work/skill" "$skill_stage/page-review" || exit 1
    if [ -d "$skill_target" ]; then
      # Refresh the shipped files individually, preserving local extras.
      for file in references/connect.md scripts/connect.mjs scripts/connection.mjs scripts/read.mjs SKILL.md; do
        parent="${file%/*}"
        if [ "$parent" != "$file" ]; then
          [ ! -L "$skill_target/$parent" ] || exit 1
          mkdir -p "$skill_target/$parent" || exit 1
        fi
        [ ! -d "$skill_target/$file" ] || exit 1
      done
      for file in references/connect.md scripts/connect.mjs scripts/connection.mjs scripts/read.mjs SKILL.md; do
        mv -fh "$skill_stage/page-review/$file" "$skill_target/$file" || exit 1
      done
    else
      # macOS mv -h refuses to follow a directory symlink at the destination.
      mv -h "$skill_stage/page-review" "$2/skills/"
    fi
  ); then
    echo "$1 Skill 安装失败，可再次运行安装命令：$skill_target" >&2
    skill_failed=true
    return
  fi
  echo "$1 Skill 已安装：$skill_target"
}

mkdir -p "$work/skill/references" "$work/skill/scripts"
# __SKILL_PAYLOAD__
[ -s "$work/skill/SKILL.md" ] || { echo '安装脚本缺少 Skill 内容，请从原入口重新下载' >&2; exit 1; }
if command -v codex >/dev/null 2>&1 || [ -d "${CODEX_HOME:-$HOME/.codex}" ]; then
  install_skill Codex "$codex_home"
fi
if command -v claude >/dev/null 2>&1 || [ -d "$claude_home" ]; then
  install_skill 'Claude Code' "$claude_home"
fi
if [ "$hosts" -eq 0 ]; then
  echo '未检测到 Codex 或 Claude Code。CLI 已安装；安装宿主后重新运行同一命令即可添加 Skill。'
fi
[ "$skill_failed" = false ]
