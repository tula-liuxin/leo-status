import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createYuanStore,
  createYuanService,
  buildSignals,
  buildYuanPrompt,
  parseYuanMarkers,
} from '../yuan.js'

async function tempDir(prefix = 'leo-yuan-') {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix))
}

function boardFixture(extra = {}) {
  return {
    ok: true,
    todos: [
      { id: 'local:md:1', text: '写 README', done: false, cancelled: false, due: null, sourceLabel: '笔记' },
      { id: 'local:md:2', text: '已完成', done: true, cancelled: false, due: null },
    ],
    devices: [{ id: 'local', name: '本机' }],
    ...extra,
  }
}

test('chat jsonl：追加并按顺序加载尾部', async () => {
  const dir = await tempDir()
  const store = createYuanStore(dir)
  await store.appendChat({ role: 'user', text: '你好' })
  await store.appendChat({ role: 'assistant', text: '在的' })
  const chat = await store.loadChat(10)
  assert.equal(chat.length, 2)
  assert.equal(chat[0].role, 'user')
  assert.equal(chat[1].text, '在的')
  assert.ok(chat[0].id.startsWith('chat_'))
})

test('memory：去重、pending 不进 prompt、forget 删除', async () => {
  const dir = await tempDir()
  const store = createYuanStore(dir)
  const first = await store.appendMemory({ text: '我喜欢简洁的 UI', source: 'manual' })
  const again = await store.appendMemory({ text: ' 我喜欢简洁的 UI ', source: 'manual' })
  assert.equal(first.id, again.id)

  const pending = await store.appendMemory({ text: '模型猜的偏好', source: 'chat', pending: true })
  const all = await store.loadMemory(10)
  assert.equal(all.length, 2)
  const active = all.filter((item) => item.status !== 'pending')
  assert.equal(active.length, 1)

  const prompt = buildYuanPrompt({ memory: all })
  assert.ok(prompt.system.includes('我喜欢简洁的 UI'))
  assert.ok(!prompt.system.includes('模型猜的偏好'))

  assert.equal(await store.forgetMemory(first.id), true)
  const left = await store.loadMemory(10)
  assert.equal(left.length, 1)
  assert.equal(left[0].id, pending.id)
})

test('signals：建议 / 提醒 / 截止 / 未读', () => {
  const now = Date.parse('2026-10-27T10:00:00+08:00')
  const { signals, badge } = buildSignals({
    board: boardFixture({
      todos: [
        { id: 'a', text: '明天交报告', done: false, cancelled: false, due: '2026-10-28' },
        { id: 'b', text: '远期任务', done: false, cancelled: false, due: '2026-12-01' },
      ],
    }),
    suggestions: [
      { id: 's1', text: '建议一', status: 'pending', bucket: 'accept' },
      { id: 's2', text: '低置信', status: 'pending', bucket: 'review' },
      { id: 's3', text: '已忽略', status: 'dismissed', bucket: 'accept' },
    ],
    reminders: [
      { id: 'r1', text: '喝水', at: '2026-10-27T09:00:00+08:00', done: false },
      { id: 'r2', text: '已做', at: '2026-10-27T09:00:00+08:00', done: true },
    ],
    chat: [{ role: 'assistant', text: '我在', at: '2026-10-27T10:05:00+08:00' }],
    lastSeenAt: Date.parse('2026-10-27T08:00:00+08:00'),
    now,
  })
  const kinds = signals.map((item) => item.kind)
  assert.ok(kinds.includes('suggestion'))
  assert.ok(kinds.includes('reminder'))
  assert.ok(kinds.includes('deadline'))
  assert.ok(kinds.includes('unread'))
  assert.equal(badge.kinds.suggestion, 2)
  assert.equal(badge.kinds.reminder, 1)
  assert.equal(badge.kinds.deadline, 1)
  assert.equal(badge.hasUnread, true)
  assert.ok(badge.total >= 3)
  assert.ok(signals[0].severity === 'urgent')
})

test('buildYuanPrompt：包含看板/建议/提醒/记忆与历史', () => {
  const prompt = buildYuanPrompt({
    board: boardFixture(),
    suggestions: [{ id: 's1', text: '整理周报', status: 'pending', bucket: 'accept', sessionTitle: '会话A' }],
    memory: [{ id: 'm1', text: 'Leo 喜欢中文', status: 'active' }],
    reminders: [{ id: 'r1', text: '交报告', at: '2026-10-28T09:00:00+08:00', done: false }],
    chat: [
      { role: 'user', text: '早' },
      { role: 'assistant', text: '早，今天有 2 条到期' },
    ],
    now: new Date('2026-10-27T10:00:00+08:00'),
    message: '今天做什么',
  })
  assert.ok(prompt.system.includes('阿源'))
  assert.ok(prompt.system.includes('整理周报'))
  assert.ok(prompt.system.includes('Leo 喜欢中文'))
  assert.ok(prompt.system.includes('交报告'))
  assert.ok(prompt.system.includes('未完成'))
  assert.ok(prompt.system.includes('<<TODO'))
  // assistant 历史没有 durable id/source，不能进 messages；只发本次 user。
  assert.ok(prompt.system.includes('最近对话'))
  assert.ok(prompt.system.includes('Leo：早'))
  assert.ok(prompt.system.includes('阿源：早，今天有 2 条到期'))
  assert.equal(prompt.messages.length, 1)
  assert.equal(prompt.messages[0].role, 'user')
  assert.equal(prompt.messages[0].content[0].text, '今天做什么')
})

test('parseYuanMarkers：TODO/MEMORY/REMINDER 提取与正文清理', () => {
  const parsed = parseYuanMarkers('先做这个。<<TODO 给 README 补截图>> 还有 <<MEMORY Leo 习惯用 Windows>> <<REMINDER 交报告 | 2026-10-28T09:00:00+08:00>> 完了')
  assert.equal(parsed.text, '先做这个。 还有 完了')
  assert.deepEqual(parsed.todos, ['给 README 补截图'])
  assert.deepEqual(parsed.memories, ['Leo 习惯用 Windows'])
  assert.equal(parsed.reminders.length, 1)
  assert.equal(parsed.reminders[0].text, '交报告')
  assert.equal(new Date(parsed.reminders[0].at).getTime(), Date.parse('2026-10-28T09:00:00+08:00'))
})

test('agentChat：优先走真实 agent，工具卡随消息持久化', async () => {
  const dir = await tempDir()
  const calls = []
  const service = createYuanService({
    dataDir: dir,
    llm: null,
    agentChat: async (text, context) => {
      calls.push({ text, hasContext: typeof context?.contextText === 'string' && context.contextText.includes('看板') })
      return {
        reply: '我看了 安排.md，今天先做这三件。<<TODO 给周报补数据>>',
        tools: [{ kind: 'tool', id: 'call-1', name: 'read_file', arguments: '{"path":"安排.md"}', result: '- [ ] 给周报补数据' }],
      }
    },
    config: { yuan: { name: '阿源' } },
  })
  const result = await service.chat('看一下安排', { board: boardFixture(), suggestions: [] })
  assert.equal(result.usedAgent, true)
  assert.equal(result.tools.length, 1)
  assert.ok(result.reply.includes('安排.md'))
  assert.equal(result.proposals.length, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].text, '看一下安排')
  assert.equal(calls[0].hasContext, true)
  const chat = await service.store.loadChat(10)
  const assistant = chat[chat.length - 1]
  assert.equal(assistant.tools.length, 1)
  assert.equal(assistant.tools[0].name, 'read_file')
  assert.equal(assistant.tools[0].result, '- [ ] 给周报补数据')
  assert.deepEqual(assistant.proposals, ['给周报补数据'])
})

test('agentChat 抛错时退回直接模型/fallback，不挂', async () => {
  const dir = await tempDir()
  const service = createYuanService({
    dataDir: dir,
    llm: null,
    agentChat: async () => {
      throw new Error('agent unavailable')
    },
    config: { yuan: { name: '阿源' } },
  })
  const result = await service.chat('今天做什么', { board: boardFixture(), suggestions: [] })
  // 0.7 起：Agent 明确失败时直接反馈，不再用无工具回复冒充阿源。
  assert.equal(result.usedAgent, false)
  assert.ok(result.reply.includes('未能执行'))
  assert.equal(result.tools.length, 0)
})

test('chat：无 LLM 时走 fallback，仍持久化并返回建议', async () => {
  const dir = await tempDir()
  const service = createYuanService({
    dataDir: dir,
    llm: null,
    config: { yuan: { name: '阿源', maxHistory: 10, maxMemory: 10 } },
  })
  const board = boardFixture()
  const suggestions = [{ id: 's1', text: '整理周报', status: 'pending', bucket: 'accept' }]
  const result = await service.chat('今天做什么', { board, suggestions })
  assert.equal(typeof result.reply, 'string')
  assert.ok(result.reply.includes('看板'))
  assert.ok(result.reply.includes('整理周报'))
  assert.equal(result.proposals.length, 0)
  const chat = await service.store.loadChat(10)
  assert.equal(chat.length, 2)
  assert.equal(chat[1].role, 'assistant')
})

test('chat：记住命令直接写 active 记忆', async () => {
  const dir = await tempDir()
  const service = createYuanService({ dataDir: dir, llm: null, config: { yuan: { name: '阿源' } } })
  const result = await service.chat('记住：阿源回复要简短', { board: boardFixture() })
  assert.ok(result.reply.includes('记住了'))
  const memory = await service.store.loadMemory(10)
  assert.equal(memory.length, 1)
  assert.equal(memory[0].status, 'active')
})

test('提醒：新增、到期进信号、完成移除', async () => {
  const dir = await tempDir()
  const service = createYuanService({ dataDir: dir, llm: null })
  const now = Date.now()
  const reminder = await service.addReminder('喝水', new Date(now + 3600_000).toISOString())
  assert.ok(reminder.id.startsWith('rem_'))
  const payload = await service.statePayload({ board: boardFixture(), suggestions: [] })
  assert.ok(payload.reminders.length === 1)
  assert.ok(payload.signals.some((item) => item.kind === 'reminder'))
  await service.doneReminder(reminder.id)
  const after = await service.statePayload({ board: boardFixture(), suggestions: [] })
  assert.equal(after.reminders.length, 1)
  assert.equal(after.reminders[0].done, true)
})

test('markSeen：未读信号消失', async () => {
  const dir = await tempDir()
  const service = createYuanService({ dataDir: dir, llm: null })
  await service.store.appendChat({ role: 'assistant', text: '新回复', at: new Date().toISOString() })
  const before = await service.statePayload({ board: boardFixture(), suggestions: [] })
  assert.equal(before.badge.hasUnread, true)
  await service.markSeen()
  const after = await service.statePayload({ board: boardFixture(), suggestions: [] })
  assert.equal(after.badge.hasUnread, false)
})
