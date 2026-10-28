/** Local, replaceable memory: append-only evidence log + rebuildable Chinese FTS index. */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 24)
const compact = (s, n = 2000) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)
export function memoryTerms(value) {
  const words = [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(String(value).toLowerCase())]
    .filter((s) => s.isWordLike).map((s) => s.segment)
  const pairs = (String(value).match(/[\u3400-\u9fff]{2,}/g) || []).flatMap((s) => Array.from({ length: s.length - 1 }, (_, i) => s.slice(i, i + 2)))
  return [...new Set([...words, ...pairs].filter((s) => s.length > 1))].slice(0, 150)
}
export function sensitive(value) {
  return /(?:password|passwd|api[_ -]?key|access[_ -]?token|密码|密钥|口令)\s*[:：=]\s*\S+|\bsk-[a-z0-9_-]{12,}|-----BEGIN .*PRIVATE KEY/i.test(value)
}
export async function createMemoryCore({ directory, extract, log = () => {} }) {
  await fs.mkdir(directory, { recursive: true })
  const logFile = path.join(directory, 'events.jsonl'), records = new Map()
  let tail = Promise.resolve(), jobs = Promise.resolve(), db, closed = false
  const capturing = new Set()
  const status = { backend: 'jsonl', extracting: false, lastError: null }
  try {
    for (const line of (await fs.readFile(logFile, 'utf8')).split('\n')) {
      try { const item = JSON.parse(line); if (item.id) records.set(item.id, item) } catch {}
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e }
  try {
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(path.join(directory, 'index.sqlite'))
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS recall USING fts5(id UNINDEXED, terms); DELETE FROM recall;')
    for (const item of records.values()) index(item)
    status.backend = 'sqlite-fts5'
  } catch (e) { db?.close(); db = null; status.lastError = `FTS降级：${e.message}` }
  function index(item) {
    if (!db) return
    db.prepare('DELETE FROM recall WHERE id = ?').run(item.id)
    if (!['deleted', 'superseded', 'pending'].includes(item.status)) db.prepare('INSERT INTO recall(id, terms) VALUES (?, ?)').run(item.id, memoryTerms(item.text).join(' '))
  }
  function put(item) {
    const run = tail.then(async () => {
      if (closed) throw new Error('记忆存储已关闭')
      await fs.appendFile(logFile, JSON.stringify(item) + '\n', 'utf8')
      records.set(item.id, item); index(item)
      return item
    })
    tail = run.catch((e) => { status.lastError = e.message }); return run
  }
  function list() { return [...records.values()].filter((r) => !['deleted', 'superseded', 'job'].includes(r.status)).sort((a, b) => b.at.localeCompare(a.at)) }
  async function capture({ sessionId, messageId, seq, text, at, backfill = false }) {
    text = compact(text, 4000)
    if (!text || sensitive(text) || /只读联通验证|验收探针/.test(text)) return
    const id = 'episode:' + hash(sessionId + ':' + messageId)
    if (records.has(id) || capturing.has(id)) return
    capturing.add(id)
    const record = { id, kind: 'episode', status: 'observed', text, at: at && Number.isFinite(new Date(at).getTime()) ? new Date(at).toISOString() : new Date().toISOString(),
      source: { sessionId, messageId, seq, quote: text }, confidence: 1 }
    try { await put(record) } finally { capturing.delete(id) }
    // Raw evidence is searchable immediately. Model distillation is asynchronous, once per new message.
    if (extract && !backfill && text.length >= 24) {
      jobs = jobs.then(async () => {
        if (closed) return
        status.extracting = true
        try {
          const facts = await extract(text)
          for (const fact of (Array.isArray(facts) ? facts : []).slice(0, 4)) {
            if (records.get(id)?.status !== 'observed') break
            const quote = compact(fact.quote), value = compact(fact.text, 500)
            if (!quote || !text.includes(quote) || !value || sensitive(value)) continue
            if (!['preference', 'fact', 'project', 'decision'].includes(fact.kind)) continue
            const key = 'fact:' + hash(value.toLowerCase())
            if (records.has(key)) continue // includes tombstones: a deleted memory never resurrects.
            const trusted = ['preference', 'fact'].includes(fact.kind) && Number(fact.confidence) >= 0.9 && fact.explicit === true
            await put({ id: key, kind: fact.kind, status: trusted ? 'active' : 'pending', text: value,
              at: record.at, source: { ...record.source, quote }, confidence: Math.min(1, Number(fact.confidence) || 0),
              expiresAt: ['project', 'decision'].includes(fact.kind) ? new Date(Date.now() + 30 * 86400000).toISOString() : null })
          }
          status.lastError = null
        } catch (e) { status.lastError = e.message; log('memory extraction:', e.message) }
        finally { status.extracting = false }
      })
    }
    return record
  }
  function search(query, { limit = 6, budget = 1600, excludeMessageId } = {}) {
    const terms = memoryTerms(query).slice(0, 35)
    if (!terms.length) return []
    let ranked
    if (db) ranked = db.prepare('SELECT id FROM recall WHERE recall MATCH ? ORDER BY bm25(recall) LIMIT 40').all(terms.map((s) => '"' + s.replaceAll('"', '""') + '"').join(' OR ')).map((r) => records.get(r.id))
    else ranked = [...records.values()].map((item) => ({ item, score: terms.filter((s) => item.text?.toLowerCase().includes(s)).length })).filter((r) => r.score > 0).sort((a,b) => b.score-a.score).map((r) => r.item)
    let used = 0; const result = []
    for (const r of ranked) {
      if (!r || !['active', 'observed'].includes(r.status) || (excludeMessageId && r.source?.messageId === excludeMessageId) || (r.expiresAt && r.expiresAt < new Date().toISOString())) continue
      const excerpt = r.text.slice(0, Math.min(400, budget - used))
      if (!excerpt.length) break
      result.push({ ...r, text: excerpt }); used += excerpt.length
      if (result.length >= limit || used >= budget) break
    }
    return result
  }
  async function change(id, action, text) {
    const item = records.get(id); if (!item) throw new Error('记忆不存在')
    if (!['accept','forget','correct'].includes(action)) throw new Error('未知记忆操作')
    if (action === 'correct' && !compact(text)) throw new Error('修正内容不能为空')
    if (action === 'correct' && sensitive(text)) throw new Error('记忆中不能保存凭据')
    // Do not recall the original evidence as an alternative after a correction/forget.
    if (action !== 'accept' && item.source?.messageId) {
      for (const related of records.values()) if (related.id !== id && related.source?.messageId === item.source.messageId &&
        related.source?.sessionId === item.source.sessionId && (item.kind === 'episode' || related.kind === 'episode')) {
        await put({ ...related, status: 'superseded', updatedAt: new Date().toISOString() })
      }
    }
    return put({ ...item, status: action === 'forget' ? 'deleted' : 'active',
      ...(action === 'correct' ? { text: compact(text, 500), previousText: item.text, correctedBy: 'user' } : {}), updatedAt: new Date().toISOString() })
  }
  async function importLegacy(items) {
    for (const item of items || []) {
      const id = 'legacy:' + item.id
      if (records.has(id) || !item.text || sensitive(item.text)) continue
      await put({ ...item, id, kind: 'fact', status: item.status === 'pending' ? 'pending' : 'active', source: { legacyId: item.id, quote: item.text }, at: item.at || new Date().toISOString() })
    }
  }
  return { capture, search, list, change, importLegacy, status,
    detail(id) { const item = records.get(id); return item && !['deleted', 'superseded'].includes(item.status) ? item : null },
    async flush() { await jobs; await tail },
    async close() { await jobs; await tail; closed = true; db?.close() },
  }
}
