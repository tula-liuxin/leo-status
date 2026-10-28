import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { apply } from '../index.js'

async function port() {
  const server = http.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const value = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return value
}

async function host(t, base, name, settings, config = {}) {
  const dataDir = path.join(base, name)
  await mkdir(dataDir, { recursive: true })
  if (settings) await writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ includeDshTodos: false, obsidian: { autoDetect: false }, ...settings }))
  const routes = new Map(), effects = []
  const services = { webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) }, tapIndex() { return () => {} } }, connection: { authorizeIndex() { return true } } }
  const ctx = { get(name) { return services[name] }, on() { return () => {} },
    effect(fn) { const dispose = fn(); effects.push(dispose); return dispose },
    inject(names, fn) { if (names.every((name) => services[name])) fn(services); return () => {} },
  }
  apply(ctx, { dataDir, ...config })
  let closed = false
  const close = async () => { if (closed) return; closed = true; for (const effect of effects.reverse()) await effect?.() }
  t.after(close)
  async function call(route, body) {
    const pathname = `/leo-status/api/${route.split('?')[0]}`
    const req = { url: `/leo-status/api/${route}`, method: body === undefined ? 'GET' : 'POST', headers: {}, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) } }
    const res = { writeHead(status) { this.status = status }, end(raw) { this.data = JSON.parse(raw) } }
    assert.ok(routes.has(pathname), `missing ${pathname}`)
    await routes.get(pathname).handler(req, res)
    assert.equal(res.status, 200, JSON.stringify(res.data))
    return res.data
  }
  return { call, close, dataDir }
}

test('notes require Accept; accepted lifecycle persists and never edits sources', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'leo-intake-'))
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const vault = path.join(base, 'vault'); await mkdir(vault)
  const file = path.join(vault, 'a.md'), original = '# 计划\n- [ ] 交论文 📅 2026-10-30\n- [ ] 去验收\n- [x] 已完成\n'
  await writeFile(file, original)
  const local = await host(t, base, 'data', { markdownRoots: [{ path: vault, id: 'notes', label: '笔记' }] })
  const first = await local.call('todos?refresh=1')
  assert.equal(first.todos.length, 0)
  assert.equal(first.suggestions.length, 2)
  const candidate = first.suggestions.find((item) => item.text === '交论文')
  assert.equal(candidate.origin.file, file)
  const accepted = await local.call('yuan/suggestion/accept', { id: candidate.id })
  assert.equal(accepted.board.todos.length, 1)
  const todo = accepted.board.todos[0]
  assert.equal(todo.due, '2026-10-30')
  assert.equal(todo.sourceId, candidate.origin.sourceId, 'Accept preserves source filtering')
  for (const [action, field, value] of [['done', 'done', true], ['undone', 'done', false], ['cancel', 'cancelled', true], ['restore', 'cancelled', false]]) {
    const result = await local.call('todos/action', { id: todo.id, action })
    assert.equal(result.board.todos[0][field], value)
    assert.equal(result.board.stats.total, 1)
    assert.equal(result.board.stats.open, action === 'done' || action === 'cancel' ? 0 : 1)
  }
  const dismissed = first.suggestions.find((item) => item.id !== candidate.id)
  await local.call('yuan/suggestion/dismiss', { id: dismissed.id })
  await writeFile(file, '\n\n' + original)
  const moved = await local.call('todos?refresh=1')
  assert.equal(moved.suggestions.length, 0, 'line moves must not duplicate consent')
  assert.equal(await readFile(file, 'utf8'), '\n\n' + original)
  await local.close()
  const restarted = await host(t, base, 'data', null)
  assert.equal((await restarted.call('todos')).todos.length, 1)
  await restarted.call('todos/action', { id: todo.id, action: 'delete' })
  const removed = await restarted.call('todos?refresh=1')
  assert.equal(removed.todos.length, 0); assert.equal(removed.suggestions.length, 0)
  await restarted.close()
})

test('Obsidian vault tasks enter the board directly and old pending copies are hidden', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'leo-obsidian-'))
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const vault = path.join(base, 'vault'); await mkdir(vault)
  const file = path.join(vault, 'a.md'); await writeFile(file, '- [ ] 我的待办\n- [x] 已完成\n')
  const local = await host(t, base, 'data', { markdownRoots: [{ path: vault, id: 'notes', label: 'Vault' }] })
  assert.equal((await local.call('todos?refresh=1')).suggestions.length, 1)
  await mkdir(path.join(vault, '.obsidian'))
  const board = await local.call('todos?refresh=1')
  assert.equal(board.todos.length, 2)
  assert.equal(board.stats.open, 1)
  assert.equal(board.stats.done, 1)
  assert.equal(board.suggestions.length, 0)
  assert.equal((await local.call('yuan/signals')).pending, 0)
  const open = board.todos.find((item) => !item.done)
  assert.equal(open.obsidianVault, true)
  await local.call('todos/action', { id: open.id, action: 'done' })
  assert.match(await readFile(file, 'utf8'), /\[x\] 我的待办/i)
  await local.close()
})

test('two devices share central decisions, memory and actions over the authenticated hub API', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'leo-shared-'))
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const vault = path.join(base, 'vault'); await mkdir(vault); await writeFile(path.join(vault, 'a.md'), '- [ ] 远端用户验收\n')
  const hubPort = await port(), password = 'fixture-only'
  const center = await host(t, base, 'center', { mode: 'hub', hub: { port: hubPort, password, tunnel: { enabled: false } } })
  await center.call('todos')
  const device = await host(t, base, 'device', { markdownRoots: [{ path: vault }] })
  await device.call('join', { hubUrl: `http://127.0.0.1:${hubPort}`, password, name: 'second-device' })
  const state = await device.call('yuan/state')
  assert.equal(state.suggestions.length, 1)
  assert.equal(state.suggestions[0].origin.deviceName, 'second-device')
  const accepted = await device.call('yuan/suggestion/accept', { id: state.suggestions[0].id })
  assert.equal(accepted.board.mode, 'device')
  const todo = accepted.board.todos[0]
  await device.call('todos/action', { id: todo.id, action: 'done' })
  assert.equal((await center.call('todos?refresh=1')).todos[0].done, true)
  await device.call('yuan/remember', { text: '多设备共享偏好' })
  assert.equal((await center.call('yuan/state')).memory[0].text, '多设备共享偏好')
  assert.equal((await device.call('yuan/state')).memory.length, 1)
  assert.equal((await device.call('todos?refresh=1')).suggestions.length, 0)
  await device.close(); await center.close()
})

test('a remote Obsidian vault remains automatic through the hub snapshot', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'leo-remote-vault-'))
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const vault = path.join(base, 'vault'); await mkdir(vault); await mkdir(path.join(vault, '.obsidian'))
  await writeFile(path.join(vault, 'a.md'), '- [ ] 远端 Obsidian 事项\n')
  const hubPort = await port(), password = 'fixture-only'
  const center = await host(t, base, 'center', { mode: 'hub', hub: { port: hubPort, password, tunnel: { enabled: false } } })
  await center.call('todos')
  const device = await host(t, base, 'device', { markdownRoots: [{ path: vault }] })
  await device.call('join', { hubUrl: `http://127.0.0.1:${hubPort}`, password, name: 'second-device' })
  const board = await center.call('todos?refresh=1')
  assert.equal(board.todos.length, 1)
  assert.equal(board.todos[0].obsidianVault, true)
  assert.equal(board.suggestions.length, 0)
  await device.close(); await center.close()
})
