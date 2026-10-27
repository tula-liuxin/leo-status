/**
 * leo-status v2 · hub 模块测试（node:test / 无第三方依赖）
 *
 * 全部走真实 HTTP：`startHubServer({ port: 0 })` 绑定 127.0.0.1 随机端口，
 * 用全局 `fetch` 发请求；fixture 用 `fs.mkdtemp(os.tmpdir())`，结束后递归删除。
 *
 * 覆盖（对应 CONTRACT-V2 §2/§4/§5）：
 *   health / 鉴权 / join（生成 id、幂等、name 截断）/ push（白名单、400、413）
 *   board 合并（id 前缀、sources、config、devices 排序、online 阈值、stats 口径）
 *   remark / delete / 坏 JSON 容错 / 并发 push / 500 不泄露堆栈 / close 幂等 / store 原子写与 prune
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createHubStore, buildBoard, createHubHandler, startHubServer } from '../hub.js';

const PASSWORD = 'test-password';

const V1_FIELDS = [
  'id',
  'kind',
  'text',
  'raw',
  'done',
  'cancelled',
  'sourceId',
  'sourceLabel',
  'file',
  'relPath',
  'line',
  'heading',
  'indent',
  'noteDate',
  'due',
  'scheduled',
  'start',
  'priority',
  'tags',
  'links',
  'recurrence',
  'sessionId',
  'sessionTitle',
  'project',
];

/* ------------------------------------------------------------------ */
/* fixture 工具                                                        */
/* ------------------------------------------------------------------ */

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

/** 本机本地时区的 YYYY-MM-DD（与 scan.js stats 的口径一致）。 */
function localDate(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function makeLocalTodo(overrides = {}) {
  return {
    id: 'md:obsidian-main:a.md:1',
    kind: 'markdown',
    text: '本机任务',
    raw: '- [ ] 本机任务',
    done: false,
    cancelled: false,
    sourceId: 'obsidian-main',
    sourceLabel: 'Obsidian 主库',
    file: 'C:\\notes\\a.md',
    relPath: 'a.md',
    line: 1,
    heading: 'H1 > H2',
    indent: 0,
    noteDate: '2026-10-26',
    due: localDate(3),
    scheduled: null,
    start: null,
    priority: 'high',
    tags: ['todo'],
    links: [],
    recurrence: null,
    sessionId: null,
    sessionTitle: null,
    project: null,
    ...overrides,
  };
}

function makeRemoteTodo(overrides = {}) {
  return {
    id: 'md:remote.md:7',
    kind: 'markdown',
    text: '远端任务',
    raw: '- [ ] 远端任务',
    done: false,
    cancelled: false,
    sourceId: 'remote-root',
    sourceLabel: '远端库',
    file: null,
    relPath: 'remote.md',
    line: 7,
    heading: null,
    indent: 0,
    noteDate: null,
    due: null,
    scheduled: null,
    start: null,
    priority: null,
    tags: [],
    links: [],
    recurrence: null,
    sessionId: null,
    sessionTitle: null,
    project: null,
    ...overrides,
  };
}

function makeLocalSnapshot(overrides = {}) {
  return {
    ok: true,
    version: 1,
    generatedAt: new Date().toISOString(),
    tookMs: 5,
    sources: [
      {
        id: 'obsidian-main',
        kind: 'markdown',
        label: 'Obsidian 主库',
        path: 'C:\\notes',
        files: 1,
        count: 2,
        open: 1,
        done: 1,
        error: null,
      },
    ],
    todos: [
      makeLocalTodo({ id: 'md:obsidian-main:a.md:1', text: '本机一' }),
      makeLocalTodo({ id: 'md:obsidian-main:a.md:2', text: '本机二', done: true }),
    ],
    stats: {},
    config: { includeDshTodos: true, markdownRootCount: 1 },
    ...overrides,
  };
}

/**
 * @param {import('node:test').TestContext} t
 * @param {object} [options]
 *   beforeLoad({dir,dataDir}) 在 store.load() 之前跑（用于写坏文件）
 *   password / local / localDevice / syncIntervalMs / meta / boardProvider / log
 */
async function createFixture(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'leo-status-hub-'));
  const dataDir = path.join(dir, 'data');
  let server = null;

  t.after(async () => {
    if (server !== null) await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  if (typeof options.beforeLoad === 'function') await options.beforeLoad({ dir, dataDir });

  const store = options.store ?? createHubStore(dataDir);
  if (options.loadStore !== false) await store.load();

  const state = {
    local: options.local !== undefined ? options.local : makeLocalSnapshot(),
    localDevice:
      options.localDevice ?? { id: 'local', name: 'leo', platform: 'win32', version: '0.2.0' },
    syncIntervalMs: options.syncIntervalMs ?? 60_000,
    meta:
      options.meta ??
      {
        mode: 'hub',
        role: 'hub',
        hub: { connected: true, lastSyncAt: null, error: null },
        relay: { enabled: true, state: 'running', error: null },
      },
  };

  const boardProvider =
    options.boardProvider ??
    (() =>
      buildBoard({
        local: state.local,
        localDevice: state.localDevice,
        store,
        now: new Date(),
        syncIntervalMs: state.syncIntervalMs,
        meta: state.meta,
      }));

  const handler = createHubHandler({
    password: options.password ?? PASSWORD,
    store,
    boardProvider,
    syncIntervalMs: state.syncIntervalMs,
    log: options.log,
  });

  server = await startHubServer({ port: 0, handler });
  const request = (pathname, init) => fetch(`${server.url}${pathname}`, init);

  return { dir, dataDir, store, state, server, handler, request };
}

/** 统一请求：默认带 Bearer；token:undefined 表示完全不带 authorization。 */
async function call(request, pathname, options = {}) {
  const { method = 'GET', body, rawBody, headers = {} } = options;
  const token = Object.hasOwn(options, 'token') ? options.token : PASSWORD;
  const requestHeaders = { ...headers };
  if (token !== undefined) requestHeaders.authorization = `Bearer ${token}`;

  let payload;
  if (body !== undefined) {
    requestHeaders['content-type'] = 'application/json';
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  } else if (rawBody !== undefined) {
    payload = rawBody;
  }

  const res = await request(pathname, { method, headers: requestHeaders, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  return { res, status: res.status, headers: res.headers, text, json };
}

async function joinDevice(request, overrides = {}) {
  const result = await call(request, '/api/join', {
    method: 'POST',
    body: { name: 'leo-laptop', platform: 'win32', pluginVersion: '0.2.0', ...overrides },
  });
  assert.equal(result.status, 200, result.text);
  return result.json;
}

async function pushSnapshot(request, deviceId, todos, extra = {}) {
  const result = await call(request, '/api/push', {
    method: 'POST',
    body: {
      deviceId,
      name: extra.name ?? 'leo-laptop',
      platform: extra.platform ?? 'win32',
      pluginVersion: extra.pluginVersion ?? '0.2.0',
      snapshot: {
        generatedAt: new Date().toISOString(),
        todos,
        stats: {},
        sources: [],
        ...(extra.snapshot ?? {}),
      },
    },
  });
  assert.equal(result.status, 200, result.text);
  return result.json;
}

/* ------------------------------------------------------------------ */
/* HTTP API                                                            */
/* ------------------------------------------------------------------ */

test('GET /api/health：免鉴权、契约形状、不返回设备细节、POST 405', async (t) => {
  const fx = await createFixture(t);

  const result = await call(fx.request, '/api/health', { token: undefined });
  assert.equal(result.status, 200);
  assert.match(result.headers.get('content-type') ?? '', /^application\/json; charset=utf-8$/i);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(result.json).sort(), ['devices', 'ok', 'role', 'time', 'version']);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.version, 2);
  assert.equal(result.json.role, 'hub');
  assert.equal(typeof result.json.devices, 'number');
  assert.ok(!Number.isNaN(Date.parse(result.json.time)));

  const wrongMethod = await call(fx.request, '/api/health', { method: 'POST', token: undefined });
  assert.equal(wrongMethod.status, 405);
});

test('Bearer 鉴权：缺失/错误/长度不同都 401（timingSafeEqual 不抛），正确才 200', async (t) => {
  const fx = await createFixture(t);

  const missing = await call(fx.request, '/api/board', { token: undefined });
  assert.equal(missing.status, 401);
  assert.deepEqual(missing.json, { ok: false, error: 'unauthorized' });

  const empty = await call(fx.request, '/api/board', { token: '' });
  assert.equal(empty.status, 401);

  const wrong = await call(fx.request, '/api/board', { token: 'wrong-password' });
  assert.equal(wrong.status, 401);

  // 长度差异极大也不能抛异常
  const longWrong = await call(fx.request, '/api/board', { token: 'x'.repeat(5000) });
  assert.equal(longWrong.status, 401);

  // 没有 Bearer 前缀
  const rawHeader = await call(fx.request, '/api/board', {
    token: undefined,
    headers: { authorization: PASSWORD },
  });
  assert.equal(rawHeader.status, 401);

  assert.equal((await call(fx.request, '/api/board')).status, 200);
});

test('未配置密码：health 照常，受保护端点一律 401', async (t) => {
  const fx = await createFixture(t, { password: '', local: makeLocalSnapshot({ todos: [] }) });

  assert.equal((await call(fx.request, '/api/health', { token: undefined })).status, 200);
  assert.equal((await call(fx.request, '/api/board')).status, 401);
  assert.equal((await call(fx.request, '/api/board', { token: 'anything' })).status, 401);
});

test('POST /api/join：生成 24 hex deviceId、幂等更新、返回 hubTime/syncIntervalMs', async (t) => {
  const fx = await createFixture(t, { local: makeLocalSnapshot({ todos: [] }) });

  const first = await joinDevice(fx.request);
  assert.match(first.deviceId, /^[0-9a-f]{24}$/);
  assert.equal(first.syncIntervalMs, 60_000);
  assert.ok(!Number.isNaN(Date.parse(first.hubTime)));

  assert.equal(fx.store.listDevices().length, 1);
  const created = fx.store.getDevice(first.deviceId);
  assert.equal(created.name, 'leo-laptop');
  assert.equal(created.platform, 'win32');
  assert.equal(created.pluginVersion, '0.2.0');
  assert.equal(created.lastPush, null);
  assert.ok(created.firstSeen);

  const second = await joinDevice(fx.request, { deviceId: first.deviceId, name: 'leo-改名' });
  assert.equal(second.deviceId, first.deviceId);
  assert.equal(fx.store.listDevices().length, 1);
  const updated = fx.store.getDevice(first.deviceId);
  assert.equal(updated.name, 'leo-改名');
  assert.equal(updated.firstSeen, created.firstSeen); // firstSeen 保留

  // 非法 deviceId 400
  const bad = await call(fx.request, '/api/join', {
    method: 'POST',
    body: { deviceId: '../escape', name: 'x' },
  });
  assert.equal(bad.status, 400);
});

test('join 的 name 按 Unicode 码点截断到 60', async (t) => {
  const fx = await createFixture(t, { local: makeLocalSnapshot({ todos: [] }) });

  const joined = await joinDevice(fx.request, { name: '中'.repeat(80) });
  assert.equal([...fx.store.getDevice(joined.deviceId).name].length, 60);

  const ascii = await joinDevice(fx.request, { name: 'a'.repeat(100) });
  assert.equal(fx.store.getDevice(ascii.deviceId).name, 'a'.repeat(60));
});

test('push 后 board 合并：local:/deviceId: 前缀、字段白名单、sources、config/meta', async (t) => {
  const fx = await createFixture(t);
  const joined = await joinDevice(fx.request);
  const pushed = await pushSnapshot(fx.request, joined.deviceId, [
    makeRemoteTodo({ id: 'md:r1.md:1', text: '远端一' }),
    makeRemoteTodo({ id: 'md:r2.md:2', text: '远端二', cancelled: true }),
    makeRemoteTodo({ id: 'md:r3.md:3', text: '远端三', done: true }),
  ]);
  assert.equal(pushed.todoCount, 3);
  assert.ok(!Number.isNaN(Date.parse(pushed.receivedAt)));

  const { status, json: board } = await call(fx.request, '/api/board');
  assert.equal(status, 200);
  assert.equal(board.ok, true);
  assert.equal(board.version, 2);
  assert.equal(board.mode, 'hub');
  assert.equal(board.role, 'hub');
  assert.deepEqual(board.device, { id: 'local', name: 'leo', platform: 'win32' });
  assert.deepEqual(board.hub, {
    connected: true,
    lastSyncAt: null,
    error: null,
    relay: { enabled: true, state: 'running', error: null },
  });
  assert.deepEqual(board.config, {
    includeDshTodos: true,
    markdownRootCount: 1,
    syncIntervalMs: 60_000,
  });
  assert.ok(!Number.isNaN(Date.parse(board.generatedAt)));
  assert.equal(typeof board.tookMs, 'number');

  // devices：本机第一、远端在线
  assert.equal(board.devices.length, 2);
  assert.equal(board.devices[0].id, 'local');
  assert.equal(board.devices[0].local, true);
  assert.equal(board.devices[0].online, true);
  assert.equal(board.devices[0].todoCount, 2);
  assert.equal(board.devices[1].id, joined.deviceId);
  assert.equal(board.devices[1].local, false);
  assert.equal(board.devices[1].online, true);
  assert.equal(board.devices[1].todoCount, 3);
  assert.equal(board.devices[1].name, 'leo-laptop');
  assert.equal(board.devices[1].version, '0.2.0');

  // todos：本地前缀 local: / 远端前缀 <deviceId>:
  const localTodos = board.todos.filter((todo) => todo.deviceId === 'local');
  const remoteTodos = board.todos.filter((todo) => todo.deviceId === joined.deviceId);
  assert.equal(localTodos.length, 2);
  assert.equal(remoteTodos.length, 3);
  assert.ok(
    localTodos.every(
      (todo) => todo.id.startsWith('local:') && todo.local === true && todo.deviceName === 'leo',
    ),
  );
  assert.ok(
    remoteTodos.every(
      (todo) =>
        todo.id.startsWith(`${joined.deviceId}:`) &&
        todo.local === false &&
        todo.deviceName === 'leo-laptop',
    ),
  );
  assert.deepEqual(
    remoteTodos.map((todo) => todo.text).sort(),
    ['远端一', '远端三', '远端二'].sort(),
  );
  assert.ok(remoteTodos.some((todo) => todo.cancelled === true));
  assert.ok(remoteTodos.some((todo) => todo.done === true));

  // v1 全部字段 + deviceId/deviceName/local 都在
  for (const todo of board.todos) {
    for (const field of V1_FIELDS) assert.ok(Object.hasOwn(todo, field), `缺少字段 ${field}`);
    for (const field of ['deviceId', 'deviceName', 'local']) {
      assert.ok(Object.hasOwn(todo, field), `缺少字段 ${field}`);
    }
  }

  // sources 只放本机，且带 deviceId:"local"
  assert.equal(board.sources.length, 1);
  assert.equal(board.sources[0].id, 'obsidian-main');
  assert.equal(board.sources[0].deviceId, 'local');
});

test('push 只存白名单字段：远端多传的字段被丢弃', async (t) => {
  const fx = await createFixture(t, { local: makeLocalSnapshot({ todos: [] }) });
  const joined = await joinDevice(fx.request);

  await pushSnapshot(fx.request, joined.deviceId, [
    makeRemoteTodo({ id: 'evil-1', text: '带脏字段', hack: 'DROP TABLE', deviceId: 'spoofed' }),
  ]);

  const snapshot = fx.store.getSnapshots().find((item) => item.deviceId === joined.deviceId);
  assert.ok(snapshot);
  assert.equal(snapshot.todos.length, 1);
  assert.equal(snapshot.todos[0].text, '带脏字段');
  assert.ok(!('hack' in snapshot.todos[0]));
  assert.ok(!('deviceId' in snapshot.todos[0])); // 设备字段由 buildBoard 生成
  for (const field of V1_FIELDS) assert.ok(Object.hasOwn(snapshot.todos[0], field));

  // 落盘的快照文件同样干净
  const file = path.join(fx.dataDir, 'hub', 'snapshots', `${joined.deviceId}.json`);
  const onDisk = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(!('hack' in onDisk.todos[0]));
  assert.equal(onDisk.deviceId, joined.deviceId);
});

test('board stats 重算：open 排除 done/cancelled，cancelled 单独计', async (t) => {
  const fx = await createFixture(t, { local: makeLocalSnapshot({ todos: [] }) });
  const joined = await joinDevice(fx.request);
  await pushSnapshot(fx.request, joined.deviceId, [
    makeRemoteTodo({ id: 'o1', due: localDate(-1) }), // overdue
    makeRemoteTodo({ id: 'o2', due: localDate(0) }), // dueToday
    makeRemoteTodo({ id: 'o3', due: localDate(3) }), // dueSoon
    makeRemoteTodo({ id: 'o4' }), // undated
    makeRemoteTodo({ id: 'd1', done: true, due: localDate(-5) }),
    makeRemoteTodo({ id: 'c1', cancelled: true, due: localDate(-2) }),
  ]);

  const { json: board } = await call(fx.request, '/api/board');
  assert.deepEqual(board.stats, {
    total: 6,
    open: 4,
    done: 1,
    cancelled: 1,
    overdue: 1,
    dueToday: 1,
    dueSoon: 1,
    undated: 1,
  });
});

test('online 阈值 = max(3*syncIntervalMs, 180000)', async (t) => {
  const fx = await createFixture(t, { local: makeLocalSnapshot({ todos: [] }) });
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();

  await fx.store.upsertDevice({ id: 'dev-a', name: 'A', platform: 'linux', lastSeen: iso(1_000) });
  await fx.store.upsertDevice({ id: 'dev-b', name: 'B', platform: 'linux', lastSeen: iso(200_000) });

  let board = (await call(fx.request, '/api/board')).json;
  assert.equal(board.devices.find((device) => device.id === 'dev-a').online, true);
  assert.equal(board.devices.find((device) => device.id === 'dev-b').online, false);

  // 阈值下限 180000（syncIntervalMs=60000 => 3x=180000）
  await fx.store.upsertDevice({ id: 'dev-a', lastSeen: iso(179_000) });
  board = (await call(fx.request, '/api/board')).json;
  assert.equal(board.devices.find((device) => device.id === 'dev-a').online, true);

  // syncIntervalMs=120000 => 阈值 360000
  fx.state.syncIntervalMs = 120_000;
  await fx.store.upsertDevice({ id: 'dev-a', lastSeen: iso(300_000) });
  board = (await call(fx.request, '/api/board')).json;
  assert.equal(board.devices.find((device) => device.id === 'dev-a').online, true);

  await fx.store.upsertDevice({ id: 'dev-a', lastSeen: iso(400_000) });
  board = (await call(fx.request, '/api/board')).json;
  assert.equal(board.devices.find((device) => device.id === 'dev-a').online, false);
});

test('devices 排序：本机第一、其余按 name localeCompare(zh)', async (t) => {
  const fx = await createFixture(t, { local: makeLocalSnapshot({ todos: [] }) });
  await Promise.all([
    joinDevice(fx.request, { name: '阿尔法' }),
    joinDevice(fx.request, { name: '贝塔' }),
    joinDevice(fx.request, { name: '伽马' }),
  ]);

  const { json: board } = await call(fx.request, '/api/board');
  assert.equal(board.devices[0].id, 'local');
  const remoteNames = board.devices.slice(1).map((device) => device.name);
  const expected = ['阿尔法', '贝塔', '伽马'].sort((a, b) => a.localeCompare(b, 'zh'));
  assert.deepEqual(remoteNames, expected);
});

test('POST /api/devices/:id/remark：更新备注、截断 60、board deviceName 用 remark', async (t) => {
  const fx = await createFixture(t, { local: makeLocalSnapshot({ todos: [] }) });
  const joined = await joinDevice(fx.request);
  await pushSnapshot(fx.request, joined.deviceId, [makeRemoteTodo({ id: 'r1' })]);

  const remark = await call(fx.request, `/api/devices/${joined.deviceId}/remark`, {
    method: 'POST',
    body: { remark: '书房的笔记本' },
  });
  assert.equal(remark.status, 200);
  assert.equal(remark.json.device.remark, '书房的笔记本');
  assert.equal(fx.store.getDevice(joined.deviceId).remark, '书房的笔记本');

  let board = (await call(fx.request, '/api/board')).json;
  assert.equal(board.devices[1].name, '书房的笔记本');
  assert.equal(board.todos[0].deviceName, '书房的笔记本');

  const longRemark = await call(fx.request, `/api/devices/${joined.deviceId}/remark`, {
    method: 'POST',
    body: { remark: '备'.repeat(90) },
  });
  assert.equal(longRemark.status, 200);
  assert.equal([...longRemark.json.device.remark].length, 60);

  // 未知设备 404
  const unknown = await call(fx.request, '/api/devices/deadbeef/remark', {
    method: 'POST',
    body: { remark: 'x' },
  });
  assert.equal(unknown.status, 404);

  // 非字符串 400
  const badType = await call(fx.request, `/api/devices/${joined.deviceId}/remark`, {
    method: 'POST',
    body: { remark: 123 },
  });
  assert.equal(badType.status, 400);
});

test('DELETE /api/devices/:id：移除设备与快照，board 不再包含，可重复调用', async (t) => {
  const fx = await createFixture(t, { local: makeLocalSnapshot({ todos: [] }) });
  const joined = await joinDevice(fx.request);
  await pushSnapshot(fx.request, joined.deviceId, [makeRemoteTodo({ id: 'x' })]);

  const snapshotFile = path.join(fx.dataDir, 'hub', 'snapshots', `${joined.deviceId}.json`);
  assert.ok((await readFile(snapshotFile, 'utf8')).includes(joined.deviceId));

  const deleted = await call(fx.request, `/api/devices/${joined.deviceId}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.json, { ok: true });

  assert.equal(fx.store.getDevice(joined.deviceId), null);
  assert.equal(fx.store.getSnapshots().length, 0);
  await assert.rejects(
    async () => {
      await readFile(snapshotFile, 'utf8');
    },
    (error) => error.code === 'ENOENT',
  );

  const board = (await call(fx.request, '/api/board')).json;
  assert.equal(board.devices.length, 1);
  assert.equal(board.todos.length, 0);

  // 幂等
  assert.equal(
    (await call(fx.request, `/api/devices/${joined.deviceId}`, { method: 'DELETE' })).status,
    200,
  );
});

test('坏 JSON 容错：devices.json / snapshots 损坏当空，之后仍可正常写入', async (t) => {
  const fx = await createFixture(t, {
    beforeLoad: async ({ dataDir }) => {
      await mkdir(path.join(dataDir, 'hub', 'snapshots'), { recursive: true });
      await writeFile(path.join(dataDir, 'hub', 'devices.json'), '{not valid json', 'utf8');
      await writeFile(path.join(dataDir, 'hub', 'snapshots', 'bad.json'), '{{', 'utf8');
    },
  });

  assert.deepEqual(fx.store.listDevices(), []);
  assert.deepEqual(fx.store.getSnapshots(), []);
  assert.equal((await call(fx.request, '/api/health', { token: undefined })).json.devices, 0);

  const joined = await joinDevice(fx.request);
  assert.equal(fx.store.listDevices().length, 1);
  const doc = JSON.parse(await readFile(path.join(fx.dataDir, 'hub', 'devices.json'), 'utf8'));
  assert.equal(doc.version, 1);
  assert.ok(doc.devices[joined.deviceId]);
});

test('单个坏快照被忽略：设备仍在 devices 里，todoCount 0', async (t) => {
  const fx = await createFixture(t, {
    local: makeLocalSnapshot({ todos: [] }),
    beforeLoad: async ({ dataDir }) => {
      await mkdir(path.join(dataDir, 'hub', 'snapshots'), { recursive: true });
      const now = new Date().toISOString();
      await writeFile(
        path.join(dataDir, 'hub', 'devices.json'),
        JSON.stringify({
          version: 1,
          devices: {
            devx: {
              id: 'devx',
              name: 'X',
              platform: 'linux',
              pluginVersion: '0.2.0',
              firstSeen: now,
              lastSeen: now,
              lastPush: null,
              remark: null,
            },
          },
        }),
        'utf8',
      );
      await writeFile(path.join(dataDir, 'hub', 'snapshots', 'devx.json'), 'not-json', 'utf8');
    },
  });

  const { json: board } = await call(fx.request, '/api/board');
  const device = board.devices.find((item) => item.id === 'devx');
  assert.ok(device);
  assert.equal(device.todoCount, 0);
  assert.equal(device.online, true);
  assert.equal(board.todos.length, 0);
});

test('POST /api/push：body 超过 4 MiB => 413 且不落库', async (t) => {
  const fx = await createFixture(t, { local: makeLocalSnapshot({ todos: [] }) });
  const joined = await joinDevice(fx.request);

  const payload = JSON.stringify({
    deviceId: joined.deviceId,
    snapshot: { todos: [], pad: 'a'.repeat(4 * 1024 * 1024 + 64 * 1024) },
  });
  assert.ok(Buffer.byteLength(payload) > 4 * 1024 * 1024);

  const result = await call(fx.request, '/api/push', {
    method: 'POST',
    rawBody: payload,
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(result.status, 413);
  assert.equal(result.json.ok, false);
  assert.equal(fx.store.getSnapshots().length, 0);

  // 并发写路径仍正常
  await pushSnapshot(fx.request, joined.deviceId, [makeRemoteTodo({ id: 'ok' })]);
  assert.equal(fx.store.getSnapshots().length, 1);
});

test('push/join 参数校验：deviceId、snapshot.todos 必须是数组', async (t) => {
  const fx = await createFixture(t, { local: makeLocalSnapshot({ todos: [] }) });
  const joined = await joinDevice(fx.request);

  assert.equal(
    (
      await call(fx.request, '/api/push', {
        method: 'POST',
        body: { deviceId: joined.deviceId, snapshot: {} },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call(fx.request, '/api/push', {
        method: 'POST',
        body: { deviceId: joined.deviceId, snapshot: { todos: 'nope' } },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call(fx.request, '/api/push', {
        method: 'POST',
        body: { snapshot: { todos: [] } },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call(fx.request, '/api/push', {
        method: 'POST',
        body: { deviceId: '../escape', snapshot: { todos: [] } },
      })
    ).status,
    400,
  );
});

test('坏 JSON body / 非对象 body => 400', async (t) => {
  const fx = await createFixture(t);

  assert.equal(
    (await call(fx.request, '/api/join', { method: 'POST', body: 'not json' })).status,
    400,
  );
  assert.equal(
    (await call(fx.request, '/api/join', { method: 'POST', body: '[1,2,3]' })).status,
    400,
  );
  assert.equal((await call(fx.request, '/api/join', { method: 'POST', rawBody: '' })).status, 400);
});

test('未知路径 404、方法不符 405（带 Allow）', async (t) => {
  const fx = await createFixture(t);

  assert.equal((await call(fx.request, '/api/nope')).status, 404);
  assert.equal((await call(fx.request, '/api/nope', { method: 'POST', body: {} })).status, 404);

  const joinGet = await call(fx.request, '/api/join');
  assert.equal(joinGet.status, 405);
  assert.equal(joinGet.headers.get('allow'), 'POST');

  assert.equal((await call(fx.request, '/api/board', { method: 'POST', body: {} })).status, 405);
  assert.equal((await call(fx.request, '/api/push')).status, 405);
  assert.equal(
    (await call(fx.request, '/api/devices/some-id', { method: 'POST', body: {} })).status,
    405,
  );
  assert.equal(
    (await call(fx.request, '/api/devices/some-id/remark')).status,
    405,
  );

  // 鉴权先于路由：错误 token 访问未知路径也是 401
  assert.equal((await call(fx.request, '/api/nope', { token: 'bad' })).status, 401);
});

test('handler 内部异常 => 500 且不泄露堆栈/内部信息', async (t) => {
  const fx = await createFixture(t, {
    boardProvider: () => {
      throw new Error('boom secret C:\\internal\\leak');
    },
  });

  const result = await call(fx.request, '/api/board');
  assert.equal(result.status, 500);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.error, 'internal error');
  assert.equal(result.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.ok(!result.text.includes('boom'));
  assert.ok(!result.text.includes('secret'));
  assert.ok(!result.text.includes('leak'));
  assert.ok(!result.text.toLowerCase().includes('stack'));
});

test('并发 push：多设备 + 同一设备并发都成功，设备表/快照不被写坏', async (t) => {
  const fx = await createFixture(t, { local: makeLocalSnapshot({ todos: [] }) });
  const count = 6;
  const devices = await Promise.all(
    Array.from({ length: count }, (_, index) => joinDevice(fx.request, { name: `dev-${index}` })),
  );

  const tasks = [];
  devices.forEach((device, index) => {
    tasks.push(
      pushSnapshot(fx.request, device.deviceId, [
        makeRemoteTodo({ id: `a-${index}` }),
        makeRemoteTodo({ id: `b-${index}` }),
      ]),
    );
  });
  // 同一设备 5 次并发（最后一次写赢，但文件不能损坏）
  for (let index = 0; index < 5; index += 1) {
    tasks.push(
      pushSnapshot(fx.request, devices[0].deviceId, [
        makeRemoteTodo({ id: `same-${index}` }),
        makeRemoteTodo({ id: `same2-${index}` }),
      ]),
    );
  }

  const results = await Promise.all(tasks);
  assert.ok(results.every((result) => result.ok === true));
  assert.equal(fx.store.listDevices().length, count);

  const board = (await call(fx.request, '/api/board')).json;
  assert.equal(board.devices.length, count + 1); // 本机 + 6
  const remoteTodoCount = board.devices
    .filter((device) => device.local !== true)
    .reduce((sum, device) => sum + device.todoCount, 0);
  assert.equal(remoteTodoCount, board.todos.length);
  assert.equal(board.todos.length, (count - 1) * 2 + 2);

  const doc = JSON.parse(await readFile(path.join(fx.dataDir, 'hub', 'devices.json'), 'utf8'));
  assert.equal(Object.keys(doc.devices).length, count);
});

/* ------------------------------------------------------------------ */
/* server / store / buildBoard 单元级                                  */
/* ------------------------------------------------------------------ */

test('startHubServer：url 为 127.0.0.1 随机端口，close 可重复调用', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'leo-status-hub-server-'));
  const store = createHubStore(path.join(dir, 'data'));
  await store.load();
  const handler = createHubHandler({
    password: PASSWORD,
    store,
    boardProvider: () =>
      buildBoard({
        local: makeLocalSnapshot({ todos: [] }),
        localDevice: { name: 'leo' },
        store,
        now: new Date(),
      }),
  });
  const server = await startHubServer({ port: 0, handler });
  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await fetch(`${server.url}/api/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).role, 'hub');
  } finally {
    await server.close();
    await server.close(); // 重复调用不能再抛
    await rm(dir, { recursive: true, force: true });
  }

  await assert.rejects(fetch(`${server.url}/api/health`));
});

test('store：devices.json/快照为原子写（无 .tmp 残留、POSIX 0600），prune 清旧快照但保留设备', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'leo-status-hub-store-'));
  const dataDir = path.join(dir, 'data');
  const store = createHubStore(dataDir);
  try {
    await store.load();
    const now = new Date().toISOString();
    await store.upsertDevice({
      id: 'dev1',
      name: '设备一',
      platform: 'win32',
      pluginVersion: '0.2.0',
      firstSeen: now,
      lastSeen: now,
    });
    await store.saveSnapshot('dev1', {
      receivedAt: '2020-01-01T00:00:00.000Z',
      todos: [{ id: 't1', text: '旧任务', hack: 'drop-me' }],
    });

    const hubDir = path.join(dataDir, 'hub');
    const devicesFile = path.join(hubDir, 'devices.json');
    const snapshotFile = path.join(hubDir, 'snapshots', 'dev1.json');

    const devicesDoc = JSON.parse(await readFile(devicesFile, 'utf8'));
    assert.equal(devicesDoc.version, 1);
    assert.equal(devicesDoc.devices.dev1.name, '设备一');

    const snapshotDoc = JSON.parse(await readFile(snapshotFile, 'utf8'));
    assert.equal(snapshotDoc.deviceId, 'dev1');
    assert.equal(snapshotDoc.todos.length, 1);
    assert.ok(!('hack' in snapshotDoc.todos[0]));

    const hubEntries = await readdir(hubDir);
    assert.deepEqual(hubEntries.filter((name) => name.endsWith('.tmp')), []);

    if (process.platform !== 'win32') {
      assert.equal((await stat(devicesFile)).mode & 0o777, 0o600);
      assert.equal((await stat(snapshotFile)).mode & 0o777, 0o600);
    }

    const removed = await store.prune(Date.now());
    assert.deepEqual(removed, ['dev1']);
    assert.equal(store.getSnapshots().length, 0);
    assert.equal(store.getDevice('dev1').name, '设备一'); // 设备记录保留
    await assert.rejects(
      async () => {
        await readFile(snapshotFile, 'utf8');
      },
      (error) => error.code === 'ENOENT',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildBoard：meta.hub.relay.state=starting（隧道启动中）原样保留', () => {
  const store = { listDevices: () => [], getSnapshots: () => [] };
  const board = buildBoard({
    local: makeLocalSnapshot({ todos: [] }),
    localDevice: { name: 'leo', platform: 'win32' },
    store,
    now: new Date('2026-10-27T09:00:00.000Z'),
    meta: {
      mode: 'hub',
      role: 'hub',
      hub: { connected: true, relay: { enabled: true, state: 'starting', error: null } },
    },
  });

  assert.deepEqual(board.hub.relay, { enabled: true, state: 'starting', error: null });
});

test('buildBoard：纯函数默认值、local: 前缀、sources 带 deviceId、relay/config 默认', () => {
  const now = new Date('2026-10-27T09:00:00.000Z');
  const store = { listDevices: () => [], getSnapshots: () => [] };

  const board = buildBoard({
    local: {
      generatedAt: now.toISOString(),
      tookMs: 12,
      sources: [
        {
          id: 'obsidian-main',
          kind: 'markdown',
          label: '主库',
          path: 'C:\\x',
          files: 1,
          count: 1,
          open: 1,
          done: 0,
          error: null,
        },
      ],
      // 故意只给最少字段：buildBoard 要补齐 v1 白名单
      todos: [{ id: 'md:x:1', text: '最少字段', cancelled: true }],
      config: { includeDshTodos: false, markdownRootCount: 1 },
    },
    localDevice: { name: 'leo', platform: 'win32' },
    store,
    now,
  });

  assert.equal(board.ok, true);
  assert.equal(board.version, 2);
  assert.equal(board.mode, 'hub');
  assert.equal(board.role, 'hub');
  assert.equal(board.device.id, 'local');
  assert.equal(board.device.name, 'leo');
  assert.equal(board.device.platform, 'win32');
  assert.equal(board.generatedAt, now.toISOString());
  assert.equal(board.tookMs, 12);
  assert.deepEqual(board.hub, {
    connected: true,
    lastSyncAt: null,
    error: null,
    relay: { enabled: false, state: 'disabled', error: null },
  });
  assert.deepEqual(board.config, {
    includeDshTodos: false,
    markdownRootCount: 1,
    syncIntervalMs: 60_000,
  });
  assert.deepEqual(board.sources, [
    {
      id: 'obsidian-main',
      kind: 'markdown',
      label: '主库',
      path: 'C:\\x',
      files: 1,
      count: 1,
      open: 1,
      done: 0,
      error: null,
      deviceId: 'local',
    },
  ]);

  assert.equal(board.todos.length, 1);
  const todo = board.todos[0];
  assert.equal(todo.id, 'local:md:x:1');
  assert.equal(todo.deviceId, 'local');
  assert.equal(todo.deviceName, 'leo');
  assert.equal(todo.local, true);
  assert.equal(todo.cancelled, true);
  assert.equal(todo.done, false);
  for (const field of V1_FIELDS) assert.ok(Object.hasOwn(todo, field), `缺少字段 ${field}`);

  assert.deepEqual(board.stats, {
    total: 1,
    open: 0,
    done: 0,
    cancelled: 1,
    overdue: 0,
    dueToday: 0,
    dueSoon: 0,
    undated: 0,
  });
  assert.deepEqual(board.devices, [
    {
      id: 'local',
      name: 'leo',
      platform: 'win32',
      version: null,
      online: true,
      lastSeen: now.toISOString(),
      lastPush: null,
      todoCount: 1,
      local: true,
    },
  ]);
});
