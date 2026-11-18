#!/bin/sh
set -eu
umask 077
[ "$(uname -s)" = Darwin ] || { echo 'Page Review 首版仅支持 macOS' >&2; exit 1; }
case "$(uname -m)" in arm64) arch=arm64;; x86_64) arch=x64;; *) echo '暂不支持此 Mac 架构' >&2; exit 1;; esac
version=0.4.2
origin='__API_ORIGIN__'
artifact="page-review-darwin-$arch.tar.gz"
sums=SHA256SUMS
flavor=standalone
# Run the candidate runtime: an executable on PATH may be broken or too old.
if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' </dev/null >/dev/null 2>&1; then
  artifact=page-review-node.tar.gz
  sums=SHA256SUMS.node
  flavor=node
  echo '检测到兼容的 Node 24+，安装轻量 JS 包' >&2
else
  echo "未检测到兼容的 Node 24+，安装 macOS $arch 自包含包" >&2
fi
work=$(mktemp -d)
staging=''
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
  [ -z "$staging" ] || rm -f "$staging"
  [ -z "$backup" ] || rm -rf "$backup"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
curl -fLsS --proto '=https' --tlsv1.2 "$origin/releases/$version/$artifact" -o "$work/$artifact"
curl -fLsS --proto '=https' --tlsv1.2 "$origin/releases/$version/$sums" -o "$work/SHA256SUMS"
expected=$(awk -v name="$artifact" '$2 == name {print $1}' "$work/SHA256SUMS")
[ ${#expected} -eq 64 ] || { echo '安装包校验清单无效' >&2; exit 1; }
case "$expected" in *[!0-9a-f]*) echo '安装包校验清单无效' >&2; exit 1;; esac
actual=$(shasum -a 256 "$work/$artifact" | awk '{print $1}')
[ "$actual" = "$expected" ] || { echo '安装包校验失败，未安装' >&2; exit 1; }
[ "$(tar -tzf "$work/$artifact")" = page-review ] || { echo '安装包内容无效' >&2; exit 1; }
case "$(tar -tvzf "$work/$artifact")" in -*) :;; *) echo '安装包必须包含普通文件' >&2; exit 1;; esac
tar -xzf "$work/$artifact" -C "$work"
[ -f "$work/page-review" ] && [ ! -L "$work/page-review" ] || exit 1
install_dir="${PAGE_REVIEW_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$install_dir"
target="$install_dir/page-review"
[ ! -d "$target" ] || { echo '安装目标是目录，未安装' >&2; exit 1; }
staging=$(mktemp "$install_dir/.page-review-XXXXXX")
cp "$work/page-review" "$staging"
chmod 755 "$staging"
candidate_version=$("$staging" --version </dev/null) || { echo 'CLI版本校验失败，原CLI未改动' >&2; exit 1; }
[ "$candidate_version" = "$version" ] || { echo 'CLI版本校验失败，原CLI未改动' >&2; exit 1; }
backup=$(mktemp -d "$install_dir/.page-review-backup.XXXXXX")
if [ -e "$target" ] || [ -L "$target" ]; then
  cp -Pp "$target" "$backup/previous"
  had_previous=true
fi
pending=true
mv -f "$staging" "$target"
installed_version=$("$target" --version </dev/null) || { echo '安装后版本校验失败，恢复原CLI' >&2; exit 1; }
[ "$installed_version" = "$version" ] || { echo '安装后版本校验失败，恢复原CLI' >&2; exit 1; }
pending=false
echo "已安装：${target}（${flavor}），版本 $version 已验证"
case ":$PATH:" in *":$install_dir:"*) echo '接着运行：page-review login';; *) echo '将 ~/.local/bin 加入 PATH，或运行：~/.local/bin/page-review login';; esac
