/**
 * leo-status · 设备模式下的阿源记忆（远端适配器）
 *
 * 阿源在本机运行（会话、工具、文件都属于这台设备），但记忆只有一份，存在中心。
 * 这个适配器把 yuan-agent 需要的记忆接口（search / capture / status / detail / change）
 * 转发到中心的 /api/yuan/*，设备本地不建 memory-core，避免出现第二份记忆。
 *
 * 所有调用都带超时；读失败返回空结果（阿源仍能回答，只是没有召回），写失败记到
 * status.lastError，由 UI 显示「记忆暂不可用」。
 */
const DEFAULT_TIMEOUT_MS = 20_000

function trimBase(hubUrl) {
  const text = typeof hubUrl === 'string' ? hubUrl.trim().replace(/\/+$/, '') : ''
  if (text === '') throw new Error('中心地址为空')
  return text
}

export function createHubMemory({ hubUrl, password, log = () => {} }) {
  const base = trimBase(hubUrl)
  const status = { backend: 'hub', extracting: false, lastError: null, hub: base }

  async function call(route, body, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const headers = { accept: 'application/json', 'content-type': 'application/json' }
    if (password) headers.authorization = `Bearer ${password}`
    const response = await fetch(`${base}/api/yuan/${route}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    let data = null
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
    if (!response.ok || data === null || data.ok !== true) {
      throw new Error(data?.error || `中心返回 HTTP ${response.status}`)
    }
    return data
  }

  return {
    status,
    /** 召回相关记忆；与 memory-core 的返回形状一致（带来源的条目数组）。 */
    async search(query, { limit = 6 } = {}) {
      try {
        const data = await call('memory/query', { query })
        return (Array.isArray(data.items) ? data.items : []).slice(0, limit)
      } catch (error) {
        status.lastError = error.message
        log('hub memory search:', error.message)
        return []
      }
    },
    async detail(id) {
      try {
        const data = await call('memory/query', { id })
        return (Array.isArray(data.items) ? data.items : [])[0] ?? null
      } catch (error) {
        status.lastError = error.message
        return null
      }
    },
    async change(id, action, text) {
      const data = await call('memory/change', { id, action, text })
      return data.item ?? null
    },
    /** 阿源的自我状态（兴趣/情绪/偏好）写入中心那一份记忆。 */
    async note({ kind, text, source } = {}) {
      const data = await call('memory/note', { kind, text, source })
      return data.item ?? null
    },
    /** 最近的记忆条目（用于状态摘要）。 */
    async list({ limit = 40 } = {}) {
      try {
        const data = await call('memory/query', {})
        return (Array.isArray(data.items) ? data.items : []).slice(0, limit)
      } catch (error) {
        status.lastError = error.message
        log('hub memory list:', error.message)
        return []
      }
    },
    /** 把本机阿源对话的证据写进中心记忆（中心自己做提炼与去重）。 */
    async capture(record) {
      try {
        await call('memory/capture', record)
      } catch (error) {
        status.lastError = error.message
        log('hub memory capture:', error.message)
      }
    },
    async flush() {},
    async close() {},
  }
}
