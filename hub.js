/**
 * leo-status v2 · 中心模块（纯 Node：ESM / Node 24 / 无第三方依赖）
 *
 * 职责（对应 `leo-status/CONTRACT-V2.md` §2/§3/§4/§5）：
 *   - createHubStore(dataDir)   设备表 + 快照存储（原子写、容错读）
 *   - buildBoard(opts)          纯函数：本机 + 各设备快照 => Board
 *   - createHubHandler(opts)    (req,res)=>Promise<void>：Hub HTTP API
 *   - startHubServer(opts)      只绑 127.0.0.1 的 http.Server，端口 0 可用
 *
 * 读写模型：
 *   - 存储层：`load()` 一次性把 `<dataDir>/hub/devices.json` 与
 *     `<dataDir>/hub/snapshots/*.json` 读入内存（坏 JSON / 缺失一律当空）。
 *   - `listDevices()/getDevice()/getSnapshots()` 是**同步**内存读，保证
 *     `buildBoard` 可以是无 I/O 的纯函数；调用前请先 `await store.load()`。
 *   - 写方法是 async：先更新内存，再排队 `写 .tmp -> rename`（mode 0600）。
 *
 * 只读写 `<dataDir>/hub/` 下的文件；不依赖 DSH、不联网。
 */

import { promises as fsp } from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

const BOARD_VERSION = 2;
const HUB_VERSION = 2;
const DEVICES_FILE_VERSION = 1;
const DEFAULT_SYNC_INTERVAL_MS = 60_000;
const MIN_ONLINE_WINDOW_MS = 180_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MiB
const MAX_NAME_LENGTH = 60;
const MAX_REMARK_LENGTH = 60;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/; // 同时是文件名安全字符集
const DAY_MS = 86_400_000;
const HOST = '127.0.0.1';
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const STAT_KEYS = ['total', 'open', 'done', 'cancelled', 'overdue', 'dueToday', 'dueSoon', 'undated'];

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * v1 todo 字段白名单（契约 §2/§5）：24 个字段全部输出，缺省为 null / [] / false。
 * 存储与 board 合并共用同一份逻辑，保证「只存白名单字段」。
 */
function sanitizeTodo(todo, index) {
  const src = isPlainObject(todo) ? todo : {};
  return {
    id: typeof src.id === 'string' && src.id !== '' ? src.id : `todo-${index}`,
    kind: typeof src.kind === 'string' ? src.kind : null,
    text: typeof src.text === 'string' ? src.text : '',
    raw: typeof src.raw === 'string' ? src.raw : null,
    done: src.done === true,
    cancelled: src.cancelled === true,
    sourceId: typeof src.sourceId === 'string' ? src.sourceId : null,
    sourceLabel: typeof src.sourceLabel === 'string' ? src.sourceLabel : null,
    obsidianVault: src.obsidianVault === true,
    file: typeof src.file === 'string' ? src.file : null,
    relPath: typeof src.relPath === 'string' ? src.relPath : null,
    line: Number.isInteger(src.line) ? src.line : null,
    heading: typeof src.heading === 'string' ? src.heading : null,
    indent: Number.isInteger(src.indent) ? src.indent : 0,
    noteDate: typeof src.noteDate === 'string' ? src.noteDate : null,
    due: typeof src.due === 'string' ? src.due : null,
    scheduled: typeof src.scheduled === 'string' ? src.scheduled : null,
    start: typeof src.start === 'string' ? src.start : null,
    priority: typeof src.priority === 'string' ? src.priority : null,
    tags: Array.isArray(src.tags) ? src.tags.filter((tag) => typeof tag === 'string') : [],
    links: Array.isArray(src.links) ? src.links.filter((link) => typeof link === 'string') : [],
    recurrence: typeof src.recurrence === 'string' ? src.recurrence : null,
    sessionId: typeof src.sessionId === 'string' ? src.sessionId : null,
    sessionTitle: typeof src.sessionTitle === 'string' ? src.sessionTitle : null,
    project: typeof src.project === 'string' ? src.project : null,
    // v0.4：发现来源 / 可写性（旧快照缺省时按 markdown=可写、dsh=不可写兜底）
    discoveredBy: typeof src.discoveredBy === 'string' ? src.discoveredBy : null,
    writable:
      src.writable === undefined || src.writable === null
        ? src.kind === 'markdown'
        : src.writable === true,
    confidence:
      typeof src.confidence === 'number' && Number.isFinite(src.confidence)
        ? src.confidence
        : src.kind === 'markdown'
          ? 1
          : 1,
    headingStatus: typeof src.headingStatus === 'string' ? src.headingStatus : null,
    evidence: src.evidence?.kind === 'user-message' && src.evidence?.sourceKind === 'user'
      ? { kind: 'user-message', sourceKind: 'user', seq: Number(src.evidence.seq) || 0,
          quote: String(src.evidence.quote || '').slice(0, 600) } : null,
  };
}

function nowIso() {
  return new Date().toISOString();
}

/** 按 Unicode 码点截断（避免把 emoji 劈成两半）。 */
function clipText(value, max) {
  if (typeof value !== 'string') return '';
  return [...value].slice(0, max).join('');
}

function trimmedText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isoOrNull(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

function clone(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

function randomDeviceId() {
  return crypto.randomBytes(12).toString('hex'); // 24 hex
}

function parseTimeMs(value) {
  if (typeof value !== 'string' || value === '') return Number.NaN;
  return Date.parse(value);
}

/* ------------------------------------------------------------------ */
/* 存储层                                                              */
/* ------------------------------------------------------------------ */

/**
 * @param {string} dataDir 数据根目录（`<dataDir>/hub/...` 由本模块创建）
 */
export function createHubStore(dataDir) {
  if (typeof dataDir !== 'string' || dataDir.trim() === '') {
    throw new TypeError('createHubStore: dataDir must be a non-empty string');
  }

  const rootDir = path.resolve(dataDir);
  const hubDir = path.join(rootDir, 'hub');
  const snapshotsDir = path.join(hubDir, 'snapshots');
  const devicesFile = path.join(hubDir, 'devices.json');

  /** @type {Map<string, object>} */
  let devices = new Map();
  /** @type {Map<string, object>} */
  let snapshots = new Map();
  let loadPromise = null;

  // 所有写盘串行化：保证 .tmp -> rename 的顺序与调用顺序一致（并发 push 安全）。
  let writeQueue = Promise.resolve();
  let tmpCounter = 0;

  function snapshotPath(deviceId) {
    if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) return null;
    return path.join(snapshotsDir, `${deviceId}.json`);
  }

  function enqueueWrite(task) {
    const run = writeQueue.then(task, task);
    writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * 原子写 JSON：mkdir -p -> 写「唯一 .tmp」（0600）-> rename 覆盖。
   * 唯一 tmp 名避免并发写同一目标时互相覆盖半截内容。
   */
  async function writeJsonAtomic(target, value) {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    const tmp = `${target}.${process.pid}-${(tmpCounter += 1)}-${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    let handle = null;
    try {
      handle = await fsp.open(tmp, 'w', 0o600);
      await handle.writeFile(text, 'utf8');
      await handle.close();
      handle = null;
      await fsp.rename(tmp, target);
    } catch (error) {
      if (handle !== null) {
        try {
          await handle.close();
        } catch {
          /* ignore */
        }
      }
      try {
        await fsp.unlink(tmp);
      } catch {
        /* tmp 可能从未创建 */
      }
      throw error;
    }
  }

  async function readJson(file) {
    let text;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      return null; // 坏 JSON 容忍为空
    }
  }

  function normalizeDevice(raw, fallbackId) {
    const src = isPlainObject(raw) ? raw : {};
    const id = typeof src.id === 'string' && src.id !== '' ? src.id : fallbackId;
    if (typeof id !== 'string' || !DEVICE_ID_RE.test(id)) return null;
    return {
      id,
      name: trimmedText(src.name) === '' ? id : clipText(src.name.trim(), MAX_NAME_LENGTH),
      platform: typeof src.platform === 'string' ? src.platform : null,
      pluginVersion: typeof src.pluginVersion === 'string' ? src.pluginVersion : null,
      firstSeen: isoOrNull(src.firstSeen),
      lastSeen: isoOrNull(src.lastSeen),
      lastPush: isoOrNull(src.lastPush),
      remark: typeof src.remark === 'string' ? clipText(src.remark, MAX_REMARK_LENGTH) : null,
    };
  }

  function sanitizeStats(raw) {
    if (!isPlainObject(raw)) return null;
    const out = {};
    for (const key of STAT_KEYS) {
      out[key] = typeof raw[key] === 'number' && Number.isFinite(raw[key]) ? raw[key] : 0;
    }
    return out;
  }

  function normalizeSnapshot(raw, deviceId) {
    const src = isPlainObject(raw) ? raw : {};
    return {
      deviceId,
      receivedAt: typeof src.receivedAt === 'string' ? src.receivedAt : nowIso(),
      generatedAt: isoOrNull(src.generatedAt),
      platform: typeof src.platform === 'string' ? src.platform : null,
      pluginVersion: typeof src.pluginVersion === 'string' ? src.pluginVersion : null,
      todos: Array.isArray(src.todos) ? src.todos.map((todo, index) => sanitizeTodo(todo, index)) : [],
      stats: sanitizeStats(src.stats),
      sources: Array.isArray(src.sources) ? src.sources.filter((item) => isPlainObject(item)) : [],
    };
  }

  function deviceList() {
    return [...devices.values()].map((device) => ({ ...device }));
  }

  function snapshotList() {
    return [...snapshots.values()].map((snapshot) => clone(snapshot));
  }

  async function persistDevices() {
    const doc = {
      version: DEVICES_FILE_VERSION,
      devices: Object.fromEntries([...devices.entries()].map(([id, device]) => [id, { ...device }])),
    };
    await enqueueWrite(() => writeJsonAtomic(devicesFile, doc));
  }

  async function doLoad() {
    await fsp.mkdir(snapshotsDir, { recursive: true, mode: 0o700 });

    devices = new Map();
    const devicesDoc = await readJson(devicesFile);
    if (isPlainObject(devicesDoc) && isPlainObject(devicesDoc.devices)) {
      for (const [id, raw] of Object.entries(devicesDoc.devices)) {
        const device = normalizeDevice(raw, id);
        if (device !== null) devices.set(device.id, device);
      }
    }

    snapshots = new Map();
    let entries = [];
    try {
      entries = await fsp.readdir(snapshotsDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
      const id = entry.name.slice(0, -5);
      if (!DEVICE_ID_RE.test(id)) continue;
      const raw = await readJson(path.join(snapshotsDir, entry.name));
      if (!isPlainObject(raw)) continue; // 坏 JSON 容忍：快照当不存在
      snapshots.set(id, normalizeSnapshot(raw, id));
    }
  }

  /** 幂等加载：所有读写方法都会先等它（同步读方法需调用方先 await 一次）。 */
  function load() {
    if (loadPromise === null) {
      loadPromise = doLoad().catch((error) => {
        loadPromise = null;
        throw error;
      });
    }
    return loadPromise;
  }

  async function upsertDevice(input) {
    await load();
    const src = isPlainObject(input) ? input : {};
    const id = src.id;
    if (typeof id !== 'string' || !DEVICE_ID_RE.test(id)) {
      throw new Error('hub store: invalid device id');
    }
    const existing = devices.get(id) ?? null;
    const base = existing === null ? { id } : { ...existing };
    // 只覆盖显式传入的字段（undefined 视为未提供）。
    if (src.name !== undefined) base.name = src.name;
    if (src.platform !== undefined) base.platform = src.platform;
    if (src.pluginVersion !== undefined) base.pluginVersion = src.pluginVersion;
    if (src.firstSeen !== undefined) base.firstSeen = src.firstSeen;
    if (src.lastSeen !== undefined) base.lastSeen = src.lastSeen;
    if (src.lastPush !== undefined) base.lastPush = src.lastPush;
    if (src.remark !== undefined) base.remark = src.remark;
    const device = normalizeDevice(base, id);
    if (device === null) throw new Error('hub store: invalid device record');
    devices.set(id, device);
    await persistDevices();
    return { ...device };
  }

  async function setRemark(deviceId, remark) {
    await load();
    if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) return null;
    const existing = devices.get(deviceId);
    if (existing === undefined) return null;
    existing.remark =
      typeof remark === 'string' ? clipText(remark, MAX_REMARK_LENGTH) : null;
    await persistDevices();
    return { ...existing };
  }

  async function removeDevice(deviceId) {
    await load();
    if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) return false;
    const hadDevice = devices.delete(deviceId);
    const hadSnapshot = snapshots.delete(deviceId);
    if (hadDevice) await persistDevices();
    const file = snapshotPath(deviceId);
    if (file !== null) {
      try {
        await fsp.unlink(file);
      } catch {
        /* 快照本来就不存在 */
      }
    }
    return hadDevice || hadSnapshot;
  }

  async function saveSnapshot(deviceId, snapshot) {
    await load();
    if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) {
      throw new Error('hub store: invalid device id');
    }
    const record = normalizeSnapshot(snapshot, deviceId);
    snapshots.set(deviceId, record);
    const file = snapshotPath(deviceId);
    if (file === null) throw new Error('hub store: invalid snapshot path');
    const payload = clone(record);
    await enqueueWrite(() => writeJsonAtomic(file, payload));
    return clone(record);
  }

  function listDevices() {
    return deviceList();
  }

  function getDevice(deviceId) {
    if (typeof deviceId !== 'string') return null;
    const device = devices.get(deviceId);
    return device === undefined ? null : { ...device };
  }

  function getSnapshots() {
    return snapshotList();
  }

  /**
   * 删除 `receivedAt < beforeMs` 的快照（设备记录保留）。
   * @returns {Promise<string[]>} 被删除快照的 deviceId 列表
   */
  async function prune(beforeMs) {
    await load();
    const cutoff = typeof beforeMs === 'number' && Number.isFinite(beforeMs) ? beforeMs : 0;
    const removed = [];
    for (const [id, snapshot] of [...snapshots.entries()]) {
      const received = parseTimeMs(snapshot.receivedAt);
      if (Number.isFinite(received) && received >= cutoff) continue;
      snapshots.delete(id);
      removed.push(id);
      const file = snapshotPath(id);
      if (file !== null) {
        try {
          await fsp.unlink(file);
        } catch {
          /* ignore */
        }
      }
    }
    return removed;
  }

  return {
    load,
    listDevices,
    getDevice,
    upsertDevice,
    setRemark,
    removeDevice,
    saveSnapshot,
    getSnapshots,
    prune,
  };
}

/* ------------------------------------------------------------------ */
/* Board（纯函数）                                                     */
/* ------------------------------------------------------------------ */

function buildStats(todos, now) {
  const stats = {
    total: todos.length,
    open: 0,
    done: 0,
    cancelled: 0,
    overdue: 0,
    dueToday: 0,
    dueSoon: 0,
    undated: 0,
  };
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  for (const todo of todos) {
    // 口径同 v1（scan.js buildStats）：done / cancelled 各自计数，open 排除它们。
    if (todo.done) {
      stats.done += 1;
      continue;
    }
    if (todo.cancelled) {
      stats.cancelled += 1;
      continue;
    }
    stats.open += 1;
    if (todo.due === null || todo.due === undefined || todo.due === '') {
      stats.undated += 1;
      continue;
    }
    const parts = String(todo.due).split('-').map(Number);
    const dueLocal = new Date(parts[0], parts[1] - 1, parts[2]);
    const diffDays = Math.round((dueLocal.getTime() - today.getTime()) / DAY_MS);
    if (diffDays < 0) stats.overdue += 1;
    else if (diffDays === 0) stats.dueToday += 1;
    else if (diffDays <= 7) stats.dueSoon += 1;
  }

  return stats;
}

function normalizeRelay(input) {
  const src = isPlainObject(input) ? input : {};
  const enabled = src.enabled === true;
  const rawState = typeof src.state === 'string' ? src.state : '';
  let state = 'disabled';
  if (enabled) {
    // 'starting' 是隧道 spawn 后 ~2s 内的真实状态（index.js 生命周期），不能归一成 stopped。
    state = rawState === 'running' || rawState === 'starting' || rawState === 'stopped' ? rawState : 'stopped';
  } else if (rawState !== '') state = rawState;
  return {
    enabled,
    state,
    error: typeof src.error === 'string' && src.error !== '' ? src.error : null,
  };
}

function mergeTodo(todo, index, { idPrefix, deviceId, deviceName, local }) {
  const clean = sanitizeTodo(todo, index);
  return {
    ...clean,
    id: `${idPrefix}${clean.id}`,
    deviceId,
    deviceName,
    local,
  };
}

/**
 * 纯函数：把本机快照 + 各设备快照合并成一个 Board（契约 §5）。
 *
 * @param {object} opts
 * @param {object} [opts.local]         本机 v1 Snapshot（scan.aggregate 的结果）
 * @param {object} [opts.localDevice]   { id?, name?, platform?, version?, lastSeen? }
 * @param {object} [opts.store]         createHubStore(...) 的返回值（同步读）
 * @param {Date}   [opts.now]           在线判断/统计用的当前时间
 * @param {number} [opts.syncIntervalMs]
 * @param {object} [opts.meta]          { mode?, role?, hub?, relay?, config?, generatedAt?, tookMs? }
 * @returns {object} Board
 */
export function buildBoard(opts) {
  const options = isPlainObject(opts) ? opts : {};
  const local = isPlainObject(options.local) ? options.local : {};
  const localDevice = isPlainObject(options.localDevice) ? options.localDevice : {};
  const store = isPlainObject(options.store) ? options.store : null;
  const now =
    options.now instanceof Date && !Number.isNaN(options.now.getTime()) ? options.now : new Date();
  const nowMsTime = now.getTime();
  const meta = isPlainObject(options.meta) ? options.meta : {};
  const metaConfig = isPlainObject(meta.config) ? meta.config : {};
  const localConfig = isPlainObject(local.config) ? local.config : {};

  const rawInterval = options.syncIntervalMs;
  const syncIntervalMs =
    typeof rawInterval === 'number' && Number.isFinite(rawInterval) && rawInterval > 0
      ? rawInterval
      : DEFAULT_SYNC_INTERVAL_MS;
  const onlineWindowMs = Math.max(3 * syncIntervalMs, MIN_ONLINE_WINDOW_MS);

  const localName = trimmedText(localDevice.name) === '' ? 'local' : clipText(localDevice.name.trim(), MAX_NAME_LENGTH);
  const localPlatform =
    typeof localDevice.platform === 'string'
      ? localDevice.platform
      : typeof process !== 'undefined' && process && typeof process.platform === 'string'
        ? process.platform
        : null;
  const localDeviceId =
    typeof localDevice.id === 'string' && localDevice.id !== '' ? localDevice.id : 'local';
  const localVersion = typeof localDevice.version === 'string' ? localDevice.version : null;

  const localTodos = Array.isArray(local.todos) ? local.todos : [];
  const todos = localTodos.map((todo, index) =>
    mergeTodo(todo, index, {
      idPrefix: 'local:',
      deviceId: 'local',
      deviceName: localName,
      local: true,
    }),
  );

  // 本地设备永远在线；lastSeen 表示本机快照生成时间。
  const localLastSeen =
    typeof localDevice.lastSeen === 'string'
      ? localDevice.lastSeen
      : typeof local.generatedAt === 'string'
        ? local.generatedAt
        : now.toISOString();

  const devices = [
    {
      id: 'local',
      name: localName,
      platform: localPlatform,
      version: localVersion,
      online: true,
      lastSeen: localLastSeen,
      lastPush: null,
      todoCount: localTodos.length,
      local: true,
    },
  ];

  const snapshotsById = new Map();
  if (store !== null && typeof store.getSnapshots === 'function') {
    let list = [];
    try {
      list = store.getSnapshots();
    } catch {
      list = [];
    }
    if (Array.isArray(list)) {
      for (const snapshot of list) {
        if (isPlainObject(snapshot) && typeof snapshot.deviceId === 'string') {
          snapshotsById.set(snapshot.deviceId, snapshot);
        }
      }
    }
  }

  let remoteDevices = [];
  if (store !== null && typeof store.listDevices === 'function') {
    let list = [];
    try {
      list = store.listDevices();
    } catch {
      list = [];
    }
    if (Array.isArray(list)) {
      remoteDevices = list.filter((device) => isPlainObject(device) && device.id !== 'local');
    }
  }

  // 本机第一，其余按 name 本地化排序（同 name 用 id 保证稳定）。
  remoteDevices.sort((a, b) => {
    const byName = String(a.name ?? '').localeCompare(String(b.name ?? ''), 'zh');
    if (byName !== 0) return byName;
    return String(a.id ?? '').localeCompare(String(b.id ?? ''), 'zh');
  });

  for (const device of remoteDevices) {
    const deviceId = device.id;
    const snapshot = snapshotsById.get(deviceId);
    const remoteTodos = snapshot !== undefined && Array.isArray(snapshot.todos) ? snapshot.todos : [];
    const deviceName = trimmedText(device.remark) !== '' ? device.remark : trimmedText(device.name) !== '' ? device.name : deviceId;
    remoteTodos.forEach((todo, index) => {
      todos.push(
        mergeTodo(todo, index, {
          idPrefix: `${deviceId}:`,
          deviceId,
          deviceName,
          local: false,
        }),
      );
    });

    const lastSeenMs = parseTimeMs(device.lastSeen);
    devices.push({
      id: deviceId,
      name: deviceName,
      platform: typeof device.platform === 'string' ? device.platform : null,
      version: typeof device.pluginVersion === 'string' ? device.pluginVersion : null,
      online: Number.isFinite(lastSeenMs) && nowMsTime - lastSeenMs <= onlineWindowMs,
      lastSeen: isoOrNull(device.lastSeen),
      lastPush: isoOrNull(device.lastPush),
      todoCount: remoteTodos.length,
      local: false,
    });
  }

  const sources = (Array.isArray(local.sources) ? local.sources : [])
    .filter((source) => isPlainObject(source))
    .map((source) => ({ ...source, deviceId: 'local' }));

  const mode =
    meta.mode === 'local' || meta.mode === 'hub' || meta.mode === 'device'
      ? meta.mode
      : 'hub';
  const role = typeof meta.role === 'string' && meta.role !== '' ? meta.role : mode;

  const metaHub = isPlainObject(meta.hub) ? meta.hub : {};
  const relayInput = isPlainObject(meta.relay)
    ? meta.relay
    : isPlainObject(metaHub.relay)
      ? metaHub.relay
      : {};

  const hub = {
    connected: metaHub.connected === undefined ? true : metaHub.connected === true,
    lastSyncAt: isoOrNull(metaHub.lastSyncAt),
    error: typeof metaHub.error === 'string' && metaHub.error !== '' ? metaHub.error : null,
    relay: normalizeRelay(relayInput),
  };

  const config = {
    includeDshTodos:
      typeof metaConfig.includeDshTodos === 'boolean'
        ? metaConfig.includeDshTodos
        : localConfig.includeDshTodos === true,
    markdownRootCount:
      typeof metaConfig.markdownRootCount === 'number' && Number.isFinite(metaConfig.markdownRootCount)
        ? metaConfig.markdownRootCount
        : typeof localConfig.markdownRootCount === 'number' && Number.isFinite(localConfig.markdownRootCount)
          ? localConfig.markdownRootCount
          : 0,
    syncIntervalMs,
  };

  const tookMs =
    typeof meta.tookMs === 'number' && Number.isFinite(meta.tookMs)
      ? meta.tookMs
      : typeof local.tookMs === 'number' && Number.isFinite(local.tookMs)
        ? local.tookMs
        : 0;

  return {
    ok: true,
    version: BOARD_VERSION,
    generatedAt: typeof meta.generatedAt === 'string' ? meta.generatedAt : now.toISOString(),
    tookMs,
    mode,
    role,
    device: {
      id: localDeviceId,
      name: localName,
      platform: localPlatform,
    },
    hub,
    devices,
    sources,
    todos,
    stats: buildStats(todos, now),
    config,
  };
}

/* ------------------------------------------------------------------ */
/* HTTP handler                                                        */
/* ------------------------------------------------------------------ */

function sendJson(res, status, body, extraHeaders) {
  if (!res || res.writableEnded || res.destroyed === true) return;
  let text;
  try {
    text = JSON.stringify(body === undefined ? {} : body);
  } catch {
    text = '{"ok":false,"error":"internal error"}';
    status = 500;
  }
  const headers = {
    ...JSON_HEADERS,
    'content-length': String(Buffer.byteLength(text)),
    ...(extraHeaders === undefined ? {} : extraHeaders),
  };
  try {
    if (!res.headersSent) res.writeHead(status, headers);
    res.end(text);
  } catch {
    try {
      res.end();
    } catch {
      /* 连接已断开 */
    }
  }
}

/** 定长摘要 + timingSafeEqual：长度不同也不会抛，且不因提前返回泄露长度。 */
function safeEqual(left, right) {
  const digest = (value) =>
    crypto.createHash('sha256').update(String(value), 'utf8').digest();
  return crypto.timingSafeEqual(digest(left), digest(right));
}

function isAuthorized(req, password) {
  if (typeof password !== 'string' || password === '') return false;
  const header = req && req.headers ? req.headers.authorization : undefined;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  return safeEqual(match[1].trim(), password);
}

function collectBody(req, limit) {
  return new Promise((resolve) => {
    let size = 0;
    let tooLarge = false;
    let settled = false;
    const chunks = [];

    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
    };
    const settle = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    function onData(chunk) {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return; // 继续 drain，保证客户端能收到 413 而不是连接重置
      }
      chunks.push(chunk);
    }
    function onEnd() {
      if (tooLarge) {
        settle({ ok: false, status: 413, error: 'payload too large' });
        return;
      }
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') {
        settle({ ok: false, status: 400, error: 'invalid json' });
        return;
      }
      try {
        settle({ ok: true, value: JSON.parse(text) });
      } catch {
        settle({ ok: false, status: 400, error: 'invalid json' });
      }
    }
    function onError() {
      settle({ ok: false, status: 400, error: 'request aborted' });
    }
    function onAborted() {
      settle({ ok: false, status: 400, error: 'request aborted' });
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

/**
 * 创建 Hub HTTP handler。
 *
 * @param {object} opts
 * @param {string} opts.password            Bearer 密码；空字符串 => 所有受保护端点 401
 * @param {object} opts.store              createHubStore(...)
 * @param {Function} [opts.boardProvider]  () => Board | Promise<Board>
 * @param {Function} [opts.log]
 * @param {number} [opts.syncIntervalMs]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createHubHandler(opts) {
  const options = isPlainObject(opts) ? opts : {};
  const store = options.store;
  if (!store || typeof store !== 'object') {
    throw new TypeError('createHubHandler: store is required');
  }
  const password = typeof options.password === 'string' ? options.password : '';
  const boardProvider = typeof options.boardProvider === 'function' ? options.boardProvider : null;
  const yuanChat = typeof options.yuanChat === 'function' ? options.yuanChat : null;
  const yuanRequest = typeof options.yuanRequest === 'function' ? options.yuanRequest : null;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const syncIntervalMs =
    typeof options.syncIntervalMs === 'number' &&
    Number.isFinite(options.syncIntervalMs) &&
    options.syncIntervalMs > 0
      ? options.syncIntervalMs
      : DEFAULT_SYNC_INTERVAL_MS;

  if (password === '') log('[hub] 未配置密码：所有受保护端点将返回 401');

  async function ensureLoaded() {
    if (typeof store.load === 'function') await store.load();
  }

  async function readJsonBody(req, res) {
    const result = await collectBody(req, MAX_BODY_BYTES);
    if (!result.ok) {
      sendJson(res, result.status, { ok: false, error: result.error });
      return null;
    }
    return { value: result.value };
  }

  function deviceIdFromMatch(raw) {
    let decoded;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return null;
    }
    return typeof decoded === 'string' && DEVICE_ID_RE.test(decoded) ? decoded : null;
  }

  async function handleJoin(req, res) {
    const body = await readJsonBody(req, res);
    if (body === null) return;
    const data = body.value;
    if (!isPlainObject(data)) {
      sendJson(res, 400, { ok: false, error: 'invalid body' });
      return;
    }

    let deviceId;
    if (data.deviceId === undefined || data.deviceId === null || data.deviceId === '') {
      deviceId = randomDeviceId();
    } else if (typeof data.deviceId === 'string' && DEVICE_ID_RE.test(data.deviceId)) {
      deviceId = data.deviceId;
    } else {
      sendJson(res, 400, { ok: false, error: 'invalid deviceId' });
      return;
    }

    const now = nowIso();
    const existing = typeof store.getDevice === 'function' ? store.getDevice(deviceId) : null;
    const name = clipText(trimmedText(data.name), MAX_NAME_LENGTH);

    await store.upsertDevice({
      id: deviceId,
      name: name !== '' ? name : existing !== null && typeof existing.name === 'string' ? existing.name : deviceId,
      platform: typeof data.platform === 'string' ? data.platform : existing !== null ? existing.platform : null,
      pluginVersion:
        typeof data.pluginVersion === 'string'
          ? data.pluginVersion
          : existing !== null
            ? existing.pluginVersion
            : null,
      firstSeen: existing !== null && existing.firstSeen ? existing.firstSeen : now,
      lastSeen: now,
      lastPush: existing !== null ? existing.lastPush : null,
      remark: existing !== null ? existing.remark : null,
    });

    sendJson(res, 200, {
      ok: true,
      deviceId,
      hubTime: now,
      syncIntervalMs,
    });
  }

  async function handlePush(req, res) {
    const body = await readJsonBody(req, res);
    if (body === null) return;
    const data = body.value;
    if (!isPlainObject(data)) {
      sendJson(res, 400, { ok: false, error: 'invalid body' });
      return;
    }
    if (typeof data.deviceId !== 'string' || !DEVICE_ID_RE.test(data.deviceId)) {
      sendJson(res, 400, { ok: false, error: 'invalid deviceId' });
      return;
    }
    const snapshot = data.snapshot;
    if (!isPlainObject(snapshot) || !Array.isArray(snapshot.todos)) {
      sendJson(res, 400, { ok: false, error: 'snapshot.todos must be an array' });
      return;
    }

    const deviceId = data.deviceId;
    const receivedAt = nowIso();
    const existing = typeof store.getDevice === 'function' ? store.getDevice(deviceId) : null;
    const name = clipText(trimmedText(data.name), MAX_NAME_LENGTH);

    const record = {
      deviceId,
      receivedAt,
      generatedAt: typeof snapshot.generatedAt === 'string' ? snapshot.generatedAt : null,
      platform:
        typeof data.platform === 'string' ? data.platform : existing !== null ? existing.platform : null,
      pluginVersion:
        typeof data.pluginVersion === 'string'
          ? data.pluginVersion
          : existing !== null
            ? existing.pluginVersion
            : null,
      todos: snapshot.todos, // 存储层会按 v1 白名单过滤
      stats: isPlainObject(snapshot.stats) ? snapshot.stats : null,
      sources: Array.isArray(snapshot.sources) ? snapshot.sources : [],
    };

    await store.saveSnapshot(deviceId, record);
    await store.upsertDevice({
      id: deviceId,
      name:
        name !== ''
          ? name
          : existing !== null && typeof existing.name === 'string'
            ? existing.name
            : deviceId,
      platform: record.platform,
      pluginVersion: record.pluginVersion,
      firstSeen: existing !== null && existing.firstSeen ? existing.firstSeen : receivedAt,
      lastSeen: receivedAt,
      lastPush: receivedAt,
      remark: existing !== null ? existing.remark : null,
    });

    sendJson(res, 200, {
      ok: true,
      receivedAt,
      todoCount: snapshot.todos.length,
    });
  }

  async function handleBoard(req, res) {
    if (boardProvider === null) {
      sendJson(res, 500, { ok: false, error: 'board unavailable' });
      return;
    }
    const board = await boardProvider();
    if (!isPlainObject(board)) {
      sendJson(res, 500, { ok: false, error: 'board unavailable' });
      return;
    }
    sendJson(res, 200, board);
  }

  async function handleRemark(deviceId, req, res) {
    const body = await readJsonBody(req, res);
    if (body === null) return;
    const data = body.value;
    if (!isPlainObject(data) || typeof data.remark !== 'string') {
      sendJson(res, 400, { ok: false, error: 'remark must be a string' });
      return;
    }
    const device = await store.setRemark(deviceId, data.remark);
    if (device === null) {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }
    sendJson(res, 200, { ok: true, device });
  }

  async function handleDelete(deviceId, req, res) {
    await store.removeDevice(deviceId);
    sendJson(res, 200, { ok: true });
  }

  return async function hubHandler(req, res) {
    try {
      const method = typeof req.method === 'string' ? req.method.toUpperCase() : '';
      let pathname = '/';
      try {
        pathname = new URL(typeof req.url === 'string' && req.url !== '' ? req.url : '/', 'http://localhost')
          .pathname;
      } catch {
        pathname = '/';
      }

      // 1) 探活：免鉴权、不返回设备细节。
      if (pathname === '/api/health') {
        if (method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' }, { allow: 'GET' });
          return;
        }
        await ensureLoaded();
        const devices = typeof store.listDevices === 'function' ? store.listDevices() : [];
        sendJson(res, 200, {
          ok: true,
          version: HUB_VERSION,
          role: 'hub',
          time: nowIso(),
          devices: Array.isArray(devices) ? devices.length : 0,
        });
        return;
      }

      // 2) 其余端点一律 Bearer 鉴权。
      if (!isAuthorized(req, password)) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      await ensureLoaded();

      // 3) 路由匹配：未知 404，方法不符 405。
      if (pathname === '/api/join') {
        if (method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' }, { allow: 'POST' });
          return;
        }
        await handleJoin(req, res);
        return;
      }
      if (pathname === '/api/push') {
        if (method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' }, { allow: 'POST' });
          return;
        }
        await handlePush(req, res);
        return;
      }
      if (pathname === '/api/board') {
        if (method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' }, { allow: 'GET' });
          return;
        }
        await handleBoard(req, res);
        return;
      }
      if (yuanRequest !== null && pathname.startsWith('/api/yuan/')) {
        const route = pathname.slice('/api/yuan/'.length);
        const reads = new Set(['state', 'signals', 'activity', 'sessions']);
        const writes = new Set(['open', 'propose', 'memory/query', 'memory/change', 'memory/note', 'memory/capture', 'chat', 'stop', 'suggestion/accept', 'suggestion/dismiss', 'remember', 'memory/delete', 'memory/accept', 'reminder', 'reminder/done', 'seen', 'todo/action']);
        if (!reads.has(route) && !writes.has(route)) { sendJson(res, 404, { ok: false, error: 'not found' }); return; }
        if (method !== (reads.has(route) ? 'GET' : 'POST')) { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return; }
        const body = reads.has(route) ? { value: {} } : await readJsonBody(req, res);
        if (body === null) return;
        try { sendJson(res, 200, await yuanRequest(route, body.value)); }
        catch (error) { sendJson(res, 400, { ok: false, error: String(error?.message || error) }); }
        return;
      }
      if (yuanChat !== null && pathname === '/api/yuan/chat') {
        if (method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' }, { allow: 'POST' });
          return;
        }
        const body = await readJsonBody(req, res);
        if (body === null) return;
        const data = isPlainObject(body.value) ? body.value : {};
        const message = typeof data.message === 'string' ? data.message.trim() : '';
        if (message === '') {
          sendJson(res, 400, { ok: false, error: 'message is empty' });
          return;
        }
        try {
          const result = await yuanChat(message);
          sendJson(res, 200, {
            ok: true,
            reply: typeof result?.reply === 'string' ? result.reply : '',
            tools: Array.isArray(result?.tools) ? result.tools : [],
            usedAgent: result?.usedAgent === true,
          });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
        return;
      }

      const remarkMatch = /^\/api\/devices\/([^/]+)\/remark$/.exec(pathname);
      if (remarkMatch !== null) {
        if (method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' }, { allow: 'POST' });
          return;
        }
        const deviceId = deviceIdFromMatch(remarkMatch[1]);
        if (deviceId === null) {
          sendJson(res, 400, { ok: false, error: 'invalid deviceId' });
          return;
        }
        await handleRemark(deviceId, req, res);
        return;
      }

      const deviceMatch = /^\/api\/devices\/([^/]+)$/.exec(pathname);
      if (deviceMatch !== null) {
        if (method !== 'DELETE') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' }, { allow: 'DELETE' });
          return;
        }
        const deviceId = deviceIdFromMatch(deviceMatch[1]);
        if (deviceId === null) {
          sendJson(res, 400, { ok: false, error: 'invalid deviceId' });
          return;
        }
        await handleDelete(deviceId, req, res);
        return;
      }

      sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (error) {
      log('[hub] request failed:', error && error.message ? error.message : String(error));
      // 只回固定文案，绝不把堆栈/内部细节传给客户端。
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' });
      else {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
    }
  };
}

/* ------------------------------------------------------------------ */
/* HTTP server                                                         */
/* ------------------------------------------------------------------ */

/**
 * 启动只绑 127.0.0.1 的 hub server。
 *
 * @param {object} opts
 * @param {number} [opts.port] 0 => 随机端口
 * @param {Function} opts.handler (req,res)=>Promise<void>
 * @param {Function} [opts.log]
 * @returns {Promise<{url: string, close: () => Promise<void>, server: import('node:http').Server}>}
 */
export async function startHubServer(opts) {
  const options = isPlainObject(opts) ? opts : {};
  const port = Number.isInteger(options.port) && options.port >= 0 ? options.port : 8790;
  const handler = options.handler;
  if (typeof handler !== 'function') {
    throw new TypeError('startHubServer: handler must be a function');
  }
  const log = typeof options.log === 'function' ? options.log : () => {};

  const server = http.createServer((req, res) => {
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((error) => {
        log('[hub] unhandled request error:', error && error.message ? error.message : String(error));
        if (!res.headersSent) {
          const text = JSON.stringify({ ok: false, error: 'internal error' });
          try {
            res.writeHead(500, {
              ...JSON_HEADERS,
              'content-length': String(Buffer.byteLength(text)),
            });
            res.end(text);
          } catch {
            /* ignore */
          }
        } else {
          try {
            res.end();
          } catch {
            /* ignore */
          }
        }
      });
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });

  const address = server.address();
  const actualPort =
    address !== null && typeof address === 'object' && typeof address.port === 'number'
      ? address.port
      : port;
  const url = `http://${HOST}:${actualPort}`;

  let closePromise = null;
  const close = () => {
    if (closePromise !== null) return closePromise;
    closePromise = new Promise((resolve) => {
      server.close(() => resolve());
      // 主动断开 keep-alive / 残留连接，避免 close 永远不 resolve。
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    });
    return closePromise;
  };

  log('[hub] listening on', url);
  return { url, close, server };
}
