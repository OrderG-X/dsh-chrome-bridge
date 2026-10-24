#!/bin/bash
# 真机端到端（CI 的 E2E_CMD）：每个系统都跑「直接装」和「装进真 DSH」两种；
# Windows 再加几种真实用户会碰到的情况：有界面的 Chrome + 中文带空格的用户目录、Edge、
# 用 Electron 当 node（DSH 桌面版就是这样跑插件的，宿主也由它拉起）。
# 一种没过不影响后面的接着跑，最后有任何一种没过就整体失败。
cd "$(dirname "$0")/.."
fail=0
t() { echo; echo "════ $* ════"; "$@" || fail=1; }

t node scratch/e2e-chrome.mjs
t node scratch/e2e-dsh.mjs

if [ "$(node -p process.platform)" = win32 ]; then
  t node scratch/e2e-chrome.mjs --headed --cjk-home
  t node scratch/e2e-chrome.mjs --browser edge
  E="${RUNNER_TEMP:-$(mktemp -d)}/electron"
  if npm i --prefix "$E" electron --no-audit --no-fund --loglevel=error >/dev/null; then
    t env ELECTRON_RUN_AS_NODE=1 "$(node -p 'require(process.argv[1])' "$E/node_modules/electron")" scratch/e2e-chrome.mjs --headed --cjk-home
  else
    echo "❌ 装不上 Electron"; fail=1
  fi
fi
exit $fail
