/**
 * dsh-screenshot — 宿主半（Cordis 插件：name/inject/apply）
 *
 * 职责：
 *   1. 挂 fence + POST /screenshot/api/capture（📷 按钮路径）：向常驻 helper 的
 *      命名管道 `\\.\pipe\dsh-screenshot-<pid>` 发 `cap`、经行协议
 *      `dsh-screenshot-bridge:<json>` 取回 {ok, value}。
 *   2. apply 即拉起常驻 helper（全局热键 Ctrl+Shift+A 需要它活着；OS 级注册、
 *      绕开 DSH 输入闸门——设置面板开着也能截）。
 *   3. listen `\\.\pipe\dsh-screenshot-host` 收 helper 的**热键结果推送**，
 *      经 POST /screenshot/api/watch 长轮询交给浏览器半插输入框。
 *
 * 生命周期：helper 父进程轮询跟 DSH 同寿；插件卸载 disposer 杀进程+关推送。
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-screenshot'
export const inject = ['webServer', 'webRuntime']

const BRIDGE_PREFIX = 'dsh-screenshot-bridge:'
const MAX_BODY_BYTES = 1 << 20

const libDir = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.dirname(libDir)

// ---------------------------------------------------------------------------
// Electron 运行时解析（dsh-pet helper-process.ts 的裁剪版）
// ---------------------------------------------------------------------------
function resolveElectronPath() {
  const fromEnv = process.env.DSH_SCREENSHOT_ELECTRON_PATH
  if (fromEnv) return fromEnv
  try {
    const require_ = createRequire(import.meta.url)
    const resolved = require_('electron')
    if (typeof resolved === 'string' && resolved) return resolved
  } catch {
    // profile 里通常没有 electron 包，走下面的 $DSH_HOME/electron
  }
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const candidate = process.platform === 'win32'
    ? path.join(dshHome, 'electron', 'electron.exe')
    : path.join(dshHome, 'electron', 'electron')
  if (existsSync(candidate)) return candidate
  throw new Error(`electron runtime not found (set DSH_SCREENSHOT_ELECTRON_PATH); looked at ${candidate}`)
}

// ---------------------------------------------------------------------------
// 信任栅栏（behaviorally identical to dsh-better-sidebar/src/trust-fence.ts，
// 后者抄自 dsh-client-connection 的 api-request-trust.ts，BSD-3）
// ---------------------------------------------------------------------------
function header(headers, name_) {
  const value = headers[name_]
  return typeof value === 'string' ? value : undefined
}

function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

function isTrustedApiRequest(request, trustedHosts) {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// HTTP 小工具（better-sidebar wire.ts 的裁剪版）
// ---------------------------------------------------------------------------
function writeJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) req.destroy()
    })
    req.on('end', resolve)
    req.on('error', resolve)
    req.on('close', resolve)
  })
}

// ---------------------------------------------------------------------------
// helper 常驻子进程：命令走 helper 经 stdout 公告的**命名管道**。
// ⚠ stdin 不可用：Electron GUI 子进程的 stdin 读端启动 ~2ms 内即被 Chromium
// 关掉（探针实测 END/CLOSE，写入 cb err=null 但数据静默丢弃）——必须走管道。
// 复用进程省掉每次点击 ~200ms 的 Electron 冷启动（历史：一次性 spawn 全量重启）
// ---------------------------------------------------------------------------
const CAPTURE_TIMEOUT_MS = 10 * 60 * 1000 // 允许用户慢慢框选，卡死才杀
const PIPE_WAIT_MS = 10 * 1000 // 等 helper 公告管道名（启动 ~150ms）
const HOST_PIPE = '\\\\.\\pipe\\dsh-screenshot-host' // 热键结果推送：helper 连入这里
const WATCH_TIMEOUT_MS = 25 * 1000 // watch 长轮询挂起上限（到点回 value:null 让客户端续挂）
const WATCH_BUFFER_MAX = 3 // 没有 watch 在等时缓冲的热键结果条数（丢最旧）

let helperChild = null
let helperPipe = null // '\\\\.\pipe\dsh-screenshot-<pid>'
let pipeWaiters = [] // [{resolve, reject, timer}]

function rejectPipeWaiters(error) {
  const waiters = pipeWaiters
  pipeWaiters = []
  for (const waiter of waiters) {
    clearTimeout(waiter.timer)
    waiter.reject(error)
  }
}

function spawnHelper() {
  const electronPath = resolveElectronPath()
  const helperMain = path.join(pkgRoot, 'runtime', 'electron-helper', 'main.js')
  const helperDir = path.dirname(helperMain)
  if (!existsSync(helperMain)) throw new Error(`helper entry missing: ${helperMain}`)
  const env = { ...process.env }
  // Electron 主进程读到 ELECTRON_RUN_AS_NODE 就退化成纯 Node，必须删掉
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  const child = spawn(electronPath, [helperMain], {
    cwd: helperDir,
    env,
    // 不能用 windowsHide:true —— STARTUPINFO 的 SW_HIDE 会让 helper 的
    // BrowserWindow 即使调 show() 也 isVisible=false（选区窗口永远不出现）。
    // electron.exe 是 GUI 子系统，本来就不会弹控制台。
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let buf = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buf += chunk
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line.startsWith(BRIDGE_PREFIX)) continue // Electron 启动空行等
      let message
      try {
        message = JSON.parse(line.slice(BRIDGE_PREFIX.length))
      } catch {
        dbgHost(`malformed stdout line: ${line.slice(0, 120)}`)
        continue
      }
      if (message.ok === true && message.value && typeof message.value.pipe === 'string') {
        helperPipe = message.value.pipe
        dbgHost(`helper ready, pipe=${helperPipe}`)
        const waiters = pipeWaiters
        pipeWaiters = []
        for (const waiter of waiters) {
          clearTimeout(waiter.timer)
          waiter.resolve(helperPipe)
        }
      } else {
        // 启动失败公告（如 ELECTRON_RUN_AS_NODE 泄漏）——exit 事件会拒掉 waiters
        dbgHost(`helper stdout: ${JSON.stringify(message).slice(0, 200)}`)
      }
    }
  })
  child.stderr.on('data', (chunk) => {
    const text = String(chunk).trim()
    if (text) console.warn(`[dsh-screenshot] helper: ${text}`)
  })
  child.on('error', (error) => {
    console.error('[dsh-screenshot] helper process error:', error)
    rejectPipeWaiters(error)
  })
  child.on('exit', (code, signal) => {
    dbgHost(`helper exited (code=${code}, signal=${signal})`)
    if (helperChild === child) {
      helperChild = null
      helperPipe = null
    }
    const error = new Error(`screenshot helper exited unexpectedly (code=${code}, signal=${signal})`)
    error.byConnect = true // 未公告/半路死掉 → 允许 runCapture 重拉一次
    rejectPipeWaiters(error)
  })
  return child
}

function dbgHost(message) {
  try {
    appendFileSync(path.join(os.tmpdir(), 'dsh-screenshot-debug.log'), `[${new Date().toISOString()}] [host] ${message}\n`)
  } catch {
    // ignore
  }
}

function ensureChild() {
  if (helperChild && helperChild.exitCode === null && !helperChild.killed) return helperChild
  helperPipe = null
  helperChild = spawnHelper()
  return helperChild
}

function waitForPipe(child) {
  if (helperPipe) return Promise.resolve(helperPipe)
  return new Promise((resolve, reject) => {
    const waiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        pipeWaiters = pipeWaiters.filter((entry) => entry !== waiter)
        try { child.kill() } catch { /* ignore */ }
        if (helperChild === child) {
          helperChild = null
          helperPipe = null
        }
        const error = new Error('helper did not announce its command pipe')
        error.byConnect = true
        reject(error)
      }, PIPE_WAIT_MS),
    }
    pipeWaiters.push(waiter)
  })
}

function connectAndCapture(pipePath) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(pipePath)
    let connected = false
    let settled = false
    const settle = (fn, arg) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { sock.destroy() } catch { /* ignore */ }
      if (!connected && arg instanceof Error) arg.byConnect = true
      fn(arg)
    }
    const timer = setTimeout(() => settle(reject, new Error('screenshot helper timed out')), CAPTURE_TIMEOUT_MS)
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('connect', () => {
      connected = true
      sock.write('cap\n')
      dbgHost(`cap sent via ${pipePath}`)
    })
    sock.on('data', (chunk) => {
      buf += chunk
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line.startsWith(BRIDGE_PREFIX)) continue
        try {
          const message = JSON.parse(line.slice(BRIDGE_PREFIX.length))
          if (message.ok === true) settle(resolve, message.value)
          else settle(reject, new Error((message.error && message.error.message) || 'screenshot failed'))
        } catch {
          settle(reject, new Error('malformed bridge line from screenshot helper'))
        }
      }
    })
    sock.on('error', (error) => settle(reject, error))
    sock.on('close', () => settle(reject, new Error('helper connection closed before result')))
  })
}

async function runCapture() {
  let retried = false
  for (;;) {
    let child
    try {
      child = ensureChild()
    } catch (error) {
      throw error
    }
    try {
      const pipePath = await waitForPipe(child)
      return await connectAndCapture(pipePath)
    } catch (error) {
      // 只对「没连上」重试一次（管道过期=helper 已自退、启动竞态）；
      // 选区超时/取消等业务错误不重试，避免杀掉用户正在进行的选区。
      if (retried || !error.byConnect) throw error
      retried = true
      dbgHost(`capture connect failed (${error && error.message}), respawning helper once`)
      if (helperChild === child) {
        try { child.kill() } catch { /* ignore */ }
        helperChild = null
      }
      helperPipe = null
    }
  }
}

function stopHelper() {
  const child = helperChild
  helperChild = null
  helperPipe = null
  rejectPipeWaiters(new Error('dsh-screenshot plugin unloading'))
  if (child) {
    try { child.kill() } catch { /* ignore */ }
  }
}

// 单飞：同时只有一个截图流程，后来的请求复用同一次 capture
let activeCapture = null
function captureOnce() {
  if (activeCapture === null) {
    activeCapture = runCapture().finally(() => {
      activeCapture = null
    })
  }
  return activeCapture
}

// ---------------------------------------------------------------------------
// 热键结果推送服务器（helper 连入）+ /screenshot/api/watch 长轮询
// ---------------------------------------------------------------------------
let hostServer = null
const watchWaiters = [] // [{res, timer}] 挂着的 watch 请求
const hotkeyBuffer = [] // 没有 watch 在等时暂存的热键结果 {ok, value|error}

function deliverHotkey(message) {
  const waiter = watchWaiters.shift()
  if (waiter) {
    clearTimeout(waiter.timer)
    try {
      writeJson(waiter.res, 200, message)
      dbgHost('watch: hotkey result delivered to live waiter')
    } catch {
      // 客户端可能刚断开
    }
    return
  }
  hotkeyBuffer.push(message)
  if (hotkeyBuffer.length > WATCH_BUFFER_MAX) {
    hotkeyBuffer.shift()
    dbgHost('watch buffer full, dropped oldest hotkey result')
  }
  dbgHost(`watch: buffered hotkey result (len=${hotkeyBuffer.length}, no waiter)`)
}

function startHostPipe() {
  hostServer = net.createServer((sock) => {
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('data', (chunk) => {
      buf += chunk
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line.startsWith(BRIDGE_PREFIX)) continue
        let message
        try {
          message = JSON.parse(line.slice(BRIDGE_PREFIX.length))
        } catch {
          dbgHost('malformed push line from helper')
          continue
        }
        deliverHotkey(message)
      }
    })
    sock.on('error', (error) => { dbgHost(`host push socket error: ${error}`) })
  })
  hostServer.on('error', (error) => {
    // 典型：上个 DSH 实例的服务器还没释放。热键结果会暂存在 helper 侧缓冲，
    // 连接每 2s 重试，恢复后积压照常送达。
    dbgHost(`host pipe error: ${error}`)
    console.warn(`[dsh-screenshot] hotkey push pipe unavailable: ${error}`)
  })
  hostServer.listen(HOST_PIPE, () => { dbgHost(`host pipe listening: ${HOST_PIPE}`) })
}

function closeHostPipe() {
  const waiters = watchWaiters.splice(0)
  for (const waiter of waiters) {
    clearTimeout(waiter.timer)
    try { writeJson(waiter.res, 200, { ok: true, value: null }) } catch { /* ignore */ }
  }
  if (hostServer) {
    try { hostServer.close() } catch { /* ignore */ }
    hostServer = null
  }
}

// ---------------------------------------------------------------------------
// 挂载
// ---------------------------------------------------------------------------
export function apply(ctx) {
  const trustedHosts = () => {
    try {
      return (ctx.webRuntime && ctx.webRuntime.trustedHosts) || []
    } catch {
      return []
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/screenshot/api',
    handler: async (req, res) => {
      if (!isTrustedApiRequest(req, trustedHosts())) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      if (pathname !== '/screenshot/api/capture' && pathname !== '/screenshot/api/watch') {
        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown screenshot API method' } })
        return
      }
      await readBody(req)
      if (pathname === '/screenshot/api/watch') {
        // 热键结果长轮询：有积压立即回；否则挂起（25s 到点回 value:null 续挂）。
        const buffered = hotkeyBuffer.shift()
        if (buffered) {
          writeJson(res, 200, buffered)
          return
        }
        const waiter = { res, timer: null }
        waiter.timer = setTimeout(() => {
          const index = watchWaiters.indexOf(waiter)
          if (index < 0) return
          watchWaiters.splice(index, 1)
          try { writeJson(res, 200, { ok: true, value: null }) } catch { /* ignore */ }
        }, WATCH_TIMEOUT_MS)
        res.on('close', () => {
          const index = watchWaiters.indexOf(waiter)
          if (index < 0) return
          watchWaiters.splice(index, 1)
          clearTimeout(waiter.timer)
        })
        watchWaiters.push(waiter)
        return
      }
      try {
        const value = await captureOnce()
        writeJson(res, 200, { ok: true, value })
      } catch (error) {
        console.error('[dsh-screenshot] capture failed:', error)
        writeJson(res, 500, {
          ok: false,
          error: { code: 'capture-failed', message: String((error && error.message) || error) },
        })
      }
    },
  }), 'dsh-screenshot: /screenshot/api routes')

  // 常驻生命周期：apply 即 listen 推送服务器（先于 spawn，减少竞态）并拉起
  // helper（全局热键要它一开始就活着）；卸载/热重载 → 杀 helper + 关推送。
  ctx.effect(() => {
    startHostPipe()
    try {
      ensureChild()
      dbgHost('eager helper spawn requested (resident for global hotkey)')
    } catch (error) {
      console.warn('[dsh-screenshot] eager helper spawn failed:', String((error && error.message) || error))
      dbgHost(`eager helper spawn failed: ${String((error && error.message) || error)}`)
    }
    return () => {
      stopHelper()
      closeHostPipe()
    }
  }, 'dsh-screenshot: helper lifecycle')
}
