import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMemoryCore } from '../memory-core.js'
import { prepareOrigin } from '../yuan-context.js'

test('automatic Chinese recall keeps evidence, excludes guesses, corrects and forgets across restart', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'leo-memory-'))
  let core
  t.after(async () => { await core?.close(); await rm(directory, { recursive: true, force: true }) })
  const text = '我平时都用中文交流，项目名字叫蓝色灯塔。以后解释代码时请先说明设计意图，再讲细节。'
  core = await createMemoryCore({ directory, extract: async () => [
    { kind: 'preference', text: '偏好先讲设计意图再讲代码细节', quote: '以后解释代码时请先说明设计意图，再讲细节。', explicit: true, confidence: .95 },
    { kind: 'project', text: '蓝色灯塔项目', quote: '项目名字叫蓝色灯塔', confidence: .8 },
    { kind: 'fact', text: '用户正在养一条金鱼', quote: '不存在的原文', confidence: 1, explicit: true },
  ] })
  await Promise.all([core.capture({ sessionId: 's', messageId: 'm', text }), core.capture({ sessionId: 's', messageId: 'm', text })])
  await core.flush()
  assert.equal(core.list().filter((r) => r.kind === 'episode').length, 1)
  assert.equal(core.list().length, 3)
  assert.equal(core.list().find((r) => r.kind === 'project').status, 'pending')
  assert.equal(core.search('蓝色灯塔').some((r) => r.status === 'pending'), false)
  assert.equal(core.search('无关的香蕉甜点').length, 0)
  const pref = core.list().find((r) => r.kind === 'preference')
  await core.change(pref.id, 'correct', '解释代码时先展示具体例子')
  assert.equal(core.search('设计意图').length, 0)
  assert.equal(core.search('具体例子')[0].id, pref.id)
  await core.change(pref.id, 'forget')
  await core.capture({ sessionId: 's', messageId: 'secret', text: 'password=super-private-secret' })
  assert.equal(core.list().some((r) => r.text.includes('super-private')), false)
  await core.close(); core = await createMemoryCore({ directory })
  await core.capture({ sessionId: 's', messageId: 'm', text })
  assert.equal(core.search('设计意图 具体例子').length, 0)
  assert.equal(core.detail(pref.id), null)
  assert.ok((await readFile(path.join(directory, 'events.jsonl'), 'utf8')).includes('"status":"deleted"'))
})

test('forget while extraction runs prevents delayed facts from resurrecting', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'leo-memory-job-'))
  let finish
  const core = await createMemoryCore({ directory, extract: () => new Promise((resolve) => { finish = resolve }) })
  t.after(async () => { await core.close(); await rm(directory, { recursive: true, force: true }) })
  const text = '我希望今后所有代码解释都采用中文，先展示运行结果再说明实现。'
  const r = await core.capture({ sessionId: 's', messageId: 'm', text })
  await new Promise((r) => setImmediate(r))
  await core.change(r.id, 'forget')
  finish([{ kind: 'preference', text: '中文代码解释', quote: '所有代码解释都采用中文', confidence: 1, explicit: true }])
  await core.flush()
  assert.equal(core.list().length, 0)
})

test('origin is bounded, sourced, skips tool/inherited noise and saves only one small durable image', async () => {
  let closed = false, saved = 0
  const snapshot = await prepareOrigin({ location: '会话', sessionId: 'session-source', selection: 'x'.repeat(3000), code: 'api_key=secret-value', image: 'data:image/png;base64,YWJj' }, {
    targetId: 'session-target', attachments: { async saveImage(input) { saved++; assert.equal(input.data.toString(), 'abc'); return { id: 'image-1', name: input.name, width: 1, height: 1 } } },
    persistence: { async list() { return [{ header: { id: 'session-source' }, eventCount: 150 }] }, async open() { return {
      inheritedEventCount: 80, async read(offset, length) { assert.equal(offset, 80); assert.equal(length, 120); return { events: [
        { type: 'tool/result', data: { text: 'irrelevant noise' } },
        { type: 'user/message', seq: 81, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '请解释这里' }] } },
        { type: 'assistant/message', seq: 82, data: { message: { content: [{ type: 'text', text: '相关答复' }] } } },
      ] } }, async close() { closed = true },
    } } },
  })
  assert.equal(snapshot.origin.selection.length, 1800)
  assert.equal(snapshot.origin.code.includes('secret-value'), false)
  assert.equal(snapshot.origin.recent.length, 2); assert.equal(closed, true); assert.equal(saved, 1)
  assert.equal(snapshot.blocks[1].type, 'image')
  assert.ok(snapshot.expiresAt > Date.now()); assert.ok(snapshot.expiresAt <= Date.now() + 600000)
  assert.ok(snapshot.blocks[0].text.length < 5000)
})
