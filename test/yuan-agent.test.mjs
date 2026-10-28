import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createYuanAgentRuntime } from '../yuan-agent.js'

test('reused agent receives current context, live text/tool progress and user cancellation', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'leo-agent-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(path.join(dir, 'yuan'))
  await writeFile(path.join(dir, 'yuan', 'agent.json'), JSON.stringify({ sessionId: 'existing' }))
  const listeners = new Map(), prompts = new Map(), events = []
  let settle, cancelCause, permission, approval, disposed = 0
  const on = (name, fn) => { listeners.set(name, fn); return () => { disposed++; listeners.delete(name) } }
  const agent = { id: 'existing', status: 'idle', session: { id: 'existing', seq: 0, ownEvents: () => events },
    ctx: { on, systemPrompt: {
      section(spec) { prompts.set(spec.name, spec); return () => prompts.delete(spec.name) },
      context(spec) { prompts.set(spec.name, spec); return () => prompts.delete(spec.name) },
    } },
    send() { agent.status = 'running' }, whenIdle() { return new Promise((resolve) => { settle = resolve }) },
    cancel(cause) { cancelCause = cause; agent.status = 'idle'; settle() },
  }
  const services = { agents: { get: () => agent, create() { throw new Error('must not create') } },
    permissionPresets: { set(_session, value) { permission = value } }, approval: { setPolicy(_agent, value) { approval = value } } }
  const runtime = createYuanAgentRuntime({ ctx: { get: (name) => services[name], on }, dataDir: dir })
  t.after(() => runtime.dispose())
  await runtime.ensure()
  assert.equal(permission, 'danger-full-access'); assert.equal(approval, 'never')
  const chat = runtime.chat('你好', { contextText: '资料含 {{literal}}' })
  await new Promise((resolve) => setImmediate(resolve))
  const decision = await listeners.get('agent/pre-step')({ agent }, async () => ({ kind: 'enter', messages: [{ id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] }] }))
  assert.equal(decision.messages.at(-1).content.at(-1).text, '资料含 {{literal}}')
  assert.equal(decision.messages.at(-1).source.kind, 'leo-status')
  listeners.get('agent/assistant-stream')({ frame: { type: 'chunk', chunk: { type: 'text-delta', text: '正在读取' } } })
  listeners.get('session/event')(agent.session, { type: 'tool/call', data: { callId: 'tool-1', name: 'read', arguments: '{}' } })
  assert.equal(runtime.activity().text, '正在读取')
  assert.equal(runtime.activity().tools[0].name, 'read')
  runtime.stop()
  const result = await chat
  assert.deepEqual(cancelCause, { kind: 'user' })
  assert.equal(result.cancelled, true); assert.equal(runtime.activity().running, false)
  await runtime.dispose()
  assert.equal(prompts.size, 0); assert.equal(disposed, 5)
})

test('native new/history sessions keep selected models, capture human evidence and inject one bounded origin', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'leo-native-'))
  const listeners = new Map(), live = new Map(), captured = [], creations = [], resumes = [], workspaceSessions = []
  const on = (name, fn) => { const set = listeners.get(name) || new Set(); set.add(fn); listeners.set(name, set); return () => set.delete(fn) }
  const make = (id) => ({ id, session: { id, seq: 0, ownEvents: () => [] }, ctx: { on: () => () => {}, systemPrompt: { section: () => () => {} } } })
  const agents = { get: (id) => live.get(id), async create(options) { creations.push(options); const agent = make(options.sessionId); agent.session.header = { cwd: options.meta.cwd }; live.set(agent.id, agent); await options.setup?.(agent.ctx, agent); for (const fn of listeners.get('agent/created') || []) await fn({ agent }); return { agent, dispose() {} } },
    async resume(options) { resumes.push(options); const agent = make(options.resumeSessionId); live.set(agent.id, agent); return { agent, dispose() {} } } }
  const memory = { search: () => [{ id: 'm', text: '中文解释', kind: 'preference' }], async capture(r) { captured.push(r) } }
  const workspaceRegistry = { archivedSessionIds: [], async create(cwd) { assert.equal(cwd, path.join(dir, 'yuan', 'workspace')); return { async attachSession(id) { if (!workspaceSessions.includes(id)) workspaceSessions.push(id) } } } }
  const ctx = { on, get: (name) => ({ agents, workspaceRegistry })[name] }
  let runtime = createYuanAgentRuntime({ ctx, dataDir: dir, memory, getModel: () => ({ provider: 'initial', model: 'default' }) })
  t.after(async () => { await runtime.dispose(); await rm(dir, { recursive: true, force: true }) })
  const first = await runtime.open({ origin: { location: '待办', selection: '仅有关选中内容' } })
  const second = await runtime.open({ newSession: true })
  assert.notEqual(first.sessionId, second.sessionId)
  assert.equal((await runtime.sessions()).length, 2)
  assert.equal(creations[0].agentOptions.model, 'default')
  assert.deepEqual(workspaceSessions, [first.sessionId, second.sessionId])
  assert.equal(creations[0].meta.cwd, path.join(dir, 'yuan', 'workspace'))
  await runtime.open({ sessionId: first.sessionId })
  const agent = live.get(first.sessionId)
  const direct = { id: 'human', role: 'user', content: [{ type: 'text', text: '我希望代码解释使用中文' }], source: { kind: 'user' } }
  const hook = [...listeners.get('agent/pre-step')][0]
  const run = (messages) => hook({ agent }, async () => ({ kind: 'enter', messages }))
  const prepared = await run([direct])
  assert.equal(prepared.messages.length, 2)
  assert.ok(prepared.messages[1].content.some((b) => b.text?.includes('仅有关选中内容')))
  assert.equal((await run([direct])).messages[1].content.some((b) => b.text?.includes('仅有关选中内容')), false)
  assert.equal((await run([])).messages.length, 0)
  for (const fn of listeners.get('session/event')) {
    fn(agent.session, { type: 'user/message', seq: 2, data: direct })
    fn(agent.session, { type: 'user/message', seq: 3, data: { ...direct, source: { kind: 'leo-status' } } })
  }
  assert.equal(captured.length, 1)
  await assert.rejects(runtime.open({ sessionId: 'unrelated' }), /不是阿源/)
  await runtime.dispose(); live.clear()
  runtime = createYuanAgentRuntime({ ctx, dataDir: dir, memory, getModel: () => ({ provider: 'bad', model: 'must-not-reset' }) })
  await runtime.open({ sessionId: first.sessionId })
  assert.deepEqual(resumes[0].agentOptions, {})
  assert.equal((await runtime.sessions()).length, 2)
  workspaceRegistry.archivedSessionIds.push(first.sessionId)
  await assert.rejects(runtime.open({ sessionId: first.sessionId }), /已归档/)
  assert.equal((await runtime.sessions()).length, 1)
  assert.equal((await runtime.open()).sessionId, second.sessionId)
})

test('native workspace sessions acquire Yuan identity and exclusive context tool before first request, including resume', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'leo-identity-'))
  const listeners = new Map(), permissions = [], approvals = []
  const make = (id, cwd) => {
    const prompts = new Map(), tools = new Map()
    return { id, prompts, tools, session: { id, header: { cwd }, ownEvents: () => [] }, ctx: {
      on: () => () => {}, systemPrompt: { section(spec) { prompts.set(spec.name, spec); return () => prompts.delete(spec.name) } },
      tools: { register(spec) { tools.set(spec.name, spec); return () => tools.delete(spec.name) } },
    } }
  }
  const existing = make('native-yuan', path.join(dir, 'yuan', 'workspace'))
  const unrelated = make('ordinary-session', os.tmpdir())
  const services = { agents: { list: () => [existing, unrelated], get: () => existing, create() {} },
    permissionPresets: { set(session, value) { permissions.push([session.id, value]) } },
    approval: { setPolicy(agent, value) { approvals.push([agent.id, value]) } } }
  const runtime = createYuanAgentRuntime({ dataDir: dir, ctx: { get: n => services[n], on(n, fn) { listeners.set(n, fn); return () => listeners.delete(n) } } })
  t.after(async () => { await runtime.dispose(); await rm(dir, { recursive: true, force: true }) })
  await listeners.get('agent/created')({ agent: existing })
  assert.match(existing.prompts.get('leo-yuan-persona').text, /你是「阿源」/)
  assert.equal(existing.tools.has('yuan_context'), true)
  assert.equal(unrelated.prompts.size, 0); assert.equal(unrelated.tools.size, 0)
  assert.deepEqual(permissions, [['native-yuan', 'danger-full-access']])
  assert.deepEqual(approvals, [['native-yuan', 'never']])
  await runtime.open({ sessionId: existing.id, origin: { title: '代码审阅', code: 'const proof = 47' } })
  const page = JSON.parse(existing.tools.get('yuan_context').execute())
  assert.equal(page.identity, '阿源'); assert.equal(page.page.title, '代码审阅')
  const resumed = make(existing.id, path.join(dir, 'yuan', 'workspace'))
  await listeners.get('agent/created')({ agent: resumed })
  assert.match(resumed.prompts.get('leo-yuan-persona').text, /独立浮框/)
  assert.equal((await runtime.sessions()).filter(s => s.id === existing.id).length, 1)
})
