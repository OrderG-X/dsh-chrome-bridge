#!/bin/sh
# Chrome 通过这个脚本拉起原生宿主。
# Chrome 的环境 PATH 很干净，所以这里用绝对路径挑 node。

HERE="$(cd "$(dirname "$0")" && pwd)"

for N in "$DSH_BRIDGE_NODE" /usr/local/bin/node "$HOME/.local/bin/node" /opt/homebrew/bin/node /usr/bin/node; do
  if [ -n "$N" ] && [ -x "$N" ]; then
    exec "$N" "$HERE/host.js" "$@"
  fi
done

N="$(command -v node 2>/dev/null)"
if [ -n "$N" ]; then
  exec "$N" "$HERE/host.js" "$@"
fi

echo "dsh-bridge: 找不到可用的 node（可用 DSH_BRIDGE_NODE 指定绝对路径）" >&2
exit 1
