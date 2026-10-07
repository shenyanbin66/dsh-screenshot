# dsh-screenshot

QQ 电脑端风格的截图插件（DeepSeek Harness 桌面版专用）。

## 功能

- **触发**：DSH 窗口内按 `Ctrl+Alt+A`，或点输入框左侧工具行的 📷 按钮
- **选区**：冻结当前屏幕 → 拖拽矩形（带尺寸标签）→ 松开即确认
  - `Esc` / 右键 / 选区小于 4px = 取消
- **结果**：裁剪后的 PNG 同时
  1. 写入**系统剪贴板**（Electron helper 里 `clipboard.writeImage`）
  2. 通过合成 `drop` 事件**插入当前会话输入框**（可直接发送）
- **性能**（实测）：点击 → 冻结画面 ≈750–940ms（其中 desktopCapturer 采集
  ~600–850ms 是 Electron 的采集地板，QQ 用原生 DXGI ~50ms，Electron 不暴露）；
  第二次起 helper 常驻热启动，无进程冷启动开销。

仅支持 Electron 桌面版（浏览器版的屏幕捕获被 DSH 权限策略封死，故不做）。

## 架构

```
浏览器半 lib/client.js ──fetch POST /screenshot/api/capture──▶ 宿主半 lib/index.js
  （按钮/快捷键/drop 插入）              （信任栅栏 + spawn + 管道连接）
                                              │ spawn $DSH_HOME/electron（常驻）
                                              ▼
                     独立 Electron helper（runtime/electron-helper/）常驻服务：
                     listen \\.\pipe\dsh-screenshot-<pid>，经 stdout 公告管道名
                     收到一行 cap → JPEG(92) 采集 ‖ loadFile 冻结窗 并行
                     → renderer 画完 double-rAF 回 shot:ready → show + opacity 渐入
                     → 拖拽选区 → canvas 裁剪 → clipboard → 管道回一行 bridge
                                              │ dsh-screenshot-bridge:<json>\n
                                              ▼
                     宿主半回 JSON {ok, value:{png,width,height}} → 浏览器半 drop 插入
```

- **为什么是命名管道**：Electron GUI 子进程启动 2ms 内就关闭 stdin 读端
  （最小对照探针实测），写 `cap` 永远送不到；stdout 也被 Electron 先打一个
  空行。故命令走 `net.Server` 命名管道、stdout 只用来公告管道名（宿主只认
  `dsh-screenshot-bridge:` 前缀行，忽略空行）。
- **常驻生命周期**：宿主 spawn 一次后复用（`helperChild`）；闲置 10 分钟自退；
  插件卸载 `stopHelper()` kill。`window-all-closed` 必须订住——否则第一次截图
  关窗后 Electron 默认行为直接整个退出（实测 exit=0，第二条 cap 无人应答）。
- **延迟优化**（相对一次性进程版 ~1.5s）：①常驻免冷启动 ~200ms；②JPEG(92)
  编码 29ms vs PNG 840ms、载荷 767KB vs 3.4MB；③采集与建窗 loadFile 并行
  重叠；④renderer 画完才 show（double-rAF `shot:ready`）= 零黑闪；⑤bounds
  校验 + `setFullScreen` 兜底盖住任务栏；⑥`setOpacity` 0→1 渐入。
- 信任栅栏抄自 `dsh-better-sidebar/src/trust-fence.ts`（BSD-3，源自
  dsh-client-connection 的 api-request-trust.ts）：loopback Host +
  `sec-fetch-site !== cross-site` + Origin hostname 相等。
- 快捷键走 `ctx.shortcuts.register`，`defaults` 覆盖三个桌面平台；
  register 与其他命令默认键冲突时会 throw，插件捕获后降级为只有按钮。
- spawn 前删除 `ELECTRON_RUN_AS_NODE`（否则 Electron 退化成纯 Node 直接崩）。

## 安装（已执行）

1. `profiles/desktop/package.json`：
   - `dependencies`: `"dsh-screenshot": "link:D:/Deepseek Harness/Deepseek学习/dsh-screenshot"`（Windows junction）
   - `dsh.profile.bundles` 数组加入 `"dsh-screenshot"`
2. profile 目录跑 `pnpm install`（用 `~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs`）
3. **重启 DSH** 加载 bundle

回滚：把 profile `package.json` 恢复自 `package.json.bak-before-dsh-screenshot`，
再跑一次 `pnpm install`；或用工作区 `dsh-plugin-tools/dsh-rescue.ps1 -Plugin dsh-screenshot`
从 bundles 摘除（PowerShell 要 `-ExecutionPolicy Bypass`）。

## 冒烟测试（已通过）

管道协议脱离 DSH 验证（AUTOSHOT）：announced +226ms → 同一进程两条 `cap` →
resp#1 1.66s / resp#2 1.2s，回包单层 `{"ok":true,"value":{"png":"data:image/png;base64,…"}}`。
真实宿主链路（桩 ctx 驱动 `lib/index.js` 的路由 handler）同样通过：
fence → spawn → 管道公告 → cap → PNG，`valueKeys=png,width,height`。

用法：helper 单独启动只会公告管道并闲置；连 `\\.\pipe\dsh-screenshot-<pid>`
写一行 `cap`、读回一行 `dsh-screenshot-bridge:<json>` 即可驱动。
`DSH_SCREENSHOT_AUTOSHOT=1`（传给 helper 环境）让 renderer 400ms 后自动框选
160×120 完成全链路；生产路径不设该变量。

Electron 运行时解析顺序：`DSH_SCREENSHOT_ELECTRON_PATH` 环境变量 →
`createRequire(import.meta.url)('electron')` → `$DSH_HOME/electron/electron.exe`。

## 故障排查

- **点击/快捷键没反应**：先看 `%TEMP%\dsh-screenshot-debug.log`（helper 全链路
  埋点：`cmd: cap` → `capture done` → `parallel phase done` → `renderer painted`
  → `show attempt` → `fade complete` → `result: cropped … total=`）。历史根因：
  ① 宿主 spawn 带 `windowsHide:true`（SW_HIDE）使 `show()` 后仍不可见——已修复；
  ② Electron 默认 `window-all-closed` 退出使常驻 helper 关窗即退——已订住；
  ③ stdin 传 `cap` 被 Chromium 秒关——已改命名管道。宿主半（lib/index.js）改动
  需**重启 DSH** 生效（进程内模块已缓存），helper 半每次读盘即时生效。
- **管道断/过期**（`byConnect` 错误）：宿主自动重拉一次 helper；业务错误（选区
  超时等）不重试，避免杀掉用户正在进行的选区。
- **控制台/network**：浏览器半失败走 `console.warn('[dsh-screenshot]', …)`；
  宿主路由返回 `{"ok":false,"fail":{...}}` 即栅栏或 helper 出错。

## 已知限制 / TODO

- drop 插入依赖 composer 的文件拖放处理（合成 `dragenter→dragover→drop`
  携带 `DataTransfer` File）——重启后若未自动入框，看控制台
  `[dsh-screenshot]` 日志，改用 attachments 服务通道。
- 快捷键只在 DSH 窗口聚焦时生效（不做系统级全局热键，那需要 native 模块）。
- 选区无放大镜/贴边吸附（有意为之的基础版 UX，先跑通再迭代）。
- 多显示器：只抓光标所在的那一块屏幕。
- desktopCapturer 采集 ~600–850ms 是 Electron 地板，无法压到 QQ 级原生速度。
