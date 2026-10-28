import test from 'node:test'
import assert from 'node:assert/strict'
import { discoverIntake, intakeId, personalCommitments, createSessionIntake } from '../intake.js'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

test('discovery keeps explicit note evidence and excludes agent plans/closed tasks', () => {
  const note = { kind: 'markdown', text: '提交论文', file: 'notes/a.md', line: 2, deviceId: 'one', due: '2026-10-30' }
  const items = discoverIntake([note, { kind: 'dsh', text: '修复 leo-status，提交发布', sessionTitle: '我的主会话' }, { ...note, done: true }])
  assert.equal(items.length, 1)
  assert.equal(items[0].status, 'pending')
  assert.equal(items[0].due, note.due)
  assert.equal(items[0].origin.file, note.file)
  assert.equal(intakeId(note), intakeId({ ...note, line: 99 }))
  assert.notEqual(intakeId(note), intakeId({ ...note, deviceId: 'two' }))
})

test('user commitments exclude requests delegated to AI, examples and quotes', () => {
  assert.deepEqual(personalCommitments('我来负责明天的线下验收。提醒我周五交报告。'), ['我来负责明天的线下验收', '提醒我周五交报告'])
  for (const noise of ['帮我实现插件', '我需要你来修复问题', '例如提醒我买菜', '> 我来负责部署', '如果我计划部署怎么办', '不要提醒我买菜', '```\n提醒我交报告\n```']) assert.deepEqual(personalCommitments(noise), [], noise)
})

test('session intake uses real human messages, skips subagents and inherited history, closes read handles', async () => {
  const events = [
    { seq: 0, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '提醒我继承任务' }] } },
    { seq: 1, type: 'user/message', data: { source: { kind: 'agent-message' }, content: [{ type: 'text', text: '提醒我运行测试' }] } },
    { seq: 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我来负责明天的线下验收' }] } },
    { seq: 3, type: 'assistant/message', data: { content: [{ type: 'text', text: '提醒我提交代码' }] } },
  ]
  let opened = 0, closed = 0
  const persistence = { identity: Symbol(), async list() { return [
    { header: { id: 'main', createdAt: 1 }, revision: 'one', eventCount: 4 },
    { header: { id: 'sub', createdAt: 2, origin: 'subagent' }, revision: 'one', eventCount: 4 },
    { header: { id: 'deep', createdAt: 3, delegationDepth: 1 }, revision: 'one', eventCount: 4 },
  ] }, async open(id, access) {
    assert.equal(id, 'main'); assert.equal(access, 'read'); opened++
    return { inheritedEventCount: 1, async read(offset, length) { return { events: events.slice(offset, offset + length) } }, async close() { closed++ } }
  } }
  const intake = createSessionIntake({ getPersistence: () => persistence })
  const items = await intake.refresh()
  assert.equal(items.length, 1)
  assert.equal(items[0].evidence.seq, 2)
  assert.equal(discoverIntake(items).length, 1)
  await intake.refresh()
  assert.equal(opened, 1); assert.equal(closed, 1)
})
