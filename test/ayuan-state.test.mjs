import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionBrowser, buildAyuanStatus, describeAyuanStatus, createAyuanState } from '../ayuan-state.js'
import { createMemoryCore } from '../memory-core.js'

const fakeQuery = {
  async listSessions() {
    return [
      { header: { id: 's1', createdAt: 300, cwd: 'C:/work', isSeeded: false }, live: true, persisted: true },
      { header: { id: 's2', createdAt: 200, cwd: 'C:/other', isSeeded: false }, live: false, persisted: true },
      { header: { id: 'sub', createdAt: 400, cwd: 'C:/work', isSeeded: false, origin: 'subagent', delegationDepth: 1 }, live: true, persisted: true },
    ]
  },
  async readTitleSnapshots(ids) {
    return ids.map((id) => ({ sessionId: id, status: 'fulfilled', value: { session: { id }, title: { title: id === 's1' ? '修复设备中心' : '别的工作' } } }))
  },
  async readTitleSnapshot(id) {
    return { session: { id }, title: { title: '修复设备中心' } }
  },
  async filterEvents(id) {
    return [
      { sessionId: id, seq: 1, type: 'user/message', time: 1000, surface: 'current', text: '帮我看看设备中心' },
      { sessionId: id, seq: 2, type: 'assistant/message', time: 2000, surface: 'current', text: '好，先看日志' },
      { sessionId: id, seq: 3, type: 'tool/call', time: 2500, surface: 'current', text: '不应出现' },
    ]
  },
}

test('ayuan_sessions：只列主会话、带标题，read 只返回用户/助手消息', async () => {
  const browser = createSessionBrowser({ getQuery: () => fakeQuery })
  const list = await browser.list({ limit: 5 })
  assert.deepEqual(list.map((row) => row.id), ['s1', 's2'])
  assert.equal(list[0].title, '修复设备中心')
  assert.deepEqual(await browser.list({ filter: '设备' }).then((rows) => rows.map((row) => row.id)), ['s1'])
  const read = await browser.read('s1', { limit: 10, chars: 400 })
  assert.equal(read.messages.length, 2)
  assert.deepEqual(read.messages.map((m) => m.role), ['user', 'assistant'])
  assert.equal(read.messages[0].text, '帮我看看设备中心')
  assert.equal(read.truncated, false)
  const one = await browser.read('s1', { limit: 1 })
  assert.equal(one.messages.length, 1)
  assert.equal(one.truncated, true)
})

test('ayuan_sessions：会话服务不可用时明确报错', async () => {
  const browser = createSessionBrowser({ getQuery: () => null })
  await assert.rejects(() => browser.list(), /会话查询服务不可用/)
})

test('ayuan 状态：位置/情绪/兴趣/任务/会话摘要可渲染', () => {
  const status = buildAyuanStatus({
    location: { name: '公司', platform: 'win32', hostname: 'PC-1', mode: 'device', workspace: 'C:/work' },
    board: { todos: [{ text: '写周报', due: '2026-10-20', priority: 'high' }, { text: '已完成', done: true }] },
    suggestions: [{ id: 's' }],
    reminders: [{ id: 'r', done: false }],
    memory: [
      { id: 'n1', kind: 'mood', text: '今天状态平稳', at: '2026-10-28T01:00:00Z', status: 'active' },
      { id: 'n2', kind: 'interest', text: '设备中心与远程开发', at: '2026-10-28T02:00:00Z', status: 'active' },
      { id: 'n3', kind: 'interest', text: '旧兴趣', at: '2026-10-27T02:00:00Z', status: 'active' },
    ],
    sessions: [{ id: 's1', title: '修复设备中心' }],
  })
  assert.equal(status.mood, '今天状态平稳')
  assert.deepEqual(status.interests, ['设备中心与远程开发', '旧兴趣'])
  assert.equal(status.tasks.todos, 1)
  assert.equal(status.tasks.suggestions, 1)
  assert.equal(status.tasks.reminders, 1)
  const described = describeAyuanStatus(status)
  assert.match(described, /本次运行位置.*公司.*win32/)
  assert.match(described, /情绪：今天状态平稳/)
  assert.match(described, /兴趣：设备中心与远程开发 \/ 旧兴趣/)
  assert.match(described, /修复设备中心/)
})

test('createAyuanState：30 秒缓存，refresh 重新采集', async () => {
  let memoryReads = 0
  const memory = { status: { backend: 'hub' }, async list() { memoryReads += 1; return [] } }
  const state = createAyuanState({
    location: () => ({ name: 'leo', mode: 'hub' }),
    getBoard: () => ({ todos: [] }),
    getSuggestions: () => [],
    getReminders: () => [],
    memory,
    sessions: { list: async () => [] },
  })
  await state.status()
  await state.status()
  assert.equal(memoryReads, 1)
  await state.status({ refresh: true })
  assert.equal(memoryReads, 2)
})

test('memory-core.note：显式状态写入、去重、拒绝敏感内容', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'leo-ayuan-memory-'))
  const core = await createMemoryCore({ directory: dir, extract: null })
  try {
    const first = await core.note({ kind: 'interest', text: '喜欢先看结论' })
    const again = await core.note({ kind: 'interest', text: '喜欢先看结论' })
    assert.equal(first.id, again.id)
    assert.equal(core.list().length, 1)
    assert.equal((await core.note({ kind: 'mood', text: '平稳' })).kind, 'mood')
    await assert.rejects(() => core.note({ kind: 'mood', text: '密码：abc123' }), /不能保存/)
    await assert.rejects(() => core.note({ kind: 'unknown', text: 'x' }), /未知状态类型/)
  } finally {
    await core.close()
    await rm(dir, { recursive: true, force: true })
  }
})
