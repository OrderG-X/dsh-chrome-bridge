#!/bin/bash
# 真机端到端（CI 的 E2E_CMD）：每个系统都跑「直接装」和「装进真 DSH」两种；
# Windows 再加几种真实用户会碰到的情况：中文带空格的用户目录、有界面的 Chrome、Edge、
# 用 Electron 当 node（DSH 桌面版就是这样跑插件的，宿主也由它拉起）。
# 一种没过不影响后面的接着跑，最后有任何一种没过就整体失败。
cd "$(dirname "$0")/.."
fail=0
t() { echo; echo "════ $* ════"; "$@" || fail=1; }

t node scratch/e2e-chrome.mjs
t node scratch/e2e-dsh.mjs

if [ "$(node -p process.platform)" = win32 ]; then
  t node scratch/e2e-chrome.mjs --cjk-home
  t node scratch/e2e-chrome.mjs --headed
  t node scratch/e2e-chrome.mjs --browser edge
  E="${RUNNER_TEMP:-$(mktemp -d)}/electron"
  # 第一次 require('electron') 会先下载程序、往输出里打一行进度：只取最后一行的路径
  if npm i --prefix "$E" electron --no-audit --no-fund --loglevel=error >/dev/null && EXE="$(node -p 'require(process.argv[1])' "$E/node_modules/electron" | tail -1)" && node -e 'process.exit(require("fs").existsSync(process.argv[1]) ? 0 : 1)' "$EXE"; then
    t env ELECTRON_RUN_AS_NODE=1 "$EXE" scratch/e2e-chrome.mjs --cjk-home
  else
    echo "❌ 装不上 Electron"; fail=1
  fi
fi
exit $fail
