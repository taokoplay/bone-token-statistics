#!/usr/bin/env bash
# Build a release package that contains ONLY runtime files.
#
# The plugin packer ships everything except .git / node_modules / dist, so a
# plain `pack` on this directory would also carry tests/ and its fixtures. This
# script stages the runtime set in a temp dir and packs that instead, so a
# shipped .piplug never contains a test stub with synthetic data.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

cp "$root/manifest.json" "$root/main.js" "$root/README.md" "$root/LICENSE" "$stage/"
cp -R "$root/lib" "$root/views" "$stage/"

cli="${PI_PLUGIN_CLI:-}"
if [ -z "$cli" ]; then
  if command -v pi-plugin >/dev/null 2>&1; then
    cli="$(command -v pi-plugin)"
  elif [ -f "/Users/xutaoyu/CodeSource/GPL/PI-Desktop/packages/plugin-devkit/dist/cli.js" ]; then
    cli="/Users/xutaoyu/CodeSource/GPL/PI-Desktop/packages/plugin-devkit/dist/cli.js"
  fi
fi
if [ -z "$cli" ]; then
  echo "找不到 pi-plugin CLI：设置 PI_PLUGIN_CLI 或安装 @pi-desktop/plugin-devkit" >&2
  exit 1
fi

case "$cli" in
  *.js) node "$cli" pack "$stage" --out "$root/dist" ;;
  *) "$cli" pack "$stage" --out "$root/dist" ;;
esac

echo "runtime files packaged:"
find "$stage" -type f | sed "s|$stage/||" | sort
