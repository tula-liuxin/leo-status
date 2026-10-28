/** Discovery is evidence, never consent. No model calls or source-file writes. */
import { createHash } from 'node:crypto'

const text = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
const digest = (value) => createHash('sha256').update(value).digest('hex').slice(0, 24)

export function intakeId(todo) {
  // A line moving in a note must not resurrect a dismissed/accepted task.
  const source = todo.kind === 'markdown' ? todo.file || todo.relPath : todo.sessionId
  return `sug:${digest(JSON.stringify([todo.deviceId || 'local', todo.kind, source, todo.heading || '', text(todo.text)]))}`
}

export function discoverIntake(todos, now = new Date().toISOString()) {
  const items = new Map()
  for (const todo of todos || []) {
    if (!todo || todo.done || todo.cancelled || !text(todo.text)) continue
    const note = todo.kind === 'markdown'
    // Agent execution plans, including old-device snapshots, are never user commitments.
    if (!note && !(todo.kind === 'dsh' && todo.evidence?.kind === 'user-message' && todo.evidence?.sourceKind === 'user')) continue
    const id = intakeId(todo)
    items.set(id, {
      id, text: text(todo.text), normalized: text(todo.text), source: note ? 'note' : 'session',
      sessionId: todo.sessionId || null, sessionTitle: todo.sessionTitle || null,
      project: todo.project || null, kind: note ? 'note' : 'commitment', bucket: 'accept',
      score: note ? 1 : 0.85, status: 'pending', createdAt: now,
      reasons: note ? ['笔记中的显式任务', '等待你确认'] : ['用户消息中的个人承诺', '等待你确认'],
      origin: { deviceId: todo.deviceId || 'local', deviceName: todo.deviceName || '',
        sourceId: todo.sourceId || null, sourceLabel: todo.sourceLabel || null,
        file: todo.file || null, relPath: todo.relPath || null, line: todo.line || null,
        heading: todo.heading || null, discoveredBy: todo.discoveredBy || null,
        evidence: todo.evidence || null },
      due: todo.due || null, scheduled: todo.scheduled || null, priority: todo.priority || 'none',
      tags: todo.tags || [], links: todo.links || [],
    })
  }
  return [...items.values()]
}

/** Only first-party user message text; quotes, code and hypothetical examples are excluded. */
export function personalCommitments(message) {
  const clean = String(message || '').replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '')
  return clean.split(/[\n。！？!?]/).map((line) => line.trim()).filter((line) => {
    if (!line || /^[>「“"']/u.test(line) || /例如|比如|假设|举例|如果|不需要|不用提醒|不要提醒|已完成|已经完成/.test(line)) return false
    if (/你(?:来|去|帮)|帮我|请你|让(?:你|AI|ai|agent|子智能体)/.test(line)) return false
    return /我(?:自己|亲自|来负责|来处理|来做|会在|打算|计划)|提醒我|别让我忘了|\bI (?:will|plan to|need to personally)\b|\bremind me to\b/i.test(line) && line.length >= 6
  }).map((line) => line.slice(0, 600)).slice(0, 6)
}

/** Bounded incremental reads through the installed DSH persistence API. */
export function createSessionIntake({ getPersistence, log = () => {}, limit = 40, batchSize = 300 } = {}) {
  const cursors = new Map()
  let identity = null
  let running = null
  let lastAt = 0
  let cached = []
  let status = { available: false, sessions: 0, error: null }
  async function refresh() {
    if (running) return running
    if (Date.now() - lastAt < 15000) return cached
    running = (async () => {
      const persistence = getPersistence?.()
      if (!persistence?.list || !persistence?.open) {
        status = { available: false, sessions: 0, error: 'DSH 会话存储尚不可用；不会使用 Agent 工作清单替代' }
        return cached
      }
      if (identity !== persistence.identity) { cursors.clear(); identity = persistence.identity }
      const sessions = (await persistence.list()).filter((s) => !(s.header.delegationDepth > 0) && s.header.origin !== 'subagent')
        .sort((a, b) => b.header.createdAt - a.header.createdAt).slice(0, limit)
      const active = new Set(sessions.map((s) => s.header.id))
      for (const id of cursors.keys()) if (!active.has(id)) cursors.delete(id)
      let scanned = 0
      for (const snapshot of sessions) {
        const id = snapshot.header.id
        let state = cursors.get(id)
        if (state && state.revision === snapshot.revision && state.complete) continue
        const handle = await persistence.open(id, 'read')
        try {
          if (!state) {
            // First discovery reads a bounded recent tail, never the entire archive.
            state = { offset: Math.max(handle.inheritedEventCount || 0, (snapshot.eventCount || 0) - 1500), items: [], title: null }
          }
          const { events } = await handle.read(state.offset, batchSize)
          for (const event of events) {
            if (event.type === 'session/title' && typeof event.data?.title === 'string') state.title = event.data.title
            if (event.type !== 'user/message' || event.data?.source?.kind !== 'user') continue
            const content = (event.data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
            for (const commitment of personalCommitments(content)) {
              state.items.push({ id: `user:${id}:${event.seq}:${digest(commitment)}`, kind: 'dsh', text: commitment,
                sessionId: id, sessionTitle: state.title, project: snapshot.header.cwd || null,
                done: false, cancelled: false, discoveredBy: 'user-message', writable: false,
                evidence: { kind: 'user-message', sourceKind: 'user', seq: event.seq, quote: commitment } })
            }
          }
          state.items = [...new Map(state.items.map((item) => [item.id, item])).values()].slice(-100)
          state.offset = events.length ? events[events.length - 1].seq + 1 : state.offset
          state.revision = snapshot.revision
          state.complete = events.length < batchSize || (snapshot.eventCount !== undefined && state.offset >= snapshot.eventCount)
          cursors.set(id, state)
          scanned++
        } finally { await handle.close() }
      }
      cached = [...cursors.values()].flatMap((state) => state.items)
      status = { available: true, sessions: sessions.length, scanned, candidates: cached.length, error: null }
      lastAt = Date.now()
      return cached
    })().catch((error) => {
      status = { ...status, error: String(error.message || error) }; log('session intake:', status.error)
      return cached
    }).finally(() => { running = null })
    return running
  }
  return { refresh, get status() { return status } }
}
