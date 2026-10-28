/**
 * leo-status · 设备侧同步客户端（纯 Node，global fetch）
 *
 * 三个动作对应 Hub HTTP API：
 *   joinHub()        POST {hubUrl}/api/join
 *   pushSnapshot()   POST {hubUrl}/api/push
 *   fetchBoard()     GET  {hubUrl}/api/board
 *
 * 认证：Authorization: Bearer <password>。
 * 失败一律抛 Error('...')，由调用方决定降级；所有请求带超时。
 */

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_SNAPSHOT_TODOS = 20_000
const TODO_WHITELIST = [
  'id',
  'kind',
  'text',
  'raw',
  'editText',
  'editRaw',
  'done',
  'cancelled',
  'sourceId',
  'sourceLabel',
  'file',
  'relPath',
  'line',
  'heading',
  'indent',
  'parentId',
  'noteDate',
  'due',
  'scheduled',
  'start',
  'priority',
  'tags',
  'links',
  'recurrence',
  'sessionId',
  'sessionTitle',
  'project',
  'discoveredBy',
  'writable',
  'confidence',
  'headingStatus',
  'evidence',
  'obsidianVault',
]

function trimBase(baseUrl) {
  const text = typeof baseUrl === 'string' ? baseUrl.trim() : ''
  if (text === '') throw new Error('中心地址为空')
  return text.replace(/\/+$/, '')
}

function timeoutSignal(timeoutMs) {
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  timer.unref?.()
  return controller.signal
}

async function request(baseUrl, path, { method = 'GET', password, body, timeoutMs } = {}) {
  const url = `${trimBase(baseUrl)}${path}`
  const headers = { accept: 'application/json' }
  if (password) headers.authorization = `Bearer ${password}`
  let payload
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const response = await fetch(url, { method, headers, body: payload, signal: timeoutSignal(timeoutMs) })
  const text = await response.text()
  let data = null
  if (text !== '') {
    try {
      data = JSON.parse(text)
    } catch {
      data = { raw: text.slice(0, 500) }
    }
  }
  if (!response.ok) {
    const message =
      data && typeof data.error === 'string' && data.error !== ''
        ? data.error
        : `中心返回 HTTP ${response.status}`
    const error = new Error(message)
    error.status = response.status
    error.data = data
    throw error
  }
  return data
}

/** 本机标识（平台名，供中心展示）。 */
export function platformId() {
  return process.platform
}

/** 校验中心地址（只接受 http/https，去掉尾部斜杠）。 */
export function normalizeHubUrl(hubUrl) {
  const text = typeof hubUrl === 'string' ? hubUrl.trim().replace(/\/+$/, '') : ''
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw new Error('中心地址不是合法 URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('中心地址必须是 http/https')
  return text
}

/** Devices use one central inbox/chat/memory; network failures never create a second copy. */
export async function requestHubYuan({ hubUrl, password, route, body }) {
  const reads = new Set(['state', 'signals', 'activity'])
  const data = await request(hubUrl, `/api/yuan/${route}`, {
    password, method: reads.has(route) ? 'GET' : 'POST', body: reads.has(route) ? undefined : body,
    timeoutMs: route === 'chat' ? 240000 : 20000,
  })
  if (data?.ok !== true) throw new Error(data?.error || '中心阿源暂不可用')
  return data
}

/** 设备模式的看板写操作走中心：propose / action / suggestion accept|dismiss。 */
export async function requestHubBoard({ hubUrl, password, route, body }) {
  const data = await request(hubUrl, `/api/board/${route}`, {
    password, method: 'POST', body, timeoutMs: 20000,
  })
  if (data?.ok !== true) throw new Error(data?.error || '中心看板暂不可用')
  return data
}

/** 把本地快照裁成可上报的白名单形状。 */
export function slimSnapshot(snapshot) {
  const todos = Array.isArray(snapshot?.todos) ? snapshot.todos.slice(0, MAX_SNAPSHOT_TODOS) : []
  return {
    generatedAt: typeof snapshot?.generatedAt === 'string' ? snapshot.generatedAt : new Date().toISOString(),
    stats: snapshot?.stats && typeof snapshot.stats === 'object' ? snapshot.stats : {},
    sources: Array.isArray(snapshot?.sources)
      ? snapshot.sources.map((source) => ({
          id: source?.id ?? '',
          kind: source?.kind ?? '',
          label: source?.label ?? '',
          path: source?.path ?? '',
          files: Number(source?.files ?? 0),
          count: Number(source?.count ?? 0),
          open: Number(source?.open ?? 0),
          done: Number(source?.done ?? 0),
          error: typeof source?.error === 'string' ? source.error : null,
        }))
      : [],
    todos: todos.map((todo) => {
      const out = {}
      for (const key of TODO_WHITELIST) out[key] = todo?.[key] ?? null
      out.tags = Array.isArray(todo?.tags) ? todo.tags.filter((tag) => typeof tag === 'string') : []
      out.links = Array.isArray(todo?.links) ? todo.links.filter((link) => typeof link === 'string') : []
      return out
    }),
  }
}

export async function joinHub({ hubUrl, password, deviceId, name, platform, pluginVersion, timeoutMs }) {
  const data = await request(hubUrl, '/api/join', {
    method: 'POST',
    password,
    timeoutMs,
    body: { deviceId: deviceId || undefined, name, platform, pluginVersion },
  })
  if (!data || data.ok !== true || typeof data.deviceId !== 'string' || data.deviceId === '') {
    throw new Error('中心 join 返回异常')
  }
  return data
}

export async function pushSnapshot({ hubUrl, password, deviceId, name, platform, pluginVersion, snapshot, timeoutMs }) {
  const data = await request(hubUrl, '/api/push', {
    method: 'POST',
    password,
    timeoutMs,
    body: {
      deviceId,
      name,
      platform,
      pluginVersion,
      snapshot: slimSnapshot(snapshot),
    },
  })
  if (!data || data.ok !== true) throw new Error('中心 push 返回异常')
  return data
}

export async function fetchBoard({ hubUrl, password, timeoutMs }) {
  const data = await request(hubUrl, '/api/board', { method: 'GET', password, timeoutMs })
  if (!data || data.ok !== true) throw new Error('中心 board 返回异常')
  return data
}
