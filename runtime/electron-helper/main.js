/**
 * dsh-screenshot Electron helper —— **常驻**截图服务（CJS，跑在自己的
 * runtime/electron-helper/package.json 模块域下，绕开包根 type:module）。
 *
 * 协议（宿主 lib/index.js 驱动，进程复用，不再一次性退出）：
 *   命令通道 = 命名管道 `\\.\pipe\dsh-screenshot-<pid>`：宿主 net.connect 连入，
 *     每连接发一行 `cap`，本进程回一行 `dsh-screenshot-bridge:<json>` 后关闭。
 *     ⚠ 不能用 stdin 传命令：Electron GUI 子进程启动 ~2ms 内 Chromium 即关闭
 *     stdin 读端（探针实测 END/CLOSE，宿主写入 cb err=null 但数据静默丢弃）。
 *   推送通道 = 连入宿主的 `\\.\pipe\dsh-screenshot-host`（宿主 apply 时 listen）：
 *     **全局热键**触发的 capture 结果以一行 `dsh-screenshot-bridge:<json>` 推过去，
 *     宿主经 `/screenshot/api/watch` 长轮询交给浏览器半插输入框。
 *   stdout = 只做启动公告与诊断：管道 listen 成功后发一行
 *     `dsh-screenshot-bridge:{"ok":true,"value":{"ready":true,"pipe":"\\\\.\\pipe\\..."}}`；
 *     Electron 还会先打一个空行，宿主忽略所有非 bridge 行。
 *   全局热键 = app ready 即 `globalShortcut.register(默认 Ctrl+Alt+X)`，OS 级
 *     捕获、绕开 DSH 全部输入闸门（设置面板/其他应用里也能截）；
 *     `DSH_SCREENSHOT_HOTKEY` 可换键；注册失败每 2s 重试（重启窗口期旧孤儿
 *     5s 内被父进程轮询清掉，或被别的应用占用）。
 *   生命周期：热键在册 = 跟 DSH 同寿（父进程 ppid 每 5s 存活轮询，DSH 退→退出
 *     释放热键）；热键没注册上才退回闲置 10 分钟自退出。
 *
 * 单次 capture 流程（延迟优化后的关键路径）：
 *   解析光标所在显示器 → **并行** [desktopCapturer JPEG 采集 ~640ms | 建窗加载 ~200ms]
 *   → renderer 用 Blob 画完回 `shot:ready` → 这里才 show（0→1 渐入，零黑闪）
 *   → 用户拖选（Esc/右键/微小选区=取消，松开即确认）
 *   → renderer canvas 裁剪回 `shot:done` → clipboard.writeImage → 回 bridge 行 → 关窗待命。
 *
 * 历史教训（勿回退）：
 *   - spawn 不能带 windowsHide:true（SW_HIDE 会让 show() 后 isVisible=false）
 *     ——show 仍保留 5×250ms 重试兜底；
 *   - PNG 编码 2561×1601 要 ~840ms，JPEG(92) 只要 ~29ms —— 载荷必须是 JPEG；
 *   - 先 show 后送图会黑闪 + 窗口 bounds 被钳（丢任务栏）→ 画完再 show + bounds 校验。
 */
'use strict'
const electron = require('electron')

const BRIDGE_PREFIX = 'dsh-screenshot-bridge:'
const IDLE_MS = 10 * 60 * 1000
const JPEG_QUALITY = 92
const DEBUG_LOG = require('node:path').join(require('node:os').tmpdir(), 'dsh-screenshot-debug.log')
const HOTKEY = process.env.DSH_SCREENSHOT_HOTKEY || 'CommandOrControl+Alt+X'
const HOST_PIPE = '\\\\.\\pipe\\dsh-screenshot-host'
const PARENT_PID = process.ppid
const PARENT_POLL_MS = 5 * 1000
const HOTKEY_RETRY_MS = 2 * 1000

// 调试文件日志（定位"窗口没显示"/延迟问题）：%TEMP%\dsh-screenshot-debug.log
function dbg(message) {
  try {
    require('node:fs').appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] [pid=${process.pid}] ${message}\n`)
  } catch {
    // ignore
  }
}
dbg(`start argv=${JSON.stringify(process.argv)} runAsNode=${process.env.ELECTRON_RUN_AS_NODE || ''}`)

// ELECTRON_RUN_AS_NODE 泄漏时 require('electron') 返回字符串路径而非 API ——
// 明确报错回宿主（宿主 spawn 前已删该变量，这里是兜底），不要裸崩。
if (typeof electron !== 'object' || electron === null) {
  process.stdout.write(BRIDGE_PREFIX + JSON.stringify({
    ok: false,
    error: { message: 'helper started as plain Node (ELECTRON_RUN_AS_NODE leaked)' },
  }) + '\n')
  process.exit(1)
}

const { app, BrowserWindow, clipboard, desktopCapturer, globalShortcut, ipcMain, nativeImage, screen } = electron
const fs = require('node:fs')
const path = require('node:path')

process.on('uncaughtException', (error) => { dbg(`uncaughtException: ${error && error.stack}`) })
process.on('unhandledRejection', (reason) => { dbg(`unhandledRejection: ${reason}`) })
// 常驻关键：不订这个事件的话，第一次截图 cleanupWindow 关掉最后一扇窗时
// Electron 会按默认行为整体退出（实测 exit=0，第二条 cap 无人应答）。
app.on('window-all-closed', () => { dbg('window-all-closed ignored (resident)') })

function respond(message) {
  try {
    process.stdout.write(BRIDGE_PREFIX + JSON.stringify(message) + '\n')
  } catch {
    // stdout 可能已断开
  }
}

// ---------------------------------------------------------------------------
// 常驻状态
// ---------------------------------------------------------------------------
let ready = false
let busy = false
let idleTimer = null
let hotkeyActive = false
let hotkeyTries = 0
let hostSock = null // 连入宿主 \\.\pipe\dsh-screenshot-host 的推送连接
let hostConnectTimer = null
const pushBuf = [] // 宿主推送管还没连上时暂存结果（最多 2 条，丢旧的）
let currentWin = null
const waiters = { ready: null, done: null } // {resolve, reject, win}

const readyP = app.whenReady().then(() => {
  ready = true
  dbg('whenReady (resident helper up)')
  registerHotkey()
  connectHost()
  startParentWatch()
  // 冒烟测试钩子：模拟一次全局热键（无真实按键也可全链路验证 push→watch）
  const testFire = Number(process.env.DSH_SCREENSHOT_TEST_FIRE_MS || 0)
  if (testFire > 0) {
    dbg(`TEST hook: firing hotkey in ${testFire}ms`)
    setTimeout(onHotkey, testFire)
  }
}).catch((error) => {
  dbg(`whenReady failed: ${error && error.stack}`)
  respond({ ok: false, error: { message: String((error && error.message) || error) } })
  process.exit(1)
})

function armIdle() {
  // 全局热键模式：生命周期跟 DSH 走，不闲置自退（顺手清掉可能已挂上的定时器）
  if (hotkeyActive) {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    return
  }
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    dbg('idle 10min → exit')
    cleanupWindow()
    app.exit(0)
  }, IDLE_MS)
}

/**
 * OS 级热键。globalShortcut.register 返回 false = 键被占（最常见：DSH 重启
 * 窗口期旧孤儿 helper 还占着——它被父进程轮询 5s 内清退；也可能是别的应用）。
 * 每 2s 重试直到成功，日志节流（第 1 次与每 15 次记一条）。
 */
function registerHotkey() {
  let ok = false
  try {
    ok = globalShortcut.register(HOTKEY, onHotkey)
  } catch (error) {
    dbg(`hotkey register threw: ${error}`)
  }
  hotkeyTries += 1
  if (ok) {
    hotkeyActive = true
    dbg(`hotkey registered: ${HOTKEY} (attempt ${hotkeyTries})`)
    respond({ ok: true, value: { hotkey: HOTKEY } })
    return
  }
  if (hotkeyTries === 1) {
    respond({ ok: false, error: { message: `hotkey unavailable (another app owns ${HOTKEY}); retrying` } })
  }
  if (hotkeyTries === 1 || hotkeyTries % 15 === 0) {
    dbg(`hotkey register failed (attempt ${hotkeyTries}): ${HOTKEY} — retry every ${HOTKEY_RETRY_MS}ms`)
  }
  setTimeout(registerHotkey, HOTKEY_RETRY_MS)
}

/** 父进程（DSH / 测试宿主）死了就退出释放热键，不留孤儿。 */
function startParentWatch() {
  setInterval(() => {
    try {
      process.kill(PARENT_PID, 0)
    } catch (error) {
      if (error && error.code === 'ESRCH') {
        dbg(`parent pid=${PARENT_PID} gone → exit`)
        cleanupWindow()
        app.exit(0)
      }
      // EPERM = 存在但无权限，视为存活
    }
  }, PARENT_POLL_MS)
}

// ---------------------------------------------------------------------------
// 热键结果推送：连入宿主的 \\.\pipe\dsh-screenshot-host，断线 2s 重连，
// 连上即冲积压。宿主推送服务器没起（web/启动竞态）时结果在剪贴板，不算全丢。
// ---------------------------------------------------------------------------
function flushPushBuf() {
  while (pushBuf.length > 0) {
    if (!hostSock || hostSock.destroyed || !hostSock.writable) return
    try {
      hostSock.write(pushBuf.shift())
    } catch {
      return
    }
  }
}

function pushResult(message) {
  const line = BRIDGE_PREFIX + JSON.stringify(message) + '\n'
  if (hostSock && !hostSock.destroyed && hostSock.writable) {
    try {
      hostSock.write(line)
      return
    } catch {
      // 落到缓冲
    }
  }
  pushBuf.push(line)
  if (pushBuf.length > 2) pushBuf.shift()
  dbg('push buffered (host push pipe not connected yet)')
}

function connectHost() {
  const sock = net.connect(HOST_PIPE)
  sock.setEncoding('utf8')
  let connected = false
  const scheduleRetry = (why) => {
    if (hostSock === sock) hostSock = null
    if (!connected) {
      connected = true
      dbg(`host push connect failed (${why}); retry in 2s`)
    }
    if (!hostConnectTimer) {
      hostConnectTimer = setTimeout(() => {
        hostConnectTimer = null
        connectHost()
      }, 2000)
    }
  }
  sock.on('connect', () => {
    connected = true
    hostSock = sock
    dbg(`host push connected: ${HOST_PIPE}`)
    flushPushBuf()
  })
  sock.on('error', (error) => { dbg(`host push error: ${error}`); scheduleRetry('error') })
  sock.on('close', () => { scheduleRetry('close') })
}

/** 全局热键触发的 capture（与按钮 cap 共用 busy 单飞）。 */
function onHotkey() {
  armIdle()
  if (busy) {
    dbg('hotkey ignored (capture already in progress)')
    return
  }
  busy = true
  dbg('hotkey → capture')
  readyP
    .then(() => runCapture())
    .then((value) => { pushResult({ ok: true, value }) })
    .catch((error) => {
      dbg(`hotkey capture error: ${error && error.stack}`)
      pushResult({ ok: false, error: { message: String((error && error.message) || error) } })
    })
    .finally(() => {
      busy = false
      armIdle()
    })
}

// ---------------------------------------------------------------------------
// 截屏：光标所在显示器，按 DPR 全分辨率，JPEG 编码（29ms vs PNG 840ms）
// ---------------------------------------------------------------------------
function pickDisplay() {
  const point = screen.getCursorScreenPoint()
  return screen.getDisplayNearestPoint({ x: point.x, y: point.y })
}

async function captureJpeg(display) {
  const scale = display.scaleFactor || 1
  const t0 = Date.now()
  dbg(`captureScreen display=${display.id} bounds=${JSON.stringify(display.bounds)} workArea=${JSON.stringify(display.workArea)} scale=${scale}`)
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * scale),
      height: Math.round(display.size.height * scale),
    },
    fetchWindowIcons: false,
  })
  if (!sources || sources.length === 0) throw new Error('desktopCapturer returned no sources')
  const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0]
  const jpeg = source.thumbnail.toJPEG(JPEG_QUALITY)
  dbg(`capture done ${Date.now() - t0}ms sources=${sources.length} chosenId=${source.id} jpegLen=${jpeg ? jpeg.length : 0}`)
  if (!jpeg || jpeg.length < 64) throw new Error('desktopCapturer returned an empty image')
  return jpeg
}

// ---------------------------------------------------------------------------
// 冻结图选区窗口：并行预建（与采集重叠），画完才 show
// ---------------------------------------------------------------------------
function createWindow(display) {
  const bounds = display.bounds
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    show: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    transparent: false,
    backgroundColor: '#000000',
    focusable: true,
    autoHideMenuBar: true,
    title: 'dsh-screenshot',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      spellcheck: false,
    },
  })
  try {
    win.setAlwaysOnTop(true, 'screen-saver')
    if (typeof win.setVisibleOnAllWorkspaces === 'function') {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    }
  } catch {
    // 平台差异，忽略
  }
  const loaded = new Promise((resolve, reject) => {
    win.webContents.on('did-finish-load', () => { dbg('did-finish-load'); resolve() })
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      dbg(`did-fail-load code=${code} desc=${desc}`)
      reject(new Error(`selection page failed to load (${code} ${desc})`))
    })
  })
  // 冒烟测试钩子：DSH_SCREENSHOT_AUTOSHOT=1 时 renderer 自动选一小块
  const autoshot = process.env.DSH_SCREENSHOT_AUTOSHOT === '1' ? '1' : '0'
  win.loadFile(path.join(__dirname, 'index.html'), { query: { autoshot } })
  dbg(`window created (loadFile issued) bounds=${JSON.stringify(bounds)}`)
  return { win, loaded }
}

/**
 * 确保窗口铺满整块显示器（含任务栏）——历史 bug：show 后 bounds 被钳到
 * workArea（{1713,1022}），冻结画面盖不住任务栏且被拉伸 → "锁定不自然"。
 * 返回最终 bounds（日志记录用了哪种策略）。
 */
function ensureCoverage(win, want) {
  const got = win.getBounds()
  const matches = got.x === want.x && got.y === want.y && got.width === want.width && got.height === want.height
  if (matches) return { strategy: 'as-is', got }
  win.setBounds(want)
  const after = win.getBounds()
  const stillMismatch = after.x !== want.x || after.y !== want.y || after.width !== want.width || after.height !== want.height
  if (stillMismatch) {
    try { win.setFullScreen(true) } catch { /* ignore */ }
    dbg(`coverage: setBounds insufficient (${JSON.stringify(after)}) → setFullScreen`)
    return { strategy: 'fullscreen', got: win.getBounds() }
  }
  return { strategy: 'setBounds', got: after }
}

/**
 * 画完（shot:ready）之后才显示：show 重试兜底 + 0→1 渐入（QQ 式锁定感）。
 */
function showWithFade(win, display) {
  const coverage = ensureCoverage(win, display.bounds)
  dbg(`pre-show coverage strategy=${coverage.strategy} got=${JSON.stringify(coverage.got)}`)
  try { win.setOpacity(0) } catch { /* ignore */ }
  let attempts = 0
  const tryShow = () => {
    win.show()
    win.focus()
    attempts += 1
    dbg(`show attempt=${attempts} isVisible=${win.isVisible()} bounds=${JSON.stringify(win.getBounds())}`)
    if (!win.isVisible()) {
      if (attempts >= 5) {
        throw new Error('selection window still hidden after show retries')
      }
      setTimeout(tryShow, 250)
      return
    }
    const post = ensureCoverage(win, display.bounds)
    dbg(`post-show coverage strategy=${post.strategy} got=${JSON.stringify(post.got)}`)
    // 渐入：25%/步 × 20ms ≈ 120ms，从半透明"落定"到全亮
    let opacity = 0
    const fade = setInterval(() => {
      opacity = Math.min(1, opacity + 0.25)
      try { win.setOpacity(opacity) } catch { /* ignore */ }
      if (opacity >= 1) {
        clearInterval(fade)
        dbg('fade complete')
      }
    }, 20)
  }
  tryShow()
}

function waitFor(kind, win) {
  return new Promise((resolve, reject) => {
    waiters[kind] = { resolve, reject, win }
  })
}

function settleWaiter(kind, event, value, isError) {
  const w = waiters[kind]
  if (!w || !event.sender || w.win.webContents !== event.sender) return
  waiters[kind] = null
  if (isError) w.reject(value instanceof Error ? value : new Error(String(value)))
  else w.resolve(value)
}

ipcMain.on('shot:ready', (event) => { settleWaiter('ready', event, undefined, false) })
ipcMain.on('shot:done', (event, payload) => { settleWaiter('done', event, payload, false) })
ipcMain.on('shot:error', (event, message) => { settleWaiter('done', event, new Error(String(message || 'renderer error')), true) })

function cleanupWindow() {
  const win = currentWin
  waiters.ready = null
  waiters.done = null
  currentWin = null
  if (win && !win.isDestroyed()) {
    win.removeAllListeners('closed')
    try { win.destroy() } catch { /* ignore */ }
    dbg('selection window closed')
  }
}

// ---------------------------------------------------------------------------
// 单次 capture
// ---------------------------------------------------------------------------
async function runCapture() {
  if (!ready) await readyP
  const display = pickDisplay()
  const t0 = Date.now()
  // 并行：JPEG 采集（~640ms）与建窗加载（~200ms）重叠
  const capturePromise = captureJpeg(display)
  const { win, loaded } = createWindow(display)
  currentWin = win
  let windowClosed = false
  win.on('closed', () => {
    windowClosed = true
    dbg('window closed during capture')
    settleWaiterClosed()
  })
  const settleWaiterClosed = () => {
    for (const kind of ['ready', 'done']) {
      const w = waiters[kind]
      if (w && w.win === win) {
        waiters[kind] = null
        w.reject(new Error('selection window closed before a choice was made'))
      }
    }
  }
  try {
    const [jpeg] = await Promise.all([capturePromise, loaded])
    dbg(`parallel phase done ${Date.now() - t0}ms (capture+load overlapped)`)
    const donePromise = waitFor('done', win)
    donePromise.catch(() => {}) // 提前注册，防 unhandledRejection（失败路径不会 await）
    const readyPromise = waitFor('ready', win)
    win.webContents.send('shot:image', { jpeg })
    dbg('shot:image sent (waiting for renderer paint)')
    await readyPromise
    dbg(`renderer painted ${Date.now() - t0}ms → showing`)
    showWithFade(win, display)
    const payload = await donePromise
    if (windowClosed) throw new Error('selection window closed before a choice was made')
    if (!payload || payload.cancelled === true) {
      dbg('result: cancelled')
      return { cancelled: true }
    }
    if (typeof payload.png !== 'string' || !payload.png.startsWith('data:image/png')) {
      throw new Error('invalid crop payload from renderer')
    }
    const cropped = nativeImage.createFromDataURL(payload.png)
    if (cropped.isEmpty()) throw new Error('cropped image is empty')
    clipboard.writeImage(cropped)
    const size = cropped.getSize()
    dbg(`result: cropped ${size.width}×${size.height} total=${Date.now() - t0}ms`)
    return { png: payload.png, width: size.width, height: size.height }
  } finally {
    cleanupWindow()
  }
}

// ---------------------------------------------------------------------------
// 命令通道：命名管道（stdin 被 Chromium 关闭不可用——见文件头）
// ---------------------------------------------------------------------------
const net = require('node:net')
const PIPE_PATH = `\\\\.\\pipe\\dsh-screenshot-${process.pid}`

function onCap(send) {
  armIdle()
  if (busy) {
    send({ ok: false, error: { message: 'capture already in progress' } })
    return
  }
  busy = true
  dbg('cmd: cap')
  readyP // 管道可能比 app.whenReady 先就绪，第一条 cap 要等 ready
    .then(() => runCapture())
    .then((value) => { send({ ok: true, value }) })
    .catch((error) => {
      dbg(`capture error: ${error && error.stack}`)
      send({ ok: false, error: { message: String((error && error.message) || error) } })
    })
    .finally(() => {
      busy = false
      armIdle()
    })
}

const cmdServer = net.createServer((sock) => {
  armIdle()
  sock.on('error', (error) => { dbg(`cmd socket error: ${error}`) })
  let buf = ''
  let answered = false
  const send = (message) => {
    if (answered) return
    answered = true
    try {
      sock.write(BRIDGE_PREFIX + JSON.stringify(message) + '\n')
    } catch {
      // 对端可能已断开
    }
    sock.end()
  }
  sock.setEncoding('utf8')
  sock.on('data', (chunk) => {
    buf += chunk
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (line === 'cap') onCap(send)
      else dbg(`unknown cmd: ${JSON.stringify(line)}`)
    }
  })
  sock.on('end', () => {
    if (!answered) dbg('cmd socket closed before answer')
  })
})

cmdServer.on('error', (error) => {
  dbg(`cmd server error: ${error}`)
  respond({ ok: false, error: { message: `command pipe failed: ${String((error && error.message) || error)}` } })
  process.exit(1)
})
cmdServer.listen(PIPE_PATH, () => {
  dbg(`pipe listening: ${PIPE_PATH}`)
  // 公告管道名：宿主 stdout 读到这行才知道往哪连
  respond({ ok: true, value: { ready: true, pipe: PIPE_PATH } })
})
