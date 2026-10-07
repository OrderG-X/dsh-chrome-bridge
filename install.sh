#!/bin/bash
# DSH Bridge 安装脚本（可重复跑，幂等）
#
#   ./install.sh             安装
#   ./install.sh --uninstall 卸载（Chrome 里的扩展要自己去 chrome://extensions 删）
#
# 干三件事：
#   1. 把扩展和宿主拷到 ~/.dsh/chrome-bridge/（不依赖本仓库留在原地）
#   2. 写 Chrome 原生消息宿主注册文件（allowed_origins 绑定扩展 ID）
#   3. 装 cb CLI 到 ~/.dsh/bin/cb

set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
BRIDGE="$HOME/.dsh/chrome-bridge"
# 扩展放在可见目录：Chrome 的「加载已解压」文件框里点侧边栏「guo」就能看到，
# 不用按 ⌘⇧G 去开隐藏文件夹
EXT_DIR="$HOME/dsh-bridge-extension"
HOST_NAME="com.dsh.bridge"
NM_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
NM_FILE="$NM_DIR/$HOST_NAME.json"

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$NM_FILE"
  rm -f /tmp/dsh-bridge.sock /tmp/dsh-bridge.token
  rm -rf "$BRIDGE" "$EXT_DIR"
  rm -f "$HOME/.dsh/bin/cb"
  echo "已卸载：注册文件 / 宿主目录 / 扩展目录 / cb 都清了"
  echo "Chrome 里的扩展请自己去 chrome://extensions 删掉（DSH Bridge）"
  exit 0
fi

echo "==> 1/4 安装宿主到 $BRIDGE"
mkdir -p "$BRIDGE/host" "$EXT_DIR" "$HOME/.dsh/bin" "$HOME/.dsh/chrome-cursor"
cp -R "$REPO/extension/." "$EXT_DIR/"
cp "$REPO/host/host.js" "$REPO/host/run.sh" "$BRIDGE/host/"
cp "$REPO/scratch/in-page-cursor.js" "$HOME/.dsh/chrome-cursor/in-page-cursor.js" 2>/dev/null || true
chmod +x "$BRIDGE/host/run.sh"

echo "==> 2/4 算扩展 ID（从 manifest 里的 key 推导，永久固定）"
EXT_ID="$(python3 - "$EXT_DIR/manifest.json" <<'PY'
import base64, hashlib, json, sys
key = json.load(open(sys.argv[1]))["key"]
der = base64.b64decode(key)
h = hashlib.sha256(der).hexdigest()[:32]
print("".join(chr(ord("a") + int(c, 16)) for c in h))
PY
)"
echo "    扩展 ID: $EXT_ID"

echo "==> 3/4 注册原生消息宿主"
mkdir -p "$NM_DIR"
cat > "$NM_FILE" <<JSON
{
  "name": "$HOST_NAME",
  "description": "DSH Bridge 原生宿主（本地浏览器控制）",
  "path": "$BRIDGE/host/run.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
JSON
echo "    $NM_FILE"

echo "==> 4/4 装 cb CLI"
cp "$REPO/bin/cb" "$HOME/.dsh/bin/cb"
chmod +x "$HOME/.dsh/bin/cb"

cat <<EOF

✅ 装完了。剩最后一步（一辈子只做一次）：

   1. 打开 chrome://extensions
   2. 右上角打开「开发者模式」
   3. 点「加载未打包的扩展程序」→ 在文件框左侧点「guo」→ 双击 dsh-bridge-extension → 点「选择」

      （路径：${EXT_DIR}）

   4. 装完不用点任何东西，直接跑：cb status

   （扩展 ID 是 ${EXT_ID}，已经绑进注册文件了）
EOF
