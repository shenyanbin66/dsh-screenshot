# dsh-screenshot

QQ 电脑端风格的截图插件（DeepSeek Harness 桌面版专用）。

## 功能

- **触发**：
  - **系统级全局热键 `Ctrl+Shift+A`**（OS 注册，任何界面都能按——包括 DSH
    设置面板、其他应用窗口；按下即进入选区，不看 DSH 聚不聚焦）
  - 或点 DSH 输入框左侧工具行的 📷 按钮（会话界面）
- **选区**：冻结当前屏幕 → 拖拽矩形（带尺寸标签）→ 松开即确认
  - `Esc` / 右键 / 选区小于 4px = 取消
- **结果**：裁剪后的 PNG 同时
  1. 写入**系统剪贴板**（Electron helper 里 `clipboard.writeImage`）
  2. 浏览器半通过 watch 长轮询收到结果 → 合成 `drop` 事件**插入当前会话
     输入框**（可直接发送；找不到输入框时仅保留剪贴板）
- **性能**（实测）：热键按下 → 冻结画面 ≈700–1000ms（其中 desktopCapturer
  采集 ~600–850ms 是 Electron 的采集地板，QQ 用原生 DXGI ~50ms，Electron
  不暴露）；helper 常驻热启动，无进程冷启动开销。
- **换键**：`DSH_SCREENSHOT_HOTKEY` 环境变量（Electron accelerator，如
  `CommandOrControl+Alt+A`），重启 DSH 生效。

仅支持 Electron 桌面版（浏览器版的屏幕捕获被 DSH 权限策略封死，故不做）。

## 架构

```
globalShortcut('CommandOrControl+Shift+A')  ← OS 级注册，绕过 DSH 全部输入闸门
   │ 热键触发（或宿主管道 cap 命令，📸 按钮走 HTTP）
   ▼
独立 Electron helper（runtime/electron-helper/）常驻服务：
   JPEG(92) 采集 ‖ loadFile 冻结窗 并行 → renderer 画完 double-rAF 回 shot:ready
   → show + opacity 渐入 → 拖拽选区 → canvas 裁剪 → clipboard.writeImage
   │ 结果 net.connect 推入 \\.\pipe\dsh-screenshot-host（断线 2s 重连，缓冲≤2）
   ▼
宿主半 lib/index.js：net.createServer 监听 host 管道 → deliverHotkey()
   │ 有 /screenshot/api/watch 长轮询等待者 → 立即回写；没有 → 缓冲（≤3 条丢最旧）
   ▼
浏览器半 lib/client.js：watch 长轮询循环 → insertIntoComposer 合成 drop 插入
（📷 按钮走 POST /screenshot/api/capture 同步回包插入）
```

- **为什么全局热键**：DSH 设置面板打开时其输入管线（beforeInput/modal 层）
  会拦下所有可配置快捷键，DSH 内注册的快捷键在会话界面外完全无效，📷 按钮
  也够不着——OS 级 `globalShortcut` 绕过 DSH 闸门。已核对 `@deepseek-ai`
  全部默认键无 `Ctrl+Shift+A`（`KeyA` 保留规则带 shift 明确豁免，不冲突）。
- **为什么是命名管道**：Electron GUI 子进程启动 2ms 内就关闭 stdin 读端
  （最小对照探针实测），写 `cap` 永远送不到；stdout 也被 Electron 先打一个
  空行。故宿主→helper 命令走 `\\.\pipe\dsh-screenshot-<pid>`（stdout 只用来
  公告管道名，宿主只认 `dsh-screenshot-bridge:` 前缀行）；helper→host 结果
  推送走常驻 `\\.\pipe\dsh-screenshot-host`。
- **常驻生命周期**：宿主 `apply()` 即 spawn（热键要早点上）；热键注册成功
  则不闲置自退（没注册上才 10 分钟退），每 5s `process.kill(ppid,0)` 盯宿主
  ——DSH 退出 helper 自动退出并释放热键；插件卸载 `stopHelper()` kill。
  `window-all-closed` 必须订住——否则第一次截图关窗后 Electron 默认行为直接
  整个退出（实测 exit=0，第二条命令无人应答）。
- **热键注册失败重试**：每 2s 重试（DSH 重启窗口期旧孤儿可能占键，旧孤儿被
  ppid 轮询 5s 内清掉）。
- **延迟优化**（相对一次性进程版 ~1.5s）：①常驻免冷启动 ~200ms；②JPEG(92)
  编码 29ms vs PNG 840ms、载荷 767KB vs 3.4MB；③采集与建窗 loadFile 并行
  重叠；④renderer 画完才 show（double-rAF `shot:ready`）= 零黑闪；⑤bounds
  校验 + `setFullScreen` 兜底盖住任务栏；⑥`setOpacity` 0→1 渐入。
- 信任栅栏抄自 `dsh-better-sidebar/src/trust-fence.ts`（BSD-3，源自
  dsh-client-connection 的 api-request-trust.ts）：loopback Host +
  `sec-fetch-site !== cross-site` + Origin hostname 相等。
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

- 管道协议（AUTOSHOT）：announced +226ms → 同一进程双 `cap` → resp 1.66s/1.2s，
  回包单层 `{"ok":true,"value":{"png":"data:image/png;base64,…"}}`。
- 真实宿主链路（桩 ctx 驱动 `lib/index.js` 路由 handler）：fence → spawn →
  管道公告 → cap → PNG，`valueKeys=png,width,height`。
- **全局热键 E2E**（桩 ctx + `DSH_SCREENSHOT_TEST_FIRE_MS=1500` 模拟热键）：
  `hotkey registered: CommandOrControl+Shift+A (attempt 1)` → 1.5s 后 fire →
  capture ~1.2s → `watch: hotkey result delivered to live waiter` → 回包
  `{ok:true,value:{png,…}}` → disposer 清理，`E2E PASS`。

用法：helper 单独启动会注册全局热键、监听 host 管道并盯 ppid 闲置；
`DSH_SCREENSHOT_AUTOSHOT=1` 让 renderer 400ms 后自动框选走完全链路；
`DSH_SCREENSHOT_TEST_FIRE_MS=1500` 让 helper 在 ready 后模拟一次热键触发。
生产路径两个变量都不设。

Electron 运行时解析顺序：`DSH_SCREENSHOT_ELECTRON_PATH` 环境变量 →
`createRequire(import.meta.url)('electron')` → `$DSH_HOME/electron/electron.exe`。

## 故障排查

- **热键/按钮没反应**：先看 `%TEMP%\dsh-screenshot-debug.log`（helper 全链路
  埋点：`hotkey registered` → `hotkey → capture` → `capture done` →
  `parallel phase done` → `renderer painted` → `show attempt` →
  `result: cropped … total=`；宿主侧 `eager helper spawn requested` /
  `hotkey result delivered to live waiter`）。历史根因：① 宿主 spawn 带
  `windowsHide:true`（SW_HIDE）使 `show()` 后仍不可见——已修复；② Electron
  默认 `window-all-closed` 退出使常驻 helper 关窗即退——已订住；③ stdin 传
  `cap` 被 Chromium 秒关——已改命名管道；④ DSH 设置面板拦 DSH 内快捷键
  ——已改 OS 全局热键。宿主半（lib/index.js）改动需**重启 DSH** 生效
  （进程内模块已缓存），helper 半每次读盘即时生效。
- **系统级屏幕复制全挂**（插件和 Win+Shift+S 都截不到）：Chromium 日志里
  `dxgi_output_duplicator.cc:117 Failed to duplicate output … HRESULT:
  0x80070005 (E_ACCESSDENIED)` = 整机被拒（DRM/视频会话或某应用占用，与
  插件无关），占用会话结束后自愈；确诊探针：用 `$DSH_HOME\electron` 跑
  一个 `getSources` 小脚本，看 `sources=` 行里 display_id 是否为空。
- **管道断/过期**（`byConnect` 错误）：宿主自动重拉一次 helper；业务错误（选区
  超时等）不重试，避免杀掉用户正在进行的选区。
- **控制台/network**：浏览器半失败走 `console.warn('[dsh-screenshot]', …)`；
  宿主路由返回 `{"ok":false,"fail":{...}}` 即栅栏或 helper 出错。

## 已知限制 / TODO

- drop 插入依赖 composer 的文件拖放处理（合成 `dragenter→dragover→drop`
  携带 `DataTransfer` File）——重启后若未自动入框，看控制台
  `[dsh-screenshot]` 日志，改用 attachments 服务通道。
- 热键被其他常驻应用占用时换键（`DSH_SCREENSHOT_HOTKEY`）；整机屏幕复制被
  拒时谁都截不到（见故障排查）。
- 选区无放大镜/贴边吸附（有意为之的基础版 UX，先跑通再迭代）。
- 多显示器：只抓光标所在的那一块屏幕。
- desktopCapturer 采集 ~600–850ms 是 Electron 地板，无法压到 QQ 级原生速度。
