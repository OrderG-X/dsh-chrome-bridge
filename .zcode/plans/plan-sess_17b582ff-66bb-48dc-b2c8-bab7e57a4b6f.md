# 接手 dsh-video-preview：让 DSH 桌面端对话流里直接播视频

## 背景结论（探查所得）

- DSH 当晚会话死于「图片 65 > 64」上游 400（连 /compact 都失败），**不是插件本身的问题**——和你 browser-agent-kit 里未提交的 image-guard 是同一个 bug。
- 插件代码已基本完成且符合官方范式（与第三方 dsh-image-gen 同套路）：服务端 `play_video` 工具 + 带 token 的 Range 流式路由已验证注册成功（403 无 token = 路由活着）；客户端 pending 的坑（`exports.inject` 要写短服务名）当晚 00:11 已修。
- web 端（vidtest2）走到「UI 正常加载」，只差端到端播放验证；**桌面端从未安装**（DSH 怕重启你的在线 app，主动回避了）。
- headless profile（vidtest）是死路：不挂 webServer 也没有浏览器，服务端永远 pending。
- 桌面端加载同一套前端（`dsh-app://app` 协议 + 转发到宿主 19387 端口），Range/206 透传、无 CSP 拦截 → 插件的相对 URL 写法在两端都通，**核心代码不用动**。

## 实施步骤

### 1. 搬家 + 修缮
- `cp -a /tmp/dsh-video-preview ~/Projects/dsh-video-preview`（/tmp 重启即失，必须搬；原目录不动）
- 修 `package.json`：peerDependencies 首段 `>=0.1.2-rc.1 <0.1.0` 是空区间笔误，改成正确区间（避免 0.2.0 插件管理器的兼容门禁拒装）
- 补 `README.md`（files 字段已声明但文件不存在）
- `lib/client.js`：补注册 locale 词典（en/zh，照 image-gen 模式；现在是传了 NS 但没词条）
- `git init` + 初次提交

### 2. web 端验证（不碰你的桌面 app）
- 重新 link 到新路径：`dsh plugin --profile vidtest2 add link:/Users/guo/Projects/dsh-video-preview`
- 起 `dsh --profile vidtest2 web --port 8097`，确定性检查：启动日志无 pending、boot manifest 含插件行、`curl /plugins/dsh-video-preview/client.js` 返回 200
- 端到端：浏览器自动化打开 web UI，让它调 `play_video` 播一个样例 mp4，截图确认对话里出现可播放、可拖进度条的播放器卡片

### 3. 装进桌面 profile
- `dsh plugin --profile desktop add link:/Users/guo/Projects/dsh-video-preview`（desktop profile 已有三个本地 link 插件，同款路径）
- **需要你重启一次 DeepSeek Harness.app**（会中断当前桌面会话；动手前我会先问你）
- 重启后验证：无 pending，在桌面端对话里播视频，确认内联播放器出现且可拖动

### 4. 收尾
- 无用的 vidtest（headless 死路）默认留着不动，你说删再删；vidtest2 留作回归
- 可选后续：发布 GitHub（DSH 原 TODO 第 6 条）、Codex 式独立悬浮小窗（本次范围是 Claude 式内联播放器）

## 验证标准
web 端 curl 三项检查 + 浏览器端到端播放通过；桌面端重启后 `play_video` 出卡片、视频可播可拖。

## 提醒（不在本次范围）
桌面 profile 也没挂 image-guard，理论上同样会被 65>64 打死会话——要不要把 browser-agent-kit 那套也装上，之后另说。