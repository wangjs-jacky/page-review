#!/bin/sh
set -eu
umask 077
[ "$(uname -s)" = Darwin ] || { echo 'Page Review 首版仅支持 macOS' >&2; exit 1; }
case "$(uname -m)" in arm64) arch=arm64;; x86_64) arch=x64;; *) echo '暂不支持此 Mac 架构' >&2; exit 1;; esac
version=0.4.2
origin='__API_ORIGIN__'
flavor="${PAGE_REVIEW_CLI_FLAVOR:-auto}"
has_node=false
if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' </dev/null 2>/dev/null; then has_node=true; fi
case "$flavor" in
  auto) if [ "$has_node" = true ]; then flavor=node; else flavor=standalone; fi;;
  node) [ "$has_node" = true ] || { echo '轻量版需要已有Node 24+；可用PAGE_REVIEW_CLI_FLAVOR=standalone选择独立版' >&2; exit 1; };;
  standalone) :;;
  *) echo 'PAGE_REVIEW_CLI_FLAVOR只接受auto、node或standalone' >&2; exit 1;;
esac
if [ "$flavor" = node ]; then
  artifact=page-review-node.tar.gz
  sums=SHA256SUMS.node
  echo '[1/4] 使用已有Node 24+，下载轻量CLI（不重复安装运行时）' >&2
else
  artifact="page-review-darwin-$arch.tar.gz"
  sums=SHA256SUMS
  echo '[1/4] 使用独立CLI（约40MB，无需Node/Bun）；将显示下载进度' >&2
fi
work=$(mktemp -d)
staging=''
cleanup() {
  result=$?
  trap - EXIT HUP INT TERM
  rm -rf "$work"
  if [ -n "$staging" ]; then rm -f "$staging"; fi
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
tar -xzf "$archive" -C "$work"
[ -f "$work/page-review" ] && [ ! -L "$work/page-review" ] || exit 1
[ "$("$work/page-review" --version </dev/null)" = "$version" ] || { echo 'CLI版本校验失败，未安装' >&2; exit 1; }
install_dir="${PAGE_REVIEW_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$install_dir"
staging=$(mktemp "$install_dir/.page-review.XXXXXX")
cp "$work/page-review" "$staging"
chmod 755 "$staging"
echo '[4/4] 安装到原目录；保留原连接配置' >&2
mv -f "$staging" "$install_dir/page-review"
echo "已安装：$install_dir/page-review（${flavor}）"
case ":$PATH:" in *":$install_dir:"*) echo '接着运行：page-review connect';; *) echo '将 ~/.local/bin 加入 PATH，或运行：~/.local/bin/page-review connect';; esac
