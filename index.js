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
import { promises as fsp } from 'node:fs'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { aggregate, EMPTY_STATS, detectVaults } from './scan.js'
import { createHubStore, buildBoard, createHubHandler, startHubServer } from './hub.js'
import { joinHub, pushSnapshot, fetchBoard, platformId, normalizeHubUrl } from './sync.js'
import { applyTodoAction, EditError } from './edit.js'
import { createSuggestionStore, deriveSuggestions } from './suggest.js'
import { createYuanService } from './yuan.js'
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

export const PLUGIN_VERSION = '0.4.2'

const LOCAL_API = '/leo-status/api/todos'
const JOIN_API = '/leo-status/api/join'
const STATUS_API = '/leo-status/api/hub/status'
const ACTION_API = '/leo-status/api/todos/action'

// v0.4：阿源 / 自动发现
const YUAN_STATE_API = '/leo-status/api/yuan/state'
const YUAN_SIGNALS_API = '/leo-status/api/yuan/signals'
const YUAN_CHAT_API = '/leo-status/api/yuan/chat'
const YUAN_SUGGEST_ACCEPT_API = '/leo-status/api/yuan/suggestion/accept'
const YUAN_SUGGEST_DISMISS_API = '/leo-status/api/yuan/suggestion/dismiss'
const YUAN_REMEMBER_API = '/leo-status/api/yuan/remember'
const YUAN_MEMORY_DELETE_API = '/leo-status/api/yuan/memory/delete'
const YUAN_MEMORY_ACCEPT_API = '/leo-status/api/yuan/memory/accept'
const YUAN_REMINDER_API = '/leo-status/api/yuan/reminder'
const YUAN_REMINDER_DONE_API = '/leo-status/api/yuan/reminder/done'
const YUAN_SEEN_API = '/leo-status/api/yuan/seen'
const VAULTS_API = '/leo-status/api/obsidian/vaults'
const VAULT_ATTACH_API = '/leo-status/api/obsidian/attach'
const SETTINGS_API = '/leo-status/api/settings'

const API_ROUTES = [
  LOCAL_API,
  JOIN_API,
  STATUS_API,
  ACTION_API,
  YUAN_STATE_API,
  YUAN_SIGNALS_API,
  YUAN_CHAT_API,
  YUAN_SUGGEST_ACCEPT_API,
  YUAN_SUGGEST_DISMISS_API,
  YUAN_REMEMBER_API,
  YUAN_MEMORY_DELETE_API,
  YUAN_MEMORY_ACCEPT_API,
  YUAN_REMINDER_API,
  YUAN_REMINDER_DONE_API,
  YUAN_SEEN_API,
  VAULTS_API,
  VAULT_ATTACH_API,
  SETTINGS_API,
]

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
  /**
   * 页面 token：DSH 的 cookie 鉴权（authorizeIndex）在部分窗口/重启后会失效（401），
   * 所以插件在 index HTML 里注入一个每次启动随机生成的 token，页面 fetch 时带上它；
   * cookie 鉴权仍保留为回退（两者任一通过即可）。
   */
  const pageToken = randomBytes(24).toString('hex')
  const PAGE_TOKEN_HEADER = 'x-leo-status-token'

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
  /** 写操作串行化：同一文件的 cancel/restore/delete 不并发。 */
  let actionQueue = Promise.resolve()

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
    const snapshot = await aggregate(effectiveScanConfig(rowConfig, settings, dataDir), { force: true })
    localCache = { at: Date.now(), snapshot }
    return snapshot
  }

  const emptyStore = {
    listDevices: () => [],
    getSnapshots: () => [],
  }

  /* ------------------------- v0.4：建议箱 / 阿源 ------------------------- */

  /** 建议箱（suggest.js）与阿源（yuan.js）都懒初始化；启动完成后可用。 */
  let suggestionStore = null
  let yuanService = null
  let llm = null
  let agentDefaultModel = null

  /** llm 是动态注入的；用 getter 桥避免初始化顺序问题。 */
  const llmBridge = {
    get stream() {
      return llm !== null && llm !== undefined && typeof llm.stream === 'function' ? llm.stream.bind(llm) : undefined
    },
    listProviders() {
      return llm !== null && llm !== undefined && typeof llm.listProviders === 'function' ? llm.listProviders() : []
    },
  }

  /** 阿源模型：默认模型选择 → settings.yuan.model → null（yuan.js 内部有兜底）。 */
  function yuanGetModel() {
    try {
      if (agentDefaultModel !== null && agentDefaultModel !== undefined && typeof agentDefaultModel.currentSelection === 'function') {
        const selection = agentDefaultModel.currentSelection()
        if (selection !== null && typeof selection === 'object' && typeof selection.provider === 'string' && typeof selection.model === 'string') {
          return selection
        }
      }
    } catch (error) {
      log('yuan: default model unavailable:', describeError(error))
    }
    return settings.yuan.model
  }

  function invalidateBoards() {
    localCache = { at: 0, snapshot: null }
    boardCache = { at: 0, board: null }
    lastBoard = null
    lastSyncMs = 0
  }

  async function initV042() {
    try {
      suggestionStore = createSuggestionStore(dataDir)
      await suggestionStore.load()
      yuanService = createYuanService({
        dataDir,
        log,
        llm: llmBridge,
        getModel: yuanGetModel,
        config: settings,
      })
      await yuanService.ensureLoaded()
      log('yuan ready · suggestions + memory loaded')
    } catch (error) {
      log('v0.4 init failed:', describeError(error))
    }
  }

  /**
   * v0.4.1 迁移：旧版把 DSH 会话 todo 直接放进看板/建议箱，几乎都不可用。
   * 一次性清空「session 来源」的建议（pending 与 accepted 都清），tombstone 后不再复活；
   * 阿源自己提议（source:'yuan'）和用户手动加的保留。
   */
  async function migrateStaleSessionSuggestions() {
    if (suggestionStore === null) return
    const migrations = settings.migrations !== null && typeof settings.migrations === 'object' ? settings.migrations : {}
    if (migrations.removedSessionSuggestionsAt) return
    let removed = 0
    try {
      for (const status of ['pending', 'accepted']) {
        for (const item of suggestionStore.list(status)) {
          if (item === null || typeof item !== 'object' || item.source !== 'session') continue
          try {
            if (suggestionStore.remove(item.id)) removed += 1
          } catch {
            /* 单条失败不影响迁移 */
          }
        }
      }
      settings = await saveSettings(dataDir, {
        ...settings,
        migrations: {
          ...migrations,
          dismissedSessionSuggestionsAt: migrations.dismissedSessionSuggestionsAt ?? nowIso(),
          removedSessionSuggestionsAt: nowIso(),
        },
      })
      log(`migration: removed stale session suggestions = ${removed}`)
    } catch (error) {
      log('migration failed:', describeError(error))
    }
  }

  /** 设置脱敏（去掉密码，供 UI 读取）。 */
  function safeSettings() {
    const copy = JSON.parse(JSON.stringify(settings))
    if (copy.hub && typeof copy.hub === 'object') delete copy.hub.password
    if (copy.device && typeof copy.device === 'object') delete copy.device.password
    return copy
  }

  function depMerge(base, patch) {
    const out = JSON.parse(JSON.stringify(base))
    const put = (target, source) => {
      for (const [key, value] of Object.entries(source)) {
        if (value !== null && typeof value === 'object' && !Array.isArray(value) && target[key] !== null && typeof target[key] === 'object' && !Array.isArray(target[key])) {
          put(target[key], value)
        } else if (value !== undefined) {
          target[key] = JSON.parse(JSON.stringify(value))
        }
      }
    }
    if (patch !== null && typeof patch === 'object' && !Array.isArray(patch)) put(out, patch)
    return out
  }

  /** 只允许从 UI 修改的字段（模式/密码/隧道不在此列）。 */
  function applySettingsPatch(patch) {
    const source = patch !== null && typeof patch === 'object' ? patch : {}
    const allowed = {
      obsidian: source.obsidian,
      sessionFilter: source.sessionFilter,
      yuan: source.yuan,
      includeDshTodos: source.includeDshTodos,
      includeDshCompleted: source.includeDshCompleted,
      syncIntervalMs: source.syncIntervalMs,
      markdownRoots: source.markdownRoots,
    }
    const clean = {}
    for (const [key, value] of Object.entries(allowed)) if (value !== undefined) clean[key] = value
    return normalizeSettings(depMerge(settings, clean))
  }

  function suggestionToTodo(item) {
    const deviceId = localDeviceId()
    return {
      id: `${deviceId}:${item.id}`,
      kind: 'suggestion',
      text: item.text,
      raw: '',
      done: false,
      cancelled: false,
      sourceId: 'yuan',
      sourceLabel: '阿源',
      file: null,
      relPath: null,
      line: 0,
      heading: null,
      indent: 0,
      noteDate: null,
      due: null,
      scheduled: null,
      start: null,
      priority: 'none',
      tags: [],
      links: [],
      recurrence: null,
      sessionId: item.sessionId ?? null,
      sessionTitle: item.sessionTitle ?? null,
      project: item.project ?? null,
      deviceId,
      deviceName: localDeviceInfo().name,
      local: true,
      editable: false,
      writable: false,
      discoveredBy: 'yuan',
      acceptedAt: item.acceptedAt ?? nowIso(),
      suggestionId: item.id,
    }
  }

  /**
   * v0.4.1：DSH 会话 todo 不再直接进看板 —— 只作为阿源建议（必须 accept）。
   * 这里把 Board 里已有的 dsh 行与 dsh 来源一并剥离，并重算统计。
   */
  function stripSessionTodos(board) {
    if (board === null || typeof board !== 'object' || board.ok === false) return board
    const todos = Array.isArray(board.todos) ? board.todos.filter((todo) => todo !== null && typeof todo === 'object' && todo.kind !== 'dsh') : []
    const sources = Array.isArray(board.sources)
      ? board.sources.filter((source) => source !== null && typeof source === 'object' && source.kind !== 'dsh' && source.id !== 'dsh-sessions')
      : []
    return {
      ...board,
      todos,
      sources,
      stats: recomputeStats(todos, new Date()),
    }
  }

  function recomputeStats(todos, now) {
    const stats = { total: todos.length, open: 0, done: 0, cancelled: 0, overdue: 0, dueToday: 0, dueSoon: 0, undated: 0 }
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    for (const todo of todos) {
      if (todo.done === true) {
        stats.done += 1
        continue
      }
      if (todo.cancelled === true) {
        stats.cancelled += 1
        continue
      }
      stats.open += 1
      if (typeof todo.due !== 'string' || todo.due === '') {
        stats.undated += 1
        continue
      }
      const parts = todo.due.split('-').map(Number)
      if (parts.length < 3 || parts.some((value) => !Number.isFinite(value))) {
        stats.undated += 1
        continue
      }
      const dueLocal = new Date(parts[0], parts[1] - 1, parts[2])
      const diffDays = Math.round((dueLocal.getTime() - today.getTime()) / 86_400_000)
      if (diffDays < 0) stats.overdue += 1
      else if (diffDays === 0) stats.dueToday += 1
      else if (diffDays <= 7) stats.dueSoon += 1
    }
    return stats
  }

  /**
   * 看板增强：派生会话建议 → 合并建议箱 → accepted 变 todo → 阿源信号。
   * 失败只降级（不阻断看板）。
   */
  async function augmentBoard(board, snapshot) {
    if (board === null || typeof board !== 'object' || board.ok === false) return board
    board = stripSessionTodos(board)
    let pending = []
    let accepted = []
    try {
      if (suggestionStore !== null && snapshot !== null && typeof snapshot === 'object') {
        const derived = deriveSuggestions(snapshot, { filter: settings.sessionFilter, now: Date.now() })
        await suggestionStore.mergeDerived(derived.items)
      }
      if (suggestionStore !== null) {
        pending = suggestionStore.list('pending')
        accepted = suggestionStore.list('accepted')
      }
    } catch (error) {
      log('augmentBoard suggestions failed:', describeError(error))
    }

    const todos = Array.isArray(board.todos) ? [...board.todos] : []
    const seen = new Set(todos.map((todo) => todo.id))
    for (const item of accepted) {
      if (item === null || typeof item !== 'object' || typeof item.id !== 'string') continue
      const todo = suggestionToTodo(item)
      if (seen.has(todo.id)) continue
      todos.push(todo)
      seen.add(todo.id)
    }

    const out = { ...board, todos, suggestions: pending }
    try {
      if (yuanService !== null) {
        const payload = await yuanService.statePayload({ board: out, suggestions: pending })
        out.yuan = { name: payload.name, signals: payload.signals, badge: payload.badge, unread: payload.unread }
      }
    } catch (error) {
      log('augmentBoard yuan failed:', describeError(error))
    }

    if (out.stats !== null && typeof out.stats === 'object' && accepted.length > 0) {
      const openAccepted = accepted.filter((item) => item && item.done !== true).length
      out.stats = {
        ...out.stats,
        ...(Number.isFinite(out.stats.total) ? { total: out.stats.total + accepted.length } : {}),
        ...(Number.isFinite(out.stats.open) ? { open: out.stats.open + openAccepted } : {}),
      }
    }
    return out
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
      const board = buildLocalBoard(snapshot, meta ?? baseMeta())
      return await augmentBoard(board, snapshot)
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
      const local = buildLocalBoard(snapshot, baseMeta({
        hub: { connected: false, lastSyncAt, error: hubError ?? settingsError, relay: relayMeta() },
      }))
      return augmentBoard(local, snapshot)
    }
    const board = buildBoard({
      local: snapshot,
      localDevice: localDeviceInfo(),
      store: hubRuntime.store,
      now: new Date(),
      syncIntervalMs: settings.syncIntervalMs,
      meta: baseMeta(),
    })
    return augmentBoard(board, snapshot)
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
    if (!force && fresh) {
      const localized = localize(lastBoard)
      if (localCache.snapshot !== null) return augmentBoard(localized, localCache.snapshot)
      return localized
    }
    try {
      const board = await ensureSync(force)
      const localized = localize(board)
      if (localCache.snapshot !== null) return augmentBoard(localized, localCache.snapshot)
      return localized
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

  /* ------------------------------ 行内写操作（v3） ----------------------------- */

  /** 把 Board 里的 id 归一化回本地扫描快照里的 `md:...` id。 */
  function normalizeTodoId(boardId) {
    const text = typeof boardId === 'string' ? boardId : ''
    if (text === '') return ''
    const deviceId = settings.device.deviceId
    if (isDevice() && deviceId && text.startsWith(`${deviceId}:`)) return text.slice(deviceId.length + 1)
    if (text.startsWith('local:')) return text.slice('local:'.length)
    return text
  }

  function actionStatus(error) {
    if (!(error instanceof EditError)) return 500
    if (error.code === 'changed') return 409
    if (error.code === 'not-found') return 404
    if (error.code === 'outside-roots' || error.code === 'unsupported') return 400
    return 500
  }

  async function performTodoAction(body) {
    const action = body !== null && typeof body === 'object' ? body.action : null
    const allowed = action === 'cancel' || action === 'restore' || action === 'delete' || action === 'done' || action === 'undone'
    if (!allowed) {
      throw new EditError('unsupported', '不支持的操作')
    }
    const id = normalizeTodoId(body.id)
    if (id === '') throw new EditError('not-found', '缺少 todo id')

    // 阿源接受的建议不是笔记行：只支持「移除」（回到未接受状态需重新 accept）。
    if (id.startsWith('sug:')) {
      if (action !== 'delete') throw new EditError('unsupported', '阿源建议只支持移除')
      if (suggestionStore === null) throw new EditError('not-found', '建议箱尚未就绪')
      const removed = suggestionStore.remove(id)
      if (!removed) throw new EditError('not-found', '建议不存在或已被处理')
      invalidateBoards()
      const board = await getBoard(true)
      return { ok: true, action: 'delete', line: 0, raw: '', todo: null, board }
    }

    const scanConfig = effectiveScanConfig(rowConfig, settings, dataDir)
    const snapshot = await aggregate(scanConfig, { force: true })
    const target = snapshot.todos.find((todo) => todo.kind === 'markdown' && todo.id === id)
    if (!target) throw new EditError('not-found', '找不到这条 todo（可能已被删除或文件已变化），请刷新后再试')

    const result = await applyTodoAction({
      action,
      filePath: target.file,
      line: target.line,
      raw: target.raw,
      roots: scanConfig.markdownRoots,
    })

    // 让下一次扫描重读文件，并把最新 Board 返回给客户端。
    localCache = { at: 0, snapshot: null }
    boardCache = { at: 0, board: null }
    const board = await getBoard(true)
    const updated = Array.isArray(board.todos)
      ? board.todos.find((todo) => normalizeTodoId(todo.id) === id || (id !== '' && todo.id.endsWith(id)))
      : null
    return {
      ok: true,
      action,
      line: result.line,
      raw: result.raw,
      todo: action === 'delete' ? null : updated ?? null,      board,
    }
  }

  function enqueueAction(operation) {
    const run = actionQueue.then(operation, operation)
    actionQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /* -------------------------------- 启动/生命周期 ------------------------------ */

  async function startup() {
    const loaded = await loadSettings(dataDir)
    settings = loaded.settings
    settingsError = loaded.error
    if (settingsError) log(settingsError)
    log(`mode=${settings.mode}`, `dataDir=${dataDir}`)
    await initV042()
    await migrateStaleSessionSuggestions()
    if (isHub()) {
      await ensureHub()
    } else if (isDevice()) {
      startSyncTimer()
      ensureSync(false).catch(() => {})
    }
  }

  /** 设置加载完成前到达的请求要等它，避免用默认设置先扫一遍。 */
  let startupPromise = null

  ctx.effect(() => {
    startupPromise = startup()
    startupPromise.catch((error) => {
      hubError = describeError(error)
      log('startup failed:', hubError)
    })
    return () => {
      stopSyncTimer()
      stopHub()
    }
  }, 'leo-status: runtime')

  // 阿源用的宿主服务：llm 是硬能力（缺了自动降级），默认模型选择是可选增强。
  ctx.inject(['llm'], (services) => {
    llm = services.llm
    log('llm service ready ·阿源可调用模型')
  })
  ctx.inject(['agentDefaultModel'], (services) => {
    agentDefaultModel = services.agentDefaultModel
  })

  /* ---------------------------------- HTTP --------------------------------- */

  ctx.inject(['webServer', 'connection'], (http) => {
    const connection = http.connection

    const tokenMatches = (req) => {
      const header = req.headers !== null && typeof req.headers === 'object' ? req.headers[PAGE_TOKEN_HEADER] : undefined
      if (typeof header !== 'string' || header === '') return false
      const expected = Buffer.from(pageToken, 'utf8')
      const actual = Buffer.from(header, 'utf8')
      return actual.length === expected.length && timingSafeEqual(actual, expected)
    }

    const authorized = (req, res) => {
      const site = req.headers !== null && typeof req.headers === 'object' ? req.headers['sec-fetch-site'] : undefined
      if (typeof site === 'string' && site.toLowerCase() === 'cross-site') {
        try {
          sendJson(res, 403, { ok: false, error: 'cross-site request rejected' })
        } catch {
          /* ignore */
        }
        return false
      }
      if (tokenMatches(req)) return true
      if (typeof connection?.authorizeIndex === 'function') {
        const ok = connection.authorizeIndex(req, res)
        if (ok) return true
        // 正常实现会自己写 401；兜底确保总有响应（也方便测试替身）。
        const alreadySent = res !== null && typeof res === 'object' && (res.headersSent === true || res.writableEnded === true)
        if (!alreadySent) {
          try {
            sendJson(res, 401, { ok: false, error: 'unauthorized' })
          } catch {
            /* ignore */
          }
        }
        return false
      }
      return true
    }

    // 把页面 token 注入 index HTML（页面里的 client 读 window.__LEO_STATUS_PAGE_TOKEN__）。
    try {
      ctx.effect(
        () =>
          http.webServer.tapIndex((html) => {
            if (typeof html !== 'string' || html.includes('__LEO_STATUS_PAGE_TOKEN__')) return html
            const script = `<script>window.__LEO_STATUS_PAGE_TOKEN__=${JSON.stringify(pageToken)}</script>`
            return html.includes('</head>') ? html.replace('</head>', `${script}</head>`) : `${html}${script}`
          }),
        'leo-status: page token',
      )
    } catch (error) {
      log('page token injection unavailable:', describeError(error))
    }

    /* ------------------------- v0.4 路由辅助 ------------------------- */

    const normPath = (value) => {
      try {
        const resolved = path.resolve(String(value ?? ''))
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved
      } catch {
        return String(value ?? '').toLowerCase()
      }
    }

    const plainText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

    function pendingSuggestions() {
      return suggestionStore !== null ? suggestionStore.list('pending') : []
    }

    async function yuanState() {
      const board = await getBoard(false)
      const suggestions = Array.isArray(board?.suggestions) ? board.suggestions : pendingSuggestions()
      if (yuanService === null) {
        return {
          ok: true,
          name: '阿源',
          signals: [],
          badge: { total: 0, urgent: 0, kinds: {}, hasUnread: false },
          unread: false,
          suggestions,
          chat: [],
          memory: [],
          reminders: [],
          model: { provider: null, model: null, available: false },
        }
      }
      const payload = await yuanService.statePayload({ board, suggestions, chatLimit: 30 })
      return { ok: true, ...payload, suggestions }
    }

    async function yuanSignals() {
      const board = boardCache.board ?? lastBoard ?? null
      const suggestions = pendingSuggestions()
      if (yuanService === null) {
        return { ok: true, signals: [], badge: { total: 0, urgent: 0, kinds: {}, hasUnread: false }, unread: false, pending: suggestions.length }
      }
      const payload = await yuanService.statePayload({ board, suggestions, chatLimit: 0 })
      return { ok: true, signals: payload.signals, badge: payload.badge, unread: payload.unread, pending: suggestions.length }
    }

    async function yuanChat(body) {
      if (yuanService === null) throw new Error('阿源尚未就绪，请稍后重试')
      const message = typeof body?.message === 'string' ? body.message.trim() : ''
      if (message === '') throw new Error('消息不能为空')
      const board = await getBoard(false)
      const suggestions = Array.isArray(board?.suggestions) ? board.suggestions : pendingSuggestions()
      const result = await yuanService.chat(message, { board, suggestions })
      const created = []
      if (Array.isArray(result.proposals) && result.proposals.length > 0 && suggestionStore !== null) {
        const items = result.proposals.map((proposal) => {
          const text = plainText(proposal?.text)
          const id = `sug:${createHash('sha1').update(`yuan\u0000${text}`).digest('hex').slice(0, 16)}`
          return {
            id,
            text,
            normalized: text,
            source: 'yuan',
            sessionId: null,
            sessionTitle: null,
            project: null,
            kind: 'relevant',
            score: 1,
            bucket: 'accept',
            reasons: ['阿源提议'],
            status: 'pending',
            createdAt: nowIso(),
          }
        })
        try {
          const merged = await suggestionStore.mergeDerived(items)
          created.push(...(merged?.added ?? []).map((item) => item.id))
        } catch (error) {
          log('yuan proposal merge failed:', describeError(error))
        }
        invalidateBoards()
      }
      const fresh = await getBoard(false)
      return {
        ok: true,
        reply: result.reply,
        chat: result.chat,
        proposals: result.proposals,
        suggestions: Array.isArray(fresh?.suggestions) ? fresh.suggestions : pendingSuggestions(),
        signals: fresh?.yuan?.signals ?? [],
        badge: fresh?.yuan?.badge ?? { total: 0, urgent: 0, kinds: {}, hasUnread: false },
        created,
      }
    }

    async function acceptSuggestion(body) {
      const id = typeof body?.id === 'string' ? body.id.trim() : ''
      if (id === '') throw new Error('缺少建议 id')
      if (suggestionStore === null) throw new Error('建议箱尚未就绪')
      const item = suggestionStore.accept(id)
      if (item === null || item === undefined) throw new Error('建议不存在或已被处理')
      invalidateBoards()
      const board = await getBoard(true)
      return { ok: true, item, suggestions: pendingSuggestions(), board }
    }

    async function dismissSuggestion(body) {
      const id = typeof body?.id === 'string' ? body.id.trim() : ''
      if (id === '') throw new Error('缺少建议 id')
      if (suggestionStore === null) throw new Error('建议箱尚未就绪')
      const item = suggestionStore.dismiss(id)
      if (item === null || item === undefined) throw new Error('建议不存在或已被处理')
      invalidateBoards()
      return { ok: true, item, suggestions: pendingSuggestions() }
    }

    async function memoryList() {
      if (yuanService === null) return []
      return yuanService.memory.slice(-200)
    }

    async function remember(body) {
      if (yuanService === null) throw new Error('阿源尚未就绪')
      const text = plainText(body?.text)
      if (text === '') throw new Error('记忆内容不能为空')
      const memory = await yuanService.remember(text)
      return { ok: true, memory, memories: await memoryList() }
    }

    async function forgetMemory(body) {
      if (yuanService === null) throw new Error('阿源尚未就绪')
      const id = typeof body?.id === 'string' ? body.id.trim() : ''
      if (id === '') throw new Error('缺少记忆 id')
      const ok = await yuanService.forget(id)
      return { ok, memories: await memoryList() }
    }

    async function acceptMemory(body) {
      if (yuanService === null) throw new Error('阿源尚未就绪')
      const id = typeof body?.id === 'string' ? body.id.trim() : ''
      if (id === '') throw new Error('缺少记忆 id')
      const memory = await yuanService.acceptMemory(id)
      return { ok: memory !== null, memory, memories: await memoryList() }
    }

    async function addReminder(body) {
      if (yuanService === null) throw new Error('阿源尚未就绪')
      const text = plainText(body?.text)
      const at = typeof body?.at === 'string' ? body.at : ''
      if (text === '') throw new Error('提醒内容不能为空')
      const reminder = await yuanService.addReminder(text, at)
      const payload = await yuanService.statePayload({ board: boardCache.board ?? lastBoard, suggestions: pendingSuggestions(), chatLimit: 0 })
      return { ok: true, reminder, reminders: payload.reminders, signals: payload.signals, badge: payload.badge }
    }

    async function finishReminder(body) {
      if (yuanService === null) throw new Error('阿源尚未就绪')
      const id = typeof body?.id === 'string' ? body.id.trim() : ''
      if (id === '') throw new Error('缺少提醒 id')
      const reminder = await yuanService.doneReminder(id)
      if (reminder === null) throw new Error('提醒不存在')
      const payload = await yuanService.statePayload({ board: boardCache.board ?? lastBoard, suggestions: pendingSuggestions(), chatLimit: 0 })
      return { ok: true, reminder, reminders: payload.reminders, signals: payload.signals, badge: payload.badge }
    }

    async function markSeen() {
      const lastSeenAt = yuanService !== null ? await yuanService.markSeen() : Date.now()
      return { ok: true, lastSeenAt }
    }

    async function vaultList() {
      const vaults = await detectVaults({
        searchRoots: settings.obsidian.searchRoots,
        maxDepth: settings.obsidian.maxDepth,
      })
      const attached = new Set(settings.markdownRoots.map((root) => normPath(root.path)))
      return {
        ok: true,
        vaults: (Array.isArray(vaults) ? vaults : []).map((vault) => ({ ...vault, attached: attached.has(normPath(vault.path)) })),
        searchRoots: settings.obsidian.searchRoots,
        autoDetect: settings.obsidian.autoDetect,
      }
    }

    async function attachVault(body) {
      const raw = typeof body?.path === 'string' ? body.path.trim() : ''
      if (raw === '') throw new Error('缺少 vault 路径')
      const abs = path.resolve(raw)
      let stat
      try {
        stat = await fsp.stat(abs)
      } catch (error) {
        throw new Error(`目录不可访问：${describeError(error)}`)
      }
      if (!stat.isDirectory()) throw new Error('路径不是文件夹')
      const exists = settings.markdownRoots.some((root) => normPath(root.path) === normPath(abs))
      if (!exists) {
        const id = `vault-${createHash('sha1').update(normPath(abs)).digest('hex').slice(0, 8)}`
        const label = typeof body?.label === 'string' && body.label.trim() !== '' ? body.label.trim().slice(0, 60) : path.basename(abs) || 'Obsidian'
        const roots = [...settings.markdownRoots, { id, label, path: abs }]
        settings = await saveSettings(dataDir, normalizeSettings({ ...settings, markdownRoots: roots }))
        invalidateBoards()
        log('vault attached:', abs)
      }
      const board = await getBoard(true)
      return { ok: true, roots: settings.markdownRoots, board }
    }

    async function updateSettings(body) {
      const next = applySettingsPatch(body)
      settings = await saveSettings(dataDir, next)
      invalidateBoards()
      await initV042()
      const board = await getBoard(true).catch((error) => failureBoard(describeError(error)))
      return { ok: true, settings: safeSettings(), board }
    }

    const handler = async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname
      try {
        if (!authorized(req, res)) return
        if (startupPromise !== null) {
          try {
            await startupPromise
          } catch {
            /* startup 自己会记录错误；这里只等它结束 */
          }
        }

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

        if (path === ACTION_API) {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const body = await readJsonBody(req)
          try {
            const result = await enqueueAction(() => performTodoAction(body))
            sendJson(res, 200, result)
          } catch (error) {
            sendJson(res, actionStatus(error), {
              ok: false,
              code: error instanceof EditError ? error.code : null,
              error: describeError(error),
            })
          }
          return
        }

        /* ------------------------- v0.4：阿源 / 自动发现 ------------------------- */

        if (path === YUAN_STATE_API) {
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          sendJson(res, 200, await yuanState())
          return
        }

        if (path === YUAN_SIGNALS_API) {
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          sendJson(res, 200, await yuanSignals())
          return
        }

        if (path === YUAN_CHAT_API) {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const body = await readJsonBody(req)
          try {
            sendJson(res, 200, await yuanChat(body))
          } catch (error) {
            sendJson(res, 400, { ok: false, error: describeError(error) })
          }
          return
        }

        if (path === YUAN_SUGGEST_ACCEPT_API || path === YUAN_SUGGEST_DISMISS_API) {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const body = await readJsonBody(req)
          try {
            const result = path === YUAN_SUGGEST_ACCEPT_API ? await acceptSuggestion(body) : await dismissSuggestion(body)
            sendJson(res, 200, result)
          } catch (error) {
            sendJson(res, 400, { ok: false, error: describeError(error) })
          }
          return
        }

        if (path === YUAN_REMEMBER_API) {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const body = await readJsonBody(req)
          try {
            sendJson(res, 200, await remember(body))
          } catch (error) {
            sendJson(res, 400, { ok: false, error: describeError(error) })
          }
          return
        }

        if (path === YUAN_MEMORY_DELETE_API) {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const body = await readJsonBody(req)
          try {
            sendJson(res, 200, await forgetMemory(body))
          } catch (error) {
            sendJson(res, 400, { ok: false, error: describeError(error) })
          }
          return
        }

        if (path === YUAN_MEMORY_ACCEPT_API) {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const body = await readJsonBody(req)
          try {
            sendJson(res, 200, await acceptMemory(body))
          } catch (error) {
            sendJson(res, 400, { ok: false, error: describeError(error) })
          }
          return
        }

        if (path === YUAN_REMINDER_API || path === YUAN_REMINDER_DONE_API) {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const body = await readJsonBody(req)
          try {
            const result = path === YUAN_REMINDER_API ? await addReminder(body) : await finishReminder(body)
            sendJson(res, 200, result)
          } catch (error) {
            sendJson(res, 400, { ok: false, error: describeError(error) })
          }
          return
        }

        if (path === YUAN_SEEN_API) {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          sendJson(res, 200, await markSeen())
          return
        }

        if (path === VAULTS_API) {
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          sendJson(res, 200, await vaultList())
          return
        }

        if (path === VAULT_ATTACH_API) {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const body = await readJsonBody(req)
          try {
            sendJson(res, 200, await attachVault(body))
          } catch (error) {
            sendJson(res, 400, { ok: false, error: describeError(error) })
          }
          return
        }

        if (path === SETTINGS_API) {
          if (req.method === 'GET') {
            sendJson(res, 200, { ok: true, settings: safeSettings(), dataDir, version: PLUGIN_VERSION })
            return
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const body = await readJsonBody(req)
          try {
            sendJson(res, 200, await updateSettings(body))
          } catch (error) {
            sendJson(res, 400, { ok: false, error: describeError(error) })
          }
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

    for (const routePath of API_ROUTES) {
      ctx.effect(
        () => http.webServer.register({ kind: 'exact', path: routePath, handler }),
        `leo-status: ${routePath}`,
      )
    }
    log('routes ready ·', API_ROUTES.join(', '))
  })
}

