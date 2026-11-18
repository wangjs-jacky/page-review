#!/bin/sh
set -eu
[ "$(uname -s)" = Darwin ] || { echo 'Page Review 首版仅支持 macOS' >&2; exit 1; }
case "$(uname -m)" in arm64) arch=arm64;; x86_64) arch=x64;; *) echo '暂不支持此 Mac 架构' >&2; exit 1;; esac
version=0.4.2
origin='__API_ORIGIN__'
artifact="page-review-darwin-$arch.tar.gz"
work=$(mktemp -d)
staging=''
trap 'rm -rf "$work"; if [ -n "$staging" ]; then rm -f "$staging"; fi' EXIT HUP INT TERM
curl -fLsS --proto '=https' --tlsv1.2 "$origin/releases/$version/$artifact" -o "$work/$artifact"
curl -fLsS --proto '=https' --tlsv1.2 "$origin/releases/$version/SHA256SUMS" -o "$work/SHA256SUMS"
expected=$(awk -v name="$artifact" '$2 == name {print $1}' "$work/SHA256SUMS")
[ ${#expected} -eq 64 ] || { echo '安装包校验清单无效' >&2; exit 1; }
actual=$(shasum -a 256 "$work/$artifact" | awk '{print $1}')
[ "$actual" = "$expected" ] || { echo '安装包校验失败，未安装' >&2; exit 1; }
[ "$(tar -tzf "$work/$artifact")" = page-review ] || { echo '安装包内容无效' >&2; exit 1; }
tar -xzf "$work/$artifact" -C "$work"
[ -f "$work/page-review" ] && [ ! -L "$work/page-review" ] || exit 1
install_dir="${PAGE_REVIEW_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$install_dir"
staging=$(mktemp "$install_dir/.page-review.XXXXXX")
cp "$work/page-review" "$staging"
chmod 755 "$staging"
"$staging" --version
mv -f "$staging" "$install_dir/page-review"
echo "已安装：$install_dir/page-review"
case ":$PATH:" in *":$install_dir:"*) echo '接着运行：page-review connect';; *) echo '将 ~/.local/bin 加入 PATH，或运行：~/.local/bin/page-review connect';; esac
