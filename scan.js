/**
 * leo-status · 纯数据层（ESM / Node 24 / 无第三方依赖）
 *
 * 导出：
 *   DEFAULTS                         完整默认配置
 *   EMPTY_STATS                      空统计对象（index.js 错误兜底用）
 *   normalizeConfig(raw)             校验并补全配置，非法抛 Error('leo-status config: ...')
 *   aggregate(config, opts)          => Snapshot；opts = { now?: Date, force?: boolean }
 *
 * 只读扫描：Markdown 文件树 + DSH session todos。
 * 遵守 leo-status/CONTRACT.md §2/§3/§4。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

export const DEFAULTS = {
  // 中性默认：具体笔记目录写在本机 <dataDir>/settings.json（不进仓库、不含个人路径）
  markdownRoots: [],
  includeDshTodos: true,
  includeDshCompleted: false,
  dshCacheDir: '', // 空 => <DSH_HOME>/storages/session_projcache/sessions
  excludeDirs: [
    '.obsidian',
    '.git',
    '.trash',
    'node_modules',
    'obsd_attch',
    'obs_attch',
    'attachments',
    '_history',
    '00legacy',
    '_论文',
  ],
  excludeSuffixes: ['.excalidraw.md'],
  maxFileBytes: 1_500_000,
  maxFiles: 20000,
  dshMaxSessions: 300,
  cacheTtlMs: 15000, // aggregate 内存缓存；force=true 绕过
};

export const EMPTY_STATS = Object.freeze({
  total: 0,
  open: 0,
  done: 0,
  cancelled: 0,
  overdue: 0,
  dueToday: 0,
  dueSoon: 0,
  undated: 0,
});

export const SNAPSHOT_VERSION = 1;

const FILE_LIMIT_ERROR = '文件数超过上限';
const DSH_SOURCE_ID = 'dsh-sessions';
const DSH_SOURCE_LABEL = 'DSH 会话 (AI 抽取)';

const PRIORITY_EMOJI = {
  '🔺': 'highest',
  '⏫': 'highest',
  '🔼': 'high',
  '🔽': 'low',
  '⏬': 'lowest',
};

const PRIORITY_BY_TAG = {
  p1: 'highest',
  p2: 'high',
  p3: 'medium',
  p4: 'low',
};

const PRIORITY_RANK = {
  highest: 5,
  high: 4,
  medium: 3,
  low: 2,
  lowest: 1,
};

const DATE_EMOJI_FIELD = {
  '📅': 'due',
  '⏳': 'scheduled',
  '🛫': 'start',
  '✅': null, // 完成日期：仅从 text 中剔除
};

// 契约 §3 的复选框正则（允许缩进 / 引用 / - * + / 有序列表 / [ ] [x] [X] [-] [/]）
const CHECKBOX_RE = /^(?<indent>[ \t]*)(?:>\s*)?(?:[-*+]|\d+[.)])\s+\[(?<mark>[ xX\-\/])\]\s?(?<rest>.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_OPEN_RE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^\s{0,3}(`{3,}|~{3,})\s*$/;
const TAG_RE = /#[\p{L}\p{N}_\-/]+/gu;
const LINK_RE = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;

const DAY_MS = 86_400_000;

/* ------------------------------------------------------------------ */
/* 配置校验                                                            */
/* ------------------------------------------------------------------ */

function configError(message) {
  return new Error(`leo-status config: ${message}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function defaultRootLabel(rootPath) {
  const cleaned = String(rootPath).replace(/[\\/]+$/, '');
  try {
    return path.basename(cleaned) || cleaned;
  } catch {
    return cleaned;
  }
}

function normalizeRoots(value) {
  if (value === undefined) {
    return DEFAULTS.markdownRoots.map((root) => ({ ...root }));
  }
  if (!Array.isArray(value)) throw configError('markdownRoots 必须是数组');
  return value.map((item, index) => {
    if (!isPlainObject(item)) throw configError(`markdownRoots[${index}] 必须是对象`);
    const rootPath = item.path;
    if (typeof rootPath !== 'string' || rootPath.trim() === '') {
      throw configError(`markdownRoots[${index}].path 必须是非空字符串`);
    }
    let id = `obsidian-${index + 1}`;
    if (item.id !== undefined && item.id !== null) {
      if (typeof item.id !== 'string') throw configError(`markdownRoots[${index}].id 必须是字符串`);
      if (item.id.trim() !== '') id = item.id.trim();
    }
    let label = defaultRootLabel(rootPath);
    if (item.label !== undefined && item.label !== null) {
      if (typeof item.label !== 'string') throw configError(`markdownRoots[${index}].label 必须是字符串`);
      if (item.label.trim() !== '') label = item.label.trim();
    }
    return { id, label, path: rootPath };
  });
}

function normalizeBoolean(value, fallback, name) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw configError(`${name} 必须是布尔值`);
  return value;
}

function normalizeString(value, fallback, name) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw configError(`${name} 必须是字符串`);
  return value;
}

function normalizeStringArray(value, fallback, name) {
  if (value === undefined) return fallback.slice();
  if (!Array.isArray(value)) throw configError(`${name} 必须是字符串数组`);
  return value.map((item, index) => {
    if (typeof item !== 'string') throw configError(`${name}[${index}] 必须是字符串`);
    return item;
  });
}

function normalizeNumber(value, fallback, name, { min = -Infinity, integer = false } = {}) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw configError(`${name} 必须是有限数字`);
  }
  if (integer && !Number.isInteger(value)) throw configError(`${name} 必须是整数`);
  if (value < min) throw configError(`${name} 必须 >= ${min}`);
  return value;
}

/**
 * 校验并补全配置。undefined / null 返回完整默认配置的深拷贝。
 * 非法值抛 Error('leo-status config: ...')。
 */
export function normalizeConfig(raw) {
  const input = raw === undefined || raw === null ? {} : raw;
  if (!isPlainObject(input)) throw configError('配置必须是对象');

  return {
    markdownRoots: normalizeRoots(input.markdownRoots),
    includeDshTodos: normalizeBoolean(input.includeDshTodos, DEFAULTS.includeDshTodos, 'includeDshTodos'),
    includeDshCompleted: normalizeBoolean(
      input.includeDshCompleted,
      DEFAULTS.includeDshCompleted,
      'includeDshCompleted',
    ),
    dshCacheDir: normalizeString(input.dshCacheDir, DEFAULTS.dshCacheDir, 'dshCacheDir'),
    excludeDirs: normalizeStringArray(input.excludeDirs, DEFAULTS.excludeDirs, 'excludeDirs'),
    excludeSuffixes: normalizeStringArray(input.excludeSuffixes, DEFAULTS.excludeSuffixes, 'excludeSuffixes'),
    maxFileBytes: normalizeNumber(input.maxFileBytes, DEFAULTS.maxFileBytes, 'maxFileBytes', { min: 1 }),
    maxFiles: normalizeNumber(input.maxFiles, DEFAULTS.maxFiles, 'maxFiles', { min: 1, integer: true }),
    dshMaxSessions: normalizeNumber(input.dshMaxSessions, DEFAULTS.dshMaxSessions, 'dshMaxSessions', {
      min: 0,
      integer: true,
    }),
    cacheTtlMs: normalizeNumber(input.cacheTtlMs, DEFAULTS.cacheTtlMs, 'cacheTtlMs', { min: 0 }),
  };
}

/* ------------------------------------------------------------------ */
/* 日期工具                                                            */
/* ------------------------------------------------------------------ */

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

function formatDate(year, month, day) {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

/** 严格校验 YYYY-MM-DD 真实日期（2026-02-30 => null）。 */
function normalizeDateString(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  return makeValidDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

/** 用本地日历构造日期并校验回读（避免 2 月 30 日之类的溢出）。 */
function makeValidDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1000 || year > 9999) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return formatDate(year, month, day);
}

/** 文件名里最近的 20xx 目录名（由近及远）。 */
function findYearInPath(relPath) {
  const parts = String(relPath).split('/');
  parts.pop(); // 去掉文件名
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const match = /(20\d\d)/.exec(parts[index]);
    if (match) return Number(match[1]);
  }
  return null;
}

/**
 * noteDate 三级推断（契约 §3）：
 *   1. 文件名 YYYY-MM-DD
 *   2. 文件名 M.D，年份取路径中最近的 20xx 目录，否则当前年
 *   3. null
 */
function inferNoteDate(relPath, now) {
  const base = String(relPath || '').split('/').pop() || '';

  let match = /^(\d{4})-(\d{2})-(\d{2})/.exec(base);
  if (match) {
    const date = makeValidDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (date) return date;
  }

  match = /^(\d{1,2})\.(\d{1,2})(?:\D|$)/.exec(base);
  if (match) {
    let year = findYearInPath(relPath);
    if (year === null) {
      year = now instanceof Date && !Number.isNaN(now.getTime()) ? now.getFullYear() : new Date().getFullYear();
    }
    const date = makeValidDate(year, Number(match[1]), Number(match[2]));
    if (date) return date;
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Markdown 单行元数据解析                                             */
/* ------------------------------------------------------------------ */

function betterPriority(current, next) {
  if (!next) return current;
  if (!current) return next;
  return PRIORITY_RANK[next] > PRIORITY_RANK[current] ? next : current;
}

/**
 * 解析复选框行 rest 部分：抽取并剥离所有元数据，返回干净 text 与各字段。
 * 元数据可任意顺序出现。
 */
function parseTodoMetadata(rest) {
  let work = rest;

  let due = null;
  let scheduled = null;
  let start = null;
  let priority = null;
  let recurrence = null;
  const tags = [];
  const links = [];
  const seenTags = new Set();
  const seenLinks = new Set();

  const assignDate = (field, rawDate) => {
    const date = normalizeDateString(rawDate);
    if (!date) return;
    if (field === 'due') {
      if (due === null) due = date;
    } else if (field === 'scheduled') {
      if (scheduled === null) scheduled = date;
    } else if (field === 'start') {
      if (start === null) start = date;
    }
  };

  // 1. emoji 日期标记（📅/⏳/🛫/✅，允许无空格与 VS16）
  work = work.replace(/(📅|⏳|🛫|✅)\uFE0F?\s*(\d{4}-\d{2}-\d{2})/gu, (full, emoji, rawDate) => {
    assignDate(DATE_EMOJI_FIELD[emoji], rawDate);
    return ' ';
  });
  // 剩下的孤立 emoji 标记（后面不是标准日期）也剔除标记本身
  work = work.replace(/(?:📅|⏳|🛫|✅)\uFE0F?\s*/gu, ' ');

  // 2. @due(...) / [due:: ...] / due:: ...
  work = work.replace(/@due\(\s*([^)]*?)\s*\)/gi, (full, rawDate) => {
    assignDate('due', rawDate);
    return ' ';
  });
  work = work.replace(/\[\s*due::\s*([^\]]*?)\s*\]/gi, (full, rawDate) => {
    assignDate('due', rawDate);
    return ' ';
  });
  work = work.replace(/due::\s*([^\s\]]+)/gi, (full, rawDate) => {
    assignDate('due', rawDate);
    return ' ';
  });

  // 3. 优先级 emoji
  work = work.replace(/(🔺|⏫|🔼|🔽|⏬)/gu, (emoji) => {
    priority = betterPriority(priority, PRIORITY_EMOJI[emoji]);
    return ' ';
  });

  // 4. wikilink（先于 tags，避免 [[x#标题]] 里的 # 被当 tag）
  work = work.replace(LINK_RE, (full, inner) => {
    const text = inner.trim();
    if (text && !seenLinks.has(text)) {
      seenLinks.add(text);
      links.push(text);
    }
    return ' ';
  });

  // 5. tags（纯数字 #123 不算 tag）
  work = work.replace(TAG_RE, (tag) => {
    const name = tag.slice(1);
    if (name && !/^\d+$/.test(name) && !seenTags.has(name)) {
      seenTags.add(name);
      tags.push(name);
      const tagPriority = PRIORITY_BY_TAG[name.toLowerCase()];
      if (tagPriority) priority = betterPriority(priority, tagPriority);
    }
    return ' ';
  });

  // 6. 循环：🔁 之后的整段剩余文本
  const recurrenceIndex = work.indexOf('🔁');
  if (recurrenceIndex !== -1) {
    const tail = work.slice(recurrenceIndex + '🔁'.length).trim();
    recurrence = tail === '' ? null : tail;
    work = work.slice(0, recurrenceIndex);
  }

  // 7. 干净 text；整体被 ~~…~~ 包裹 => 作废并去掉外层 ~~
  //    空任务（清理后 text === ''）由调用方直接丢弃，不回退原始 rest。
  let text = work.replace(/\s+/g, ' ').trim();
  let cancelled = false;
  if (text.length >= 4 && text.startsWith('~~') && text.endsWith('~~')) {
    text = text.slice(2, -2).trim();
    cancelled = true;
  }

  return { text, cancelled, due, scheduled, start, priority, tags, links, recurrence };
}

/* ------------------------------------------------------------------ */
/* Markdown 文件内容解析                                               */
/* ------------------------------------------------------------------ */

/**
 * 解析一个 Markdown 文件的全部内容。
 * @returns {Array<object>} todo 列表（不含 source 汇总）
 */
function parseMarkdownContent(content, ctx) {
  const out = [];
  if (typeof content !== 'string' || content === '') return out;

  const lines = content.split(/\r?\n/);
  let cursor = 0;

  // 文件首 YAML frontmatter：--- ... ---
  const firstLine = lines.length > 0 ? lines[0].replace(/^\uFEFF/, '') : '';
  if (firstLine.trim() === '---') {
    for (let index = 1; index < lines.length; index += 1) {
      if (lines[index].trim() === '---') {
        cursor = index + 1;
        break;
      }
    }
  }

  const noteDate = inferNoteDate(ctx.relPath, ctx.now);
  const headingStack = []; // { level, text }
  let fence = null; // { char, len }

  for (let index = cursor; index < lines.length; index += 1) {
    const line = lines[index];

    // fenced code block：围栏内一律不解析；未闭合则一直到文件尾
    if (fence) {
      const closing = FENCE_CLOSE_RE.exec(line);
      if (closing && closing[1][0] === fence.char && closing[1].length >= fence.len) {
        fence = null;
      }
      continue;
    }
    const opening = FENCE_OPEN_RE.exec(line);
    if (opening) {
      const char = opening[1][0];
      const info = opening[2];
      // CommonMark：反引号围栏的 info 不允许再出现反引号
      if (!(char === '`' && info.includes('`'))) {
        fence = { char, len: opening[1].length };
        continue;
      }
    }

    // 标题栈
    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2].replace(/#+\s*$/, '').trim();
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }
      headingStack.push({ level, text });
      continue;
    }

    // 复选框
    const checkbox = CHECKBOX_RE.exec(line);
    if (!checkbox) continue;

    const indentRaw = checkbox.groups.indent || '';
    // 制表符算一层；空格每 2 个算一层
    const indent = Math.floor(indentRaw.replace(/\t/g, '  ').length / 2);
    const mark = checkbox.groups.mark;
    const rest = checkbox.groups.rest ?? '';
    const meta = parseTodoMetadata(rest);

    // 契约 §3：去掉元数据后 text 为空 => 空任务直接丢弃（不回退空文本）
    if (meta.text === '') continue;

    // 契约 §3：[x]/[X] 只算 done；[-]/[/] 与整体 ~~…~~ 包裹都算 cancelled（优先于 done）
    const cancelled = meta.cancelled || mark === '-' || mark === '/';
    const done = (mark === 'x' || mark === 'X') && !cancelled;

    const headingText = headingStack
      .map((item) => item.text)
      .filter((text) => text !== '')
      .join(' > ');

    out.push({
      id: `md:${ctx.sourceId}:${ctx.relPath}:${index + 1}`,
      kind: 'markdown',
      text: meta.text,
      raw: line.slice(0, 500),
      done,
      cancelled,
      sourceId: ctx.sourceId,
      sourceLabel: ctx.sourceLabel,
      file: ctx.absPath,
      relPath: ctx.relPath,
      line: index + 1,
      heading: headingText === '' ? null : headingText,
      indent,
      noteDate,
      due: meta.due,
      scheduled: meta.scheduled,
      start: meta.start,
      priority: meta.priority,
      tags: meta.tags,
      links: meta.links,
      recurrence: meta.recurrence,
      sessionId: null,
      sessionTitle: null,
      project: null,
    });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* 文件系统错误描述                                                    */
/* ------------------------------------------------------------------ */

function describeFsError(kind, target, error) {
  const code = error && typeof error === 'object' ? error.code : '';
  if (code === 'ENOENT') return `${kind}不存在: ${target}`;
  if (code === 'EACCES' || code === 'EPERM') return `${kind}无读取权限: ${target}`;
  if (code === 'ENOTDIR') return `${kind}不是目录: ${target}`;
  const message = error && error.message ? error.message : String(error);
  return `${kind}读取失败: ${target} (${message})`;
}

/* ------------------------------------------------------------------ */
/* Markdown 扫描                                                       */
/* ------------------------------------------------------------------ */

function isMarkdownFile(name, excludeSuffixes) {
  const lower = name.toLowerCase();
  if (!lower.endsWith('.md')) return false;
  for (const suffix of excludeSuffixes) {
    if (suffix !== '' && lower.endsWith(suffix)) return false;
  }
  return true;
}

function newSource(id, kind, label, sourcePath) {
  return { id, kind, label, path: sourcePath, files: 0, count: 0, open: 0, done: 0, error: null };
}

function finalizeSource(source, todos) {
  let open = 0;
  let done = 0;
  for (const todo of todos) {
    if (todo.done) done += 1;
    else if (!todo.cancelled) open += 1;
  }
  source.count = todos.length;
  source.open = open;
  source.done = done;
  return source;
}

/**
 * 递归扫一个 markdown root。
 * budget 是跨 root 共享的 { files, limitHit }，用于 maxFiles 总上限。
 */
async function scanMarkdownRoot(root, config, now, budget) {
  const source = newSource(root.id, 'markdown', root.label, root.path);
  const todos = [];

  if (budget.limitHit) {
    source.error = FILE_LIMIT_ERROR;
    return { source, todos };
  }

  const rootAbs = path.resolve(root.path);
  try {
    const stat = await fsp.stat(rootAbs);
    if (!stat.isDirectory()) {
      source.error = `目录不是文件夹: ${root.path}`;
      return { source, todos };
    }
  } catch (error) {
    source.error = describeFsError('目录', root.path, error);
    return { source, todos };
  }

  const excludeDirs = new Set(config.excludeDirs.map((name) => name.toLowerCase()));
  const excludeSuffixes = config.excludeSuffixes.map((suffix) => suffix.toLowerCase());

  const parseFile = async (absPath, relPath) => {
    let stat;
    try {
      stat = await fsp.stat(absPath);
    } catch {
      return;
    }
    if (stat.size > config.maxFileBytes) return;

    let content;
    try {
      content = await fsp.readFile(absPath, 'utf8');
    } catch {
      return; // 单个文件读失败不影响整体
    }

    budget.files += 1;
    source.files += 1;

    let parsed;
    try {
      parsed = parseMarkdownContent(content, {
        absPath,
        relPath,
        sourceId: root.id,
        sourceLabel: root.label,
        now,
      });
    } catch (error) {
      // 单个文件解析异常不应让整体失败
      if (source.error === null) {
        source.error = `解析失败: ${relPath} (${error && error.message ? error.message : String(error)})`;
      }
      return;
    }
    for (const todo of parsed) todos.push(todo);
  };

  const walk = async (absDir, relDir) => {
    if (budget.limitHit) return;

    let entries;
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch (error) {
      if (source.error === null) source.error = describeFsError('目录', absDir, error);
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (budget.limitHit) return;
      const absPath = path.join(absDir, entry.name);
      const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;

      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name.toLowerCase())) continue;
        await walk(absPath, relPath);
      } else if (entry.isFile()) {
        if (!isMarkdownFile(entry.name, excludeSuffixes)) continue;
        if (budget.files >= config.maxFiles) {
          budget.limitHit = true;
          if (source.error === null) source.error = FILE_LIMIT_ERROR;
          return;
        }
        await parseFile(absPath, relPath);
      }
    }
  };

  await walk(rootAbs, '');
  finalizeSource(source, todos);
  return { source, todos };
}

/* ------------------------------------------------------------------ */
/* DSH session todos                                                   */
/* ------------------------------------------------------------------ */

function resolveDshCacheDir(config) {
  if (typeof config.dshCacheDir === 'string' && config.dshCacheDir.trim() !== '') {
    return config.dshCacheDir;
  }
  const home =
    typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME
      : path.join(os.homedir(), '.dsh');
  return path.join(home, 'storages', 'session_projcache', 'sessions');
}

function readPath(object, ...keys) {
  let current = object;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

/**
 * 读取 DSH session 缓存里的 todos。失败只写 source.error，不抛。
 */
async function scanDshSource(config) {
  const source = newSource(
    DSH_SOURCE_ID,
    'dsh',
    DSH_SOURCE_LABEL,
    resolveDshCacheDir(config),
  );
  const todos = [];

  let entries;
  try {
    entries = await fsp.readdir(source.path, { withFileTypes: true });
  } catch (error) {
    source.error = describeFsError('目录', source.path, error);
    return { source, todos };
  }

  const files = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'));

  // 最近修改的会话优先，保证 dshMaxSessions 截断结果稳定
  const withMtime = [];
  for (const entry of files) {
    try {
      const stat = await fsp.stat(path.join(source.path, entry.name));
      withMtime.push({ name: entry.name, mtimeMs: stat.mtimeMs });
    } catch {
      // 单个会话文件 stat 失败：跳过
    }
  }
  withMtime.sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  const limit = Math.max(0, config.dshMaxSessions);
  const selected = withMtime.slice(0, limit);

  for (const { name } of selected) {
    let raw;
    try {
      raw = await fsp.readFile(path.join(source.path, name), 'utf8');
    } catch {
      continue;
    }
    source.files += 1;

    let document;
    try {
      document = JSON.parse(raw);
    } catch {
      continue; // 坏 JSON 容忍
    }

    const sessionId = name.replace(/\.json$/i, '');
    const rows = readPath(document, 'record', 'rows');
    if (!isPlainObject(rows)) continue;

    const titleValue = readPath(rows, 'title', 'val');
    const sessionTitle = typeof titleValue === 'string' ? titleValue : null;
    const projectValue = readPath(rows, 'workingDirectory', 'val');
    const project = typeof projectValue === 'string' ? projectValue : null;

    const list = readPath(rows, 'todos', 'val');
    if (!Array.isArray(list)) continue;

    list.forEach((item, index) => {
      if (!isPlainObject(item)) return;
      const status = typeof item.status === 'string' ? item.status : null;
      const include =
        status === 'pending' ||
        status === 'in_progress' ||
        (config.includeDshCompleted && status === 'completed');
      if (!include) return;

      const content = typeof item.content === 'string' ? item.content.trim() : '';
      if (content === '') return;

      todos.push({
        id: `dsh:${sessionId}:${index}`,
        kind: 'dsh',
        text: content,
        raw: content.slice(0, 500),
        done: status === 'completed',
        cancelled: false,
        sourceId: DSH_SOURCE_ID,
        sourceLabel: DSH_SOURCE_LABEL,
        file: null,
        relPath: null,
        line: null,
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
        sessionId,
        sessionTitle,
        project,
      });
    });
  }

  finalizeSource(source, todos);
  return { source, todos };
}

/* ------------------------------------------------------------------ */
/* 统计                                                                */
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
    if (todo.done) {
      stats.done += 1;
      continue;
    }
    if (todo.cancelled) {
      stats.cancelled += 1;
      continue;
    }
    stats.open += 1;
    if (!todo.due) {
      stats.undated += 1;
      continue;
    }
    const parts = todo.due.split('-').map(Number);
    const dueLocal = new Date(parts[0], parts[1] - 1, parts[2]);
    const diffDays = Math.round((dueLocal.getTime() - today.getTime()) / DAY_MS);
    if (diffDays < 0) stats.overdue += 1;
    else if (diffDays === 0) stats.dueToday += 1;
    else if (diffDays <= 7) stats.dueSoon += 1;
    // 更远期的截止日不进任何桶（未来 > 7 天）
  }

  return stats;
}

/* ------------------------------------------------------------------ */
/* aggregate + 内存缓存 / inflight 去重                                */
/* ------------------------------------------------------------------ */

const nowMs =
  typeof performance !== 'undefined' && performance && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();

let cache = null; // { key, at, snapshot }
let inflight = null; // { key, promise }

async function runAggregate(config, now, startedAt) {
  const todos = [];
  const sources = [];
  const budget = { files: 0, limitHit: false };

  for (const root of config.markdownRoots) {
    const result = await scanMarkdownRoot(root, config, now, budget);
    sources.push(result.source);
    for (const todo of result.todos) todos.push(todo);
  }

  if (config.includeDshTodos) {
    const result = await scanDshSource(config);
    sources.push(result.source);
    for (const todo of result.todos) todos.push(todo);
  }

  const stats = buildStats(todos, now);

  return {
    ok: true,
    version: SNAPSHOT_VERSION,
    generatedAt: now.toISOString(),
    tookMs: Math.max(0, Math.round(nowMs() - startedAt)),
    sources,
    todos,
    stats,
    config: {
      includeDshTodos: config.includeDshTodos,
      markdownRootCount: config.markdownRoots.length,
    },
  };
}

/**
 * 聚合所有来源，返回 Snapshot。
 *
 * @param {object} [config] 原始或已校验配置
 * @param {{ now?: Date, force?: boolean }} [opts]
 * @returns {Promise<object>} Snapshot
 */
export async function aggregate(config, opts) {
  const startedAt = nowMs();
  const normalized = normalizeConfig(config);
  const options = isPlainObject(opts) ? opts : {};
  const now =
    options.now instanceof Date && !Number.isNaN(options.now.getTime()) ? options.now : new Date();
  const force = options.force === true;
  const key = JSON.stringify(normalized);

  // 1) 命中缓存：直接复用上一次快照（引用可复用）
  if (!force && cache && cache.key === key && Date.now() - cache.at < normalized.cacheTtlMs) {
    return cache.snapshot;
  }

  // 2) 并发调用共用同一个 inflight promise
  if (!force && inflight && inflight.key === key) {
    return inflight.promise;
  }

  const promise = runAggregate(normalized, now, startedAt);
  inflight = { key, promise };
  try {
    const snapshot = await promise;
    cache = { key, at: Date.now(), snapshot };
    return snapshot;
  } finally {
    if (inflight !== null && inflight.promise === promise) inflight = null;
  }
}
