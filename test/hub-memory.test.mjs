import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHubMemory } from '../hub-memory.js'

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)))

test('hub-memory: 召回、写证据与失败降级都走中心的那一份记忆', async () => {
  const calls = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const payload = JSON.parse(body || '{}')
      calls.push({ url: req.url, auth: req.headers.authorization, payload })
      if (req.url === '/api/yuan/memory/query' && payload.id) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, items: [{ id: payload.id, text: '详情' }] }))
        return
      }
      if (req.url === '/api/yuan/memory/query') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, items: [{ id: 'memory:1', text: '偏好：先说结论', kind: 'preference' }] }))
        return
      }
      if (req.url === '/api/yuan/memory/capture') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, item: { id: 'episode:1' } }))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'not found' }))
    })
  })
  const url = await listen(server)
  const memory = createHubMemory({ hubUrl: url, password: 'hub-password', log: () => {} })
  try {
    const found = await memory.search('结论', { limit: 3 })
    assert.equal(found.length, 1)
    assert.equal(found[0].kind, 'preference')
    assert.equal(calls[0].auth, 'Bearer hub-password')
    assert.deepEqual(calls[0].payload, { query: '结论' })

    assert.equal((await memory.detail('memory:1')).text, '详情')

    await memory.capture({ sessionId: 's1', messageId: 'm1', seq: 3, text: '我更喜欢短回答', at: new Date().toISOString() })
    const capture = calls.find((call) => call.url === '/api/yuan/memory/capture')
    assert.equal(capture.payload.sessionId, 's1')
    assert.equal(capture.payload.text, '我更喜欢短回答')
    assert.equal(memory.status.backend, 'hub')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('hub-memory: 中心不可达时召回为空、错误记到 status，不抛给阿源', async () => {
  // 关闭的端口：连接被拒绝。
  const server = http.createServer()
  const url = await listen(server)
  await new Promise((resolve) => server.close(resolve))
  const memory = createHubMemory({ hubUrl: url, password: 'x', log: () => {} })
  assert.deepEqual(await memory.search('任意'), [])
  assert.equal(memory.status.lastError !== null, true)
  await memory.capture({ sessionId: 's', messageId: 'm', text: 'x' })
  assert.equal(memory.status.lastError !== null, true)
})
