/**
 * leo-status v0.4.0 · 会话 todo 精筛 + 建议箱（纯 Node / ESM / 零第三方依赖）
 *
 * 对应 `leo-status/CONTRACT-V4.md` §3：
 *   - 精筛：把 scan snapshot 里 kind==='dsh' 的会话 todo 按确定性规则分成
 *     wrapup / relevant / noise，并给出 accept / review / noise 桶与中文理由。
 *   - 建议箱：`<dataDir>/suggestions.json` 持久化 pending/accepted/dismissed/removed。
 *
 * 设计约束：
 *   - 分类与派生是**纯函数、无 IO**（便于单测与复用）；
 *   - 存储层用 `.tmp` + rename 原子写；坏 JSON 容忍为空；dismissed/accepted/removed
 *     **不复活**（mergeDerived 以 pending 为基线，非 pending 的历史 id 一律跳过）；
 *   - 不依赖 DSH，不联网，不读 scan.js。
 */

import { promises as fsp } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

/* ------------------------------------------------------------------ */
/* 导出常量                                                            */
/* ------------------------------------------------------------------ */

export const SUGGESTION_VERSION = 1;

export const DEFAULT_FILTER = Object.freeze({
  enabled: true,
  acceptScore: 0.55,
  reviewScore: 0.35,
  skipSubagentSessions: true,
});

const STATUSES = new Set(['pending', 'accepted', 'dismissed', 'removed']);

/* ------------------------------------------------------------------ */
/* 正则 / 词表                                                         */
/* ------------------------------------------------------------------ */

// 子代理/队友会话：这些 todo 是 agent 的工作项，不该进用户的建议箱。
const SUBAGENT_TITLE_RE = /research teammate|subagent|teammate|研究队友|^you are (a|an)\s/i;

// 会话标题/任务文本里的 agent 编排噪声
const NOISE_SUBSTR_RE = [
  /task-\d/i,
  /return\s+.*summary/i,
  /you are a .*teammate/i,
  /spawn .*teammate/i,
];

// 英文开头命令式（仅当文本完全不含中文时生效）
const NOISE_START_RE = [
  /^research\s+/i,
  /^read\s+/i,
  /^explore\s+/i,
  /^investigate\s+/i,
  /^implement\s+/i,
  /^write\b.*\breport\b/i,
  /^update todo list\b/i,
  /^verify\s+/i,
];

// 纯工具步骤：动词 + 单个路径/文件，且整条只有这一截
const ONLY_VERB_PATH_RE =
  /^(?:read|write|edit|open|list|run|exec(?:ute)?|scan|search|grep|find|cat|ls|check|test|build|install|deploy|update|create|delete|move|copy|apply|patch)\s+(?:\S*[\\/]\S+|\S+\.(?:md|mjs|cjs|js|ts|json|txt|log|ya?ml|toml|py|sh|ps1))$/i;

const WRAPUP_CN = [
  '收尾',
  '收口',
  '收束',
  '整理',
  '归档',
  '提交',
  '推送',
  '发布',
  '部署',
  '上线',
  '验证',
  '核验',
  '确认',
  '检查',
  '修复',
  '回复',
  '反馈',
  '清理',
  '总结',
  '复盘',
  '记录',
  '同步',
  '补测试',
  '补文档',
  '写文档',
  '更新文档',
];

const WRAPUP_EN_RE =
  /\b(?:wrap up|finalize|verify|test|commit|push|release|deploy|publish|cleanup|follow up|reply|respond|fix|document|update docs|readme)\b/i;

const PROJECT_WORDS = [
  'leo-status',
  'leo',
  '阿源',
  'co-align',
  '看板',
  '插件',
  'obsidian',
  '笔记',
  '论文',
  '汇报',
  '记忆',
  '对话助手',
  'dsh',
  'plugin',
  'agent',
  'todo',
];

// 预编译英文项目词的 \b 正则；中文词用 includes。
const PROJECT_EN_RE = new Map(
  PROJECT_WORDS.filter((word) => /^[a-z]/i.test(word)).map((word) => [
    word,
    new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i'),
  ]),
);

const INTENT_WORDS = [
  '我想',
  '我要',
  '我需要',
  '我打算',
  '我计划',
  '我决定',
  '应该',
  '记得',
  '别忘了',
  '想要',
];

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeText(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim();
}

function hasCJK(text) {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(text);
}

function clamp01(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** 统一解析 filter：支持 opts 直接带阈值，也支持 opts.filter。 */
function resolveFilter(opts) {
  const raw = isPlainObject(opts) ? opts : {};
  const source = isPlainObject(raw.filter) ? raw.filter : raw;
  return {
    enabled: source.enabled !== false,
    acceptScore: clamp01(source.acceptScore, DEFAULT_FILTER.acceptScore),
    reviewScore: clamp01(source.reviewScore, DEFAULT_FILTER.reviewScore),
    skipSubagentSessions:
      source.skipSubagentSessions === undefined ? DEFAULT_FILTER.skipSubagentSessions : source.skipSubagentSessions !== false,
  };
}

function isDoneTodo(todo) {
  return todo.done === true || todo.status === 'completed';
}

function isCancelledTodo(todo) {
  return todo.cancelled === true || todo.status === 'cancelled';
}

/* ------------------------------------------------------------------ */
/* 分类（纯函数）                                                      */
/* ------------------------------------------------------------------ */

function noiseResult(normalized, reason) {
  return { kind: 'noise', score: 0.1, bucket: 'noise', reasons: [reason], normalized };
}

/**
 * 判断一条文本是否命中 noise 规则。
 * 返回命中的中文理由，未命中返回 null。
 */
function noiseReasonOf(normalized) {
  if (normalized === '') return '过短';

  const lower = normalized.toLowerCase();
  for (const re of NOISE_SUBSTR_RE) {
    if (re.test(lower)) return '代理任务文本';
  }

  if ([...normalized].length < 4) return '过短';
  if (normalized.startsWith('/') || normalized.startsWith('<')) return '工具步骤';
  if (!hasCJK(normalized) && ONLY_VERB_PATH_RE.test(normalized)) return '工具步骤';
  if (!hasCJK(normalized) && NOISE_START_RE.some((re) => re.test(normalized))) return '命令式步骤';
  return null;
}

function wrapupHit(normalized) {
  for (const word of WRAPUP_CN) {
    if (normalized.includes(word)) return word;
  }
  if (WRAPUP_EN_RE.test(normalized)) return true;
  return null;
}

function projectWordHit(normalized) {
  for (const word of PROJECT_WORDS) {
    const re = PROJECT_EN_RE.get(word);
    if (re !== undefined) {
      if (re.test(normalized)) return word;
    } else if (normalized.includes(word)) {
      return word;
    }
  }
  return null;
}

function intentHit(normalized) {
  for (const word of INTENT_WORDS) {
    if (normalized.includes(word)) return word;
  }
  return null;
}

/**
 * 会话 todo 精筛（契约 §3.2）。纯函数、无 IO。
 *
 * @param {object} todo scan snapshot 里的 kind==='dsh' todo
 * @param {object} [opts] { filter } 或 { acceptScore, reviewScore, skipSubagentSessions }
 * @returns {{kind:'wrapup'|'relevant'|'noise', score:number, bucket:'accept'|'review'|'noise', reasons:string[], normalized:string}}
 */
export function classifySessionTodo(todo, opts = {}) {
  const src = isPlainObject(todo) ? todo : {};
  const normalized = normalizeText(src.text);
  const filter = resolveFilter(opts);

  // 1) 子代理会话：整会话视为噪声（derived 里会整会话跳过）
  const sessionTitle = typeof src.sessionTitle === 'string' ? src.sessionTitle : '';
  if (filter.skipSubagentSessions && SUBAGENT_TITLE_RE.test(sessionTitle)) {
    return noiseResult(normalized, '子代理会话');
  }

  // 2) noise 优先：命中直接 0.1，不再累计其他信号
  const reason = noiseReasonOf(normalized);
  if (reason !== null) return noiseResult(normalized, reason);

  // 3) 打分：wrapup +0.6（封顶 0.6）、项目词 +0.25、第一人称意图 +0.25
  const wrapup = wrapupHit(normalized);
  const projectWord = projectWordHit(normalized);
  const intentWord = intentHit(normalized);

  if (wrapup === null && projectWord === null && intentWord === null) {
    return { kind: 'noise', score: 0, bucket: 'noise', reasons: ['低置信'], normalized };
  }

  const rawScore =
    (wrapup === null ? 0 : 0.6) + (projectWord === null ? 0 : 0.25) + (intentWord === null ? 0 : 0.25);
  const score = Math.min(1, Math.round(rawScore * 100) / 100);

  const kind = wrapup !== null ? 'wrapup' : 'relevant';
  const reasons = [];
  if (wrapup !== null) reasons.push('收尾类');
  if (projectWord !== null) reasons.push(`与你相关：${projectWord}`);
  if (intentWord !== null) reasons.push('你亲口说的');

  let bucket = 'noise';
  if (score >= filter.acceptScore) bucket = 'accept';
  else if (score >= filter.reviewScore) bucket = 'review';

  if (bucket !== 'accept' && reasons.length < 3) reasons.push('低置信');

  return {
    kind,
    score,
    bucket,
    reasons: reasons.slice(0, 3),
    normalized,
  };
}

/**
 * 稳定建议 id：`sug:` + sha1(sessionId + '\u0000' + normalized).slice(0,16)。
 */
export function suggestionId(todo) {
  const src = isPlainObject(todo) ? todo : {};
  const sessionId =
    typeof src.sessionId === 'string' ? src.sessionId : src.sessionId === undefined || src.sessionId === null ? '' : String(src.sessionId);
  const normalized = normalizeText(src.text);
  const hash = crypto
    .createHash('sha1')
    .update(`${sessionId}\u0000${normalized}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
  return `sug:${hash}`;
}

/* ------------------------------------------------------------------ */
/* 派生建议                                                            */
/* ------------------------------------------------------------------ */

function sessionKeyOf(todo) {
  return typeof todo.sessionId === 'string' && todo.sessionId !== '' ? todo.sessionId : 'unknown-session';
}

/**
 * 从 scan snapshot 派生建议（契约 §3.1）。
 *
 * @param {object} snapshot scan.aggregate 的 Snapshot
 * @param {{filter?: object, now?: number|Date}} [options]
 * @returns {{items: object[], stats: {total:number,accept:number,review:number,noise:number,skippedSessions:number}, skipped: object[]}}
 */
export function deriveSuggestions(snapshot, options = {}) {
  const opts = isPlainObject(options) ? options : {};
  const filter = resolveFilter(opts.filter === undefined ? opts : opts.filter);

  const empty = () => ({
    items: [],
    stats: { total: 0, accept: 0, review: 0, noise: 0, skippedSessions: 0 },
    skipped: [],
  });
  if (filter.enabled === false) return empty();

  const rawNow = opts.now instanceof Date ? opts.now.getTime() : opts.now;
  const nowMs = typeof rawNow === 'number' && Number.isFinite(rawNow) ? rawNow : Date.now();
  const createdAt = new Date(nowMs).toISOString();

  const todos = isPlainObject(snapshot) && Array.isArray(snapshot.todos) ? snapshot.todos : [];
  const skippedMap = new Map();
  const records = [];
  const indexById = new Map();

  for (const todo of todos) {
    if (!isPlainObject(todo) || todo.kind !== 'dsh') continue;
    if (isDoneTodo(todo) || isCancelledTodo(todo)) continue;

    const sessionTitle = typeof todo.sessionTitle === 'string' ? todo.sessionTitle : '';
    const sessionId = typeof todo.sessionId === 'string' ? todo.sessionId : null;

    // 子代理会话整会话跳过（只记一条 skipped）
    if (filter.skipSubagentSessions && SUBAGENT_TITLE_RE.test(sessionTitle)) {
      const key = sessionId !== null ? sessionId : `title:${sessionTitle}`;
      if (!skippedMap.has(key)) {
        skippedMap.set(key, { sessionId, title: sessionTitle === '' ? null : sessionTitle, reason: '子代理会话' });
      }
      continue;
    }

    const classified = classifySessionTodo(todo, { filter });
    if (classified.normalized === '') continue;

    const record = {
      id: suggestionId(todo),
      text: typeof todo.text === 'string' ? todo.text.trim() : classified.normalized,
      normalized: classified.normalized,
      sessionId,
      sessionTitle: sessionTitle === '' ? null : sessionTitle,
      project: typeof todo.project === 'string' ? todo.project : null,
      kind: classified.kind,
      score: classified.score,
      bucket: classified.bucket,
      reasons: classified.reasons.slice(),
      status: 'pending',
      source: 'session',
      createdAt,
    };

    // 同一 id（同会话 + 同文本）去重：保留分数更高的一条。
    const existingIndex = indexById.get(record.id);
    if (existingIndex !== undefined) {
      if (record.score > records[existingIndex].score) records[existingIndex] = record;
      continue;
    }
    indexById.set(record.id, records.length);
    records.push(record);
  }

  // 会话级兜底：同一会话 accept > 6，只保留分数最高的 6 条，其余降为 review。
  const acceptsBySession = new Map();
  for (const record of records) {
    if (record.bucket !== 'accept') continue;
    const key = record.sessionId === null ? 'unknown-session' : record.sessionId;
    if (!acceptsBySession.has(key)) acceptsBySession.set(key, []);
    acceptsBySession.get(key).push(record);
  }
  for (const list of acceptsBySession.values()) {
    if (list.length <= 6) continue;
    const sorted = list
      .slice()
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    for (const record of sorted.slice(6)) {
      record.bucket = 'review';
      // 保留前 2 条理由，补一条限额说明（最多 3 条）
      record.reasons = [...record.reasons.slice(0, 2), '同会话限额'].slice(0, 3);
    }
  }

  const stats = { total: records.length, accept: 0, review: 0, noise: 0, skippedSessions: 0 };
  const items = [];
  for (const record of records) {
    if (record.bucket === 'accept') stats.accept += 1;
    else if (record.bucket === 'review') stats.review += 1;
    else stats.noise += 1;
    if (record.bucket !== 'noise') items.push(record);
  }

  const skipped = [...skippedMap.values()];
  stats.skippedSessions = skipped.length;
  return { items, stats, skipped };
}

/* ------------------------------------------------------------------ */
/* 建议箱存储                                                          */
/* ------------------------------------------------------------------ */

function cloneItem(item) {
  return structuredClone(item);
}

function normalizeStoredItem(raw) {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id === '') return null;
  const status = STATUSES.has(raw.status) ? raw.status : 'pending';
  const item = { ...raw, status };
  if (typeof item.text !== 'string') item.text = '';
  if (typeof item.normalized !== 'string') item.normalized = normalizeText(item.text);
  if (typeof item.score !== 'number' || !Number.isFinite(item.score)) item.score = 0;
  if (!Array.isArray(item.reasons)) item.reasons = [];
  return item;
}

async function writeJsonAtomic(target, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = `${target}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    await fsp.writeFile(tmp, text, { mode: 0o600 });
    await fsp.rename(tmp, target);
  } catch (error) {
    try {
      await fsp.unlink(tmp);
    } catch {
      /* tmp 可能从未创建 */
    }
    throw error;
  }
}

/**
 * 建议箱存储（契约 §3.1）。写入 `<dataDir>/suggestions.json`，原子写。
 *
 * 读写模型与 hub.js 一致：`await load()` 一次后，其余方法同步操作内存，
 * 写盘在后台串行排队（`flush()` 可选等待落盘，测试用）。
 *
 * @param {string} dataDir
 */
export function createSuggestionStore(dataDir) {
  if (typeof dataDir !== 'string' || dataDir.trim() === '') {
    throw new TypeError('createSuggestionStore: dataDir must be a non-empty string');
  }
  const rootDir = path.resolve(dataDir);
  const file = path.join(rootDir, 'suggestions.json');

  /** @type {object[]} */
  let items = [];
  let loadPromise = null;
  let writeChain = Promise.resolve();

  async function doLoad() {
    await fsp.mkdir(rootDir, { recursive: true, mode: 0o700 });
    let doc = null;
    try {
      doc = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch {
      doc = null; // 缺失 / 坏 JSON => 空建议箱
    }
    const rawItems = isPlainObject(doc) && Array.isArray(doc.items) ? doc.items : [];
    items = rawItems.map(normalizeStoredItem).filter((item) => item !== null);
  }

  function load() {
    if (loadPromise === null) {
      loadPromise = doLoad().catch((error) => {
        loadPromise = null;
        throw error;
      });
    }
    return loadPromise;
  }

  function schedulePersist() {
    const payload = { version: SUGGESTION_VERSION, items: items.map((item) => ({ ...item })) };
    const task = () => writeJsonAtomic(file, payload);
    writeChain = writeChain.catch(() => {}).then(task);
    // Keep the rejection observable to flush(), without an unhandled-rejection crash.
    writeChain.catch(() => {});
    return writeChain;
  }

  function snapshot() {
    return { version: SUGGESTION_VERSION, items: items.map((item) => cloneItem(item)) };
  }

  function list(status = 'pending') {
    const filterStatus = status === undefined ? 'pending' : status;
    const selected = filterStatus === 'all' ? items : items.filter((item) => item.status === filterStatus);
    return selected.map((item) => cloneItem(item));
  }

  function get(id) {
    const item = items.find((entry) => entry.id === id);
    return item === undefined ? null : cloneItem(item);
  }

  /**
   * 以 pending 为基线合并派生建议：
   *  - 新 id → 新增 pending（added 数组）
   *  - 已有 pending → 刷新派生字段（kept = 合并后的全部 pending）
   *  - 已有 accepted/dismissed/removed → 跳过，不复活（dismissed 数组）
   *
   * 返回值是**条目数组**（`added`/`kept`/`dismissed`），index.js 会直接
   * `merged.added.map(item => item.id)` 使用；数组长度即各项计数。
   */
  function mergeDerived(derivedItems) {
    const input = Array.isArray(derivedItems) ? derivedItems : [];
    const byId = new Map(items.map((item) => [item.id, item]));
    const added = [];
    const dismissed = [];
    let changed = false;

    for (const raw of input) {
      if (!isPlainObject(raw) || typeof raw.id !== 'string' || raw.id === '') continue;
      const existing = byId.get(raw.id);

      if (existing !== undefined) {
        if (existing.status === 'pending') {
          for (const key of ['text', 'normalized', 'sessionId', 'sessionTitle', 'project', 'kind', 'score', 'bucket', 'origin', 'due', 'scheduled', 'priority', 'tags', 'links']) {
            if (raw[key] !== undefined && existing[key] !== raw[key]) {
              existing[key] = raw[key];
              changed = true;
            }
          }
          if (Array.isArray(raw.reasons) && JSON.stringify(raw.reasons) !== JSON.stringify(existing.reasons)) {
            existing.reasons = raw.reasons.slice();
            changed = true;
          }
        } else {
          dismissed.push(cloneItem(existing));
        }
        continue;
      }

      const item = normalizeStoredItem({ ...raw, status: 'pending' });
      if (item === null) continue;
      if (typeof item.createdAt !== 'string' || item.createdAt === '') {
        item.createdAt = new Date().toISOString();
      }
      items.push(item);
      byId.set(item.id, item);
      added.push(cloneItem(item));
      changed = true;
    }

    if (changed) schedulePersist();
    const kept = items.filter((item) => item.status === 'pending').map((item) => cloneItem(item));
    return { added, kept, dismissed };
  }

  function transition(id, status, timeKey) {
    const item = items.find((entry) => entry.id === id);
    if (item === undefined) return null;
    item.status = status;
    if (typeof timeKey === 'string') item[timeKey] = new Date().toISOString();
    schedulePersist();
    return cloneItem(item);
  }

  function accept(id) {
    const existing = items.find((entry) => entry.id === id);
    if (!existing || (existing.status !== 'pending' && existing.status !== 'accepted')) return null;
    return transition(id, 'accepted', 'acceptedAt');
  }

  function dismiss(id) {
    if (!items.some((entry) => entry.id === id && entry.status === 'pending')) return null;
    return transition(id, 'dismissed', 'dismissedAt');
  }

  function act(id, action) {
    const item = items.find((entry) => entry.id === id && entry.status === 'accepted');
    if (!item) return null;
    if (action === 'delete') { remove(id); return cloneItem(item); }
    if (!['done', 'undone', 'cancel', 'restore'].includes(action)) return null;
    if (action === 'done') { item.done = true; item.cancelled = false; }
    if (action === 'undone') item.done = false;
    if (action === 'cancel') { item.cancelled = true; item.done = false; }
    if (action === 'restore') item.cancelled = false;
    item.updatedAt = new Date().toISOString();
    schedulePersist();
    return cloneItem(item);
  }

  /** 软删除（status='removed'），保证 mergeDerived 不会把用户删掉的建议再带回来。 */
  function remove(id) {
    const item = items.find((entry) => entry.id === id);
    if (item === undefined) return false;
    item.status = 'removed';
    item.removedAt = new Date().toISOString();
    schedulePersist();
    return true;
  }

  /** 等待已排队的写盘完成（测试/退出前用；非契约必需）。 */
  function flush() {
    return writeChain;
  }

  return {
    file,
    load,
    snapshot,
    list,
    get,
    mergeDerived,
    accept,
    dismiss,
    remove,
    act,
    flush,
  };
}
