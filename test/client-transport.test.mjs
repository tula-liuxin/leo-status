import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import vm from 'node:vm';

// Exercise the browser module's actual transport without a DOM or React render.
// Expose its closure only in this test VM; the shipped module has no test API.
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
function loadTransport(fetch, token = '') {
  let apiFetch;
  const code = source.replace(
    /return \{\s+inject: \['slots', 'locale'\],\s+apply,/,
    "return { apiFetch, inject: ['slots', 'locale'], apply,",
  );
  assert.notEqual(code, source, 'client module export must be found');
  vm.runInNewContext(code, {
    fetch,
    window: {
      __LEO_STATUS_PAGE_TOKEN__: token,
      __ModuleLoader__: { load(module) { apiFetch = module.factory(() => ({})).apiFetch; } },
    },
  });
  return apiFetch;
}

test('host API stays inside the current DSH mount, including refresh queries', async () => {
  for (const page of [
    'http://localhost:2977/',
    'http://localhost:2977/index.html#session',
    'https://center.example/d/device-a/',
    'https://center.example/d/device-b/index.html?theme=dark#session',
    'https://center.example/custom/mount/',
  ]) {
    const calls = [];
    const request = loadTransport((url, options) => { calls.push({ url: new URL(url, page), options }); }, 'test token');
    await request('/leo-status/api/todos?refresh=1', { headers: { accept: 'application/json' } });
    const { url, options } = calls[0];
    const directory = new URL('./', page).pathname;
    assert.equal(url.pathname, directory + 'leo-status/api/todos');
    assert.equal(url.searchParams.get('refresh'), '1');
    assert.equal(url.searchParams.get('_leo_status_token'), 'test token');
    assert.equal(options.headers['x-leo-status-token'], 'test token');
    assert.equal(options.headers.accept, 'application/json');
    assert.equal(options.credentials, 'same-origin');
  }
});

test('cookie-only requests also retain their mount', async () => {
  const request = loadTransport((url, options) => ({ url, options }));
  const result = await request('/leo-status/api/yuan/state');
  assert.equal(result.url, 'leo-status/api/yuan/state');
  assert.equal(result.options.headers['x-leo-status-token'], undefined);
  assert.equal(result.options.credentials, 'same-origin');
});

test('device-center routing does not send board or mutations to the hub relay', async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://fixture');
    requests.push({ path: url.pathname, method: req.method, body });
    // Root /leo-status belongs to a separate Bearer-authenticated hub relay.
    if (url.pathname.startsWith('/leo-status/')) {
      res.writeHead(401); res.end('hub requires Bearer'); return;
    }
    // Model the device tunnel's header allowlist: only query credentials survive.
    if (url.pathname.startsWith('/d/device-a/leo-status/') && url.searchParams.get('_leo_status_token') === 'fixture-page-token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, method: req.method, body })); return;
    }
    res.writeHead(401); res.end('unauthorized');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = origin + '/d/device-a/';
  assert.equal((await fetch(origin + '/leo-status/api/todos')).status, 401, 'old root URL reproduces the failure');
  const request = loadTransport((url, options) => fetch(new URL(url, page), options), 'fixture-page-token');
  assert.equal((await request('/leo-status/api/todos?refresh=1')).status, 200);
  const body = JSON.stringify({ action: 'complete', id: 'fixture-id' });
  const result = await request('/leo-status/api/todos/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.deepEqual(await result.json(), { ok: true, method: 'POST', body });
  assert.deepEqual(requests.map(r => r.path), ['/leo-status/api/todos', '/d/device-a/leo-status/api/todos', '/d/device-a/leo-status/api/todos/action']);
});
