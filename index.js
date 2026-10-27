/**
 * leo-status — Host 半边（v2：多设备 + 中心 + 中转）
 *
 * 三种角色（settings.mode）：
 *   local  : 只扫本机、只看本机（v1 行为，新装默认）
 *   hub    : 本机=数据中心。扫本机 + 起 loopback HTTP 中心（127.0.0.1:hub.port）
 *            + 可选 SSH 反向隧道把中心暴露到 VPS（ssh -R），合并所有设备快照
 *   device : 本机=加入者。扫本机 → join/push 到中心 → 拉取中心合并看板；
 *            中心不可达时退回本机快照并标记 hub.connected=false
 *
 * 浏览器（Client 半边）只访问 DSH 同源路由：
 *   GET  /leo-status/api/todos        当前 Board（按角色）
 *   POST /leo-status/api/join         加入中心（device 流程，写 settings.json）
 *   GET  /leo-status/api/hub/status   角色/中心/隧道状态摘要
 */
import os from 'node:os'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { aggregate, EMPTY_STATS } from './scan.js'
import { createHubStore, buildBoard, createHubHandler, startHubServer } from './hub.js'
import { joinHub, pushSnapshot, fetchBoard, platformId, normalizeHubUrl } from './sync.js'
import {
  resolveDataDir,
  loadSettings,
  saveSettings,
  defaultSettings,
  normalizeSettings,
  effectiveScanConfig,
} from './settings.js'

export const name = 'leo-status'
/** 不硬依赖任何服务：缺 webServer 时插件仍可加载，只是没有页面数据。 */
export const inject = []

export const PLUGIN_VERSION = '0.2.0'

const LOCAL_API = '/leo-status/api/todos'
const JOIN_API = '/leo-status/api/join'
const STATUS_API = '/leo-status/api/hub/status'

const LOCAL_DEVICE_ID = 'local'
const LOCAL_SCAN_TTL_MS = 10_000
const HUB_BOARD_TTL_MS = 5_000
const DEVICE_BOARD_TTL_MS = 20_000

function nowIso() {
  return new Date().toISOString()
}

function describeError(error) {
  if (error === null || error === undefined) return 'unknown error'
  if (typeof error === 'string') return error
  return String(error.message ?? error)
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

async function readJsonBody(req, limit = 1_048_576) {
  let text = ''
  for await (const chunk of req) {
    text += chunk
    if (Buffer.byteLength(text) > limit) throw new Error('请求体过大')
  }
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

export function apply(ctx, config) {
  const rowConfig = config !== null && typeof config === 'object' ? config : {}
  const dataDir = resolveDataDir(rowConfig)
  const log = (...args) => console.log('[leo-status]', ...args)

  /** @type {ReturnType<typeof defaultSettings>} */
  let settings = defaultSettings()
  let settingsError = null

  let localCache = { at: 0, snapshot: null }
  let boardCache = { at: 0, board: null }
  let lastBoard = null
  let lastSyncAt = null
  let lastSyncMs = 0
  let hubError = null

  let syncTimer = null
  let syncRunning = null
  let hubStarting = null
  let hubRuntime = null

  /** @type {{child: any, state: string, error: string|null, restarts: number, timer: any, stopping: boolean}} */
  let tunnel = { child: null, state: 'disabled', error: null, restarts: 0, timer: null, stopping: false }

  const mode = () => settings.mode
  const isHub = () => settings.mode === 'hub'
  const isDevice = () => settings.mode === 'device'

  function localDeviceId() {
    if (isDevice() && settings.device.deviceId) return settings.device.deviceId
    return LOCAL_DEVICE_ID
  }

  function localDeviceInfo() {
    return {
      id: localDeviceId(),
      name: settings.deviceName || os.hostname(),
      platform: platformId(),
      version: PLUGIN_VERSION,
    }
  }

  function relayMeta() {
    if (!isHub()) return { enabled: false, state: 'disabled', error: null }
    return { enabled: settings.hub.tunnel.enabled !== false, state: tunnel.state, error: tunnel.error }
  }

  function baseMeta(extra = {}) {
    return {
      mode: mode(),
      role: mode(),
      hub: {
        connected: isHub() || mode() === 'local',
        lastSyncAt,
        error: hubError,
        relay: relayMeta(),
      },
      config: {
        includeDshTodos: settings.includeDshTodos,
        markdownRootCount: settings.markdownRoots.length,
        syncIntervalMs: settings.syncIntervalMs,
      },
      ...extra,
    }
  }

  /* ------------------------------- 本机扫描 ------------------------------- */

  async function scanLocal(force) {
    if (!force && localCache.snapshot && Date.now() - localCache.at < LOCAL_SCAN_TTL_MS) {
      return localCache.snapshot
    }
    const snapshot = await aggregate(effectiveScanConfig(rowConfig, settings), { force: true })
    localCache = { at: Date.now(), snapshot }
    return snapshot
  }

  const emptyStore = {
    listDevices: () => [],
    getSnapshots: () => [],
  }

  function buildLocalBoard(snapshot, meta) {
    return buildBoard({
      local: snapshot,
      localDevice: localDeviceInfo(),
      store: emptyStore,
      now: new Date(),
      syncIntervalMs: settings.syncIntervalMs,
      meta,
    })
  }

  async function localBoard(force, meta) {
    try {
      const snapshot = await scanLocal(force)
      return buildLocalBoard(snapshot, meta ?? baseMeta())
    } catch (error) {
      return failureBoard(describeError(error), meta ?? baseMeta())
    }
  }

  function failureBoard(error, meta) {
    return {
      ok: false,
      version: 2,
      generatedAt: nowIso(),
      tookMs: 0,
      mode: mode(),
      role: mode(),
      device: localDeviceInfo(),
      hub: {
        connected: false,
        lastSyncAt,
        error,
        relay: relayMeta(),
      },
      devices: [
        {
          id: localDeviceId(),
          name: localDeviceInfo().name,
          platform: platformId(),
          version: PLUGIN_VERSION,
          online: true,
          lastSeen: nowIso(),
          lastPush: null,
          todoCount: 0,
          local: true,
        },
      ],
      sources: [],
      todos: [],
      stats: { ...EMPTY_STATS, cancelled: 0 },
      config: baseMeta().config,
      error,
    }
  }

  /* -------------------------------- Hub 角色 ------------------------------- */

  async function hubBoard(force) {
    const snapshot = await scanLocal(force)
    if (!hubRuntime || !hubRuntime.store) {
      return buildLocalBoard(snapshot, baseMeta({
        hub: { connected: false, lastSyncAt, error: hubError ?? settingsError, relay: relayMeta() },
      }))
    }
    return buildBoard({
      local: snapshot,
      localDevice: localDeviceInfo(),
      store: hubRuntime.store,
      now: new Date(),
      syncIntervalMs: settings.syncIntervalMs,
      meta: baseMeta(),
    })
  }

  async function ensureHub() {
    if (!isHub()) return null
    if (hubRuntime) return hubRuntime
    if (hubStarting) return hubStarting
    hubStarting = (async () => {
      const password = settings.hub.password
      if (typeof password !== 'string' || password === '') {
        hubError = '中心未设置密码：请在数据目录 settings.json 的 hub.password 填入密码'
        tunnel.state = 'disabled'
        log(hubError)
        return null
      }
      const store = createHubStore(dataDir)
      await store.load()
      const handler = createHubHandler({
        password,
        store,
        boardProvider: () => hubBoard(true),
        syncIntervalMs: settings.syncIntervalMs,
        log,
      })
      const server = await startHubServer({ port: settings.hub.port, handler, log })
      hubRuntime = { store, handler, server, url: `http://127.0.0.1:${settings.hub.port}` }
      log('hub listening at', hubRuntime.url)
      startTunnel()
      return hubRuntime
    })()
    try {
      return await hubStarting
    } catch (error) {
      hubError = `中心启动失败：${describeError(error)}`
      log(hubError)
      return null
    } finally {
      hubStarting = null
    }
  }

  /** Windows GUI 进程的 PATH 可能不含 OpenSSH 目录，显式找一遍再退回 `ssh`。 */
  function resolveSshExecutable() {
    const explicit = typeof process.env.LEO_STATUS_SSH === 'string' ? process.env.LEO_STATUS_SSH.trim() : ''
    if (explicit !== '' && existsSync(explicit)) return explicit
    if (process.platform === 'win32') {
      const root = process.env.SystemRoot || 'C:\\Windows'
      const candidates = [
        path.join(root, 'System32', 'OpenSSH', 'ssh.exe'),
        path.join(root, 'Sysnative', 'OpenSSH', 'ssh.exe'),
      ]
      for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate
      }
    }
    return 'ssh'
  }

  function tunnelArgs() {
    const { sshTarget, remotePort } = settings.hub.tunnel
    const localPort = settings.hub.port
    return [
      '-N',
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-R',
      `127.0.0.1:${remotePort}:127.0.0.1:${localPort}`,
      sshTarget,
    ]
  }

  function scheduleTunnelRestart() {
    if (tunnel.stopping || !isHub() || !settings.hub.tunnel.enabled) return
    const delay = Math.min(5000 * 2 ** Math.min(tunnel.restarts, 4), 60_000)
    tunnel.restarts += 1
    if (tunnel.timer) clearTimeout(tunnel.timer)
    tunnel.timer = setTimeout(() => {
      tunnel.timer = null
      startTunnel()
    }, delay)
    tunnel.timer.unref?.()
  }

  function startTunnel() {
    if (tunnel.stopping || !isHub() || !settings.hub.tunnel.enabled) {
      tunnel.state = 'disabled'
      return
    }
    if (tunnel.child) return
    tunnel.state = 'starting'
    tunnel.error = null
    const args = tunnelArgs()
    const sshBin = resolveSshExecutable()
    log('starting ssh tunnel:', sshBin, args.join(' '))
    let child
    try {
      child = spawn(sshBin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      tunnel.state = 'stopped'
      tunnel.error = describeError(error)
      scheduleTunnelRestart()
      return
    }
    tunnel.child = child
    child.stderr?.setEncoding?.('utf8')
    child.stderr?.on?.('data', (chunk) => {
      const text = String(chunk).trim()
      if (text !== '') tunnel.error = text.slice(-400)
    })
    child.stdout?.resume?.()
    child.on('error', (error) => {
      if (tunnel.child === child) tunnel.child = null
      tunnel.state = 'stopped'
      tunnel.error = describeError(error)
      scheduleTunnelRestart()
    })
    child.on('exit', (code, signal) => {
      if (tunnel.child === child) tunnel.child = null
      if (tunnel.stopping) {
        tunnel.state = 'stopped'
        return
      }
      tunnel.state = 'stopped'
      tunnel.error = `ssh 隧道退出（code=${code}${signal ? `, signal=${signal}` : ''}）${tunnel.error ? `：${tunnel.error}` : ''}`
      log(tunnel.error)
      scheduleTunnelRestart()
    })
    const readyTimer = setTimeout(() => {
      if (tunnel.child === child && child.exitCode === null) tunnel.state = 'running'
    }, 2000)
    readyTimer.unref?.()
  }

  function stopTunnel() {
    tunnel.stopping = true
    if (tunnel.timer) {
      clearTimeout(tunnel.timer)
      tunnel.timer = null
    }
    const child = tunnel.child
    tunnel.child = null
    if (child) {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }
    tunnel.state = 'stopped'
  }

  function stopHub() {
    stopTunnel()
    const runtime = hubRuntime
    hubRuntime = null
    if (runtime) {
      try {
        runtime.server?.close?.()
      } catch {
        /* ignore */
      }
    }
  }

  /* -------------------------------- Device 角色 ------------------------------- */

  function deviceFallback(error) {
    hubError = describeError(error)
    const deviceId = settings.device.deviceId || 'unjoined'
    const meta = baseMeta({
      device: { id: deviceId, name: settings.device.name, platform: platformId() },
      hub: { connected: false, lastSyncAt, error: hubError, relay: { enabled: false, state: 'disabled', error: null } },
    })
    return buildLocalBoardWithDevice(meta)
  }

  function buildLocalBoardWithDevice(meta) {
    const snapshot = localCache.snapshot
    if (!snapshot) {
      return failureBoard(meta.hub.error ?? '本机尚无扫描结果', meta)
    }
    const board = buildLocalBoard(snapshot, meta)
    return {
      ...board,
      device: meta.device ?? board.device,
      hub: meta.hub ?? board.hub,
    }
  }

  async function ensureJoined() {
    if (settings.device.deviceId) return settings.device.deviceId
    const joined = await joinHub({
      hubUrl: settings.device.hubUrl,
      password: settings.device.password,
      name: settings.device.name,
      platform: platformId(),
      pluginVersion: PLUGIN_VERSION,
    })
    settings = normalizeSettings({
      ...settings,
      device: { ...settings.device, deviceId: joined.deviceId },
    })
    await saveSettings(dataDir, settings)
    log('joined hub as', joined.deviceId)
    return joined.deviceId
  }

  async function syncOnce(forceScan) {
    if (!isDevice()) throw new Error('当前不是设备模式')
    if (!settings.device.hubUrl) throw new Error('未配置中心地址')
    if (!settings.device.password) throw new Error('未配置中心密码')
    const deviceId = await ensureJoined()
    const snapshot = await scanLocal(forceScan)
    await pushSnapshot({
      hubUrl: settings.device.hubUrl,
      password: settings.device.password,
      deviceId,
      name: settings.device.name,
      platform: platformId(),
      pluginVersion: PLUGIN_VERSION,
      snapshot,
    })
    const board = await fetchBoard({
      hubUrl: settings.device.hubUrl,
      password: settings.device.password,
    })
    lastBoard = board
    lastSyncAt = nowIso()
    lastSyncMs = Date.now()
    hubError = null
    boardCache = { at: Date.now(), board }
    return board
  }

  async function ensureSync(forceScan) {
    if (syncRunning) return syncRunning
    syncRunning = syncOnce(forceScan)
      .catch((error) => {
        hubError = describeError(error)
        log('sync failed:', hubError)
        throw error
      })
      .finally(() => {
        syncRunning = null
      })
    return syncRunning
  }

  function stopSyncTimer() {
    if (syncTimer) {
      clearInterval(syncTimer)
      syncTimer = null
    }
  }

  function startSyncTimer() {
    stopSyncTimer()
    if (!isDevice()) return
    syncTimer = setInterval(() => {
      ensureSync(false).catch(() => {})
    }, settings.syncIntervalMs)
    syncTimer.unref?.()
  }

  /* --------------------------------- 取 Board -------------------------------- */

  async function getBoard(force) {
    if (mode() === 'local') return localBoard(force)
    if (isHub()) {
      await ensureHub()
      if (!force && boardCache.board && Date.now() - boardCache.at < HUB_BOARD_TTL_MS) return boardCache.board
      let board
      try {
        board = await hubBoard(force)
      } catch (error) {
        board = failureBoard(describeError(error))
      }
      boardCache = { at: Date.now(), board }
      return board
    }
    // device
    const fresh = lastBoard !== null && Date.now() - lastSyncMs < DEVICE_BOARD_TTL_MS
    if (!force && fresh) return localize(lastBoard)
    try {
      const board = await ensureSync(force)
      return localize(board)
    } catch (error) {
      return deviceFallback(error)
    }
  }

  /** 中心返回的 board 是 hub 视角；设备端要改写成 device 视角（mode/device/本机标记）。 */
  function localize(board) {
    if (!board || typeof board !== 'object') return board
    if (mode() !== 'device') return board
    const deviceId = settings.device.deviceId || 'unjoined'
    const todos = Array.isArray(board.todos)
      ? board.todos.map((todo) => ({ ...todo, local: todo.deviceId === deviceId }))
      : []
    return {
      ...board,
      mode: 'device',
      role: 'device',
      device: { id: deviceId, name: settings.device.name, platform: platformId() },
      hub: {
        ...(board.hub && typeof board.hub === 'object' ? board.hub : {}),
        connected: board.hub?.connected !== false,
        lastSyncAt: lastSyncAt ?? board.hub?.lastSyncAt ?? null,
      },
      todos,
    }
  }

  async function joinFromLocal(body) {
    const hubUrl = normalizeHubUrl(body.hubUrl)
    const password = typeof body.password === 'string' ? body.password.trim() : ''
    if (password === '') throw new Error('密码不能为空')
    const name = String(body.name || os.hostname()).trim().slice(0, 60) || 'leo-device'
    const joined = await joinHub({
      hubUrl,
      password,
      deviceId: settings.device.deviceId || undefined,
      name,
      platform: platformId(),
      pluginVersion: PLUGIN_VERSION,
    })
    let next = normalizeSettings({
      ...settings,
      mode: 'device',
      deviceName: name,
      device: { deviceId: joined.deviceId, name, hubUrl, password },
    })
    const markdownRoot = typeof body.markdownRoot === 'string' ? body.markdownRoot.trim() : ''
    if (markdownRoot !== '' && next.markdownRoots.length === 0) {
      next = normalizeSettings({
        ...next,
        markdownRoots: [{ id: 'obsidian-main', label: 'Obsidian 主库', path: markdownRoot }],
      })
    }
    settings = await saveSettings(dataDir, next)
    settingsError = null
    localCache = { at: 0, snapshot: null }
    startSyncTimer()
    const board = await ensureSync(true).catch((error) => deviceFallback(error))
    return { ok: true, board: localize(board) }
  }

  function statusPayload() {
    const board = boardCache.board ?? lastBoard
    return {
      ok: true,
      version: 2,
      mode: mode(),
      device: localDeviceInfo(),
      hub: {
        connected: isHub() || mode() === 'local' ? true : board?.hub?.connected === true,
        lastSyncAt,
        error: hubError,
        relay: relayMeta(),
      },
      devices: Array.isArray(board?.devices) ? board.devices.length : 1,
      dataDir,
      settingsError,
    }
  }

  /* -------------------------------- 启动/生命周期 ------------------------------ */

  async function startup() {
    const loaded = await loadSettings(dataDir)
    settings = loaded.settings
    settingsError = loaded.error
    if (settingsError) log(settingsError)
    log(`mode=${settings.mode}`, `dataDir=${dataDir}`)
    if (isHub()) {
      await ensureHub()
    } else if (isDevice()) {
      startSyncTimer()
      ensureSync(false).catch(() => {})
    }
  }

  ctx.effect(() => {
    startup().catch((error) => {
      hubError = describeError(error)
      log('startup failed:', hubError)
    })
    return () => {
      stopSyncTimer()
      stopHub()
    }
  }, 'leo-status: runtime')

  /* ---------------------------------- HTTP --------------------------------- */

  ctx.inject(['webServer', 'connection'], (http) => {
    const connection = http.connection

    const authorized = (req, res) => {
      if (typeof connection?.authorizeIndex === 'function') return connection.authorizeIndex(req, res)
      return true
    }

    const handler = async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname
      try {
        if (!authorized(req, res)) return

        if (path === LOCAL_API) {
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const force = url.searchParams.get('refresh') === '1'
          const board = await getBoard(force)
          sendJson(res, 200, board)
          return
        }

        if (path === JOIN_API) {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const body = await readJsonBody(req)
          try {
            const result = await joinFromLocal(body)
            sendJson(res, 200, result)
          } catch (error) {
            sendJson(res, 400, { ok: false, error: describeError(error) })
          }
          return
        }

        if (path === STATUS_API) {
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          sendJson(res, 200, statusPayload())
          return
        }

        sendJson(res, 404, { ok: false, error: 'not found' })
      } catch (error) {
        try {
          sendJson(res, 500, { ok: false, error: describeError(error) })
        } catch {
          /* 响应可能已结束 */
        }
      }
    }

    for (const routePath of [LOCAL_API, JOIN_API, STATUS_API]) {
      ctx.effect(
        () => http.webServer.register({ kind: 'exact', path: routePath, handler }),
        `leo-status: ${routePath}`,
      )
    }
    log('routes ready ·', [LOCAL_API, JOIN_API, STATUS_API].join(', '))
  })
}
