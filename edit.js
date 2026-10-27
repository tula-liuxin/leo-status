/**
 * leo-status · 行内写回（v3）
 *
 * 只对本地 Markdown 来源的 todo 行生效：作废 / 启用(撤销作废) / 删除。
 * 纯 ESM、无第三方依赖，遵守 `leo-status/CONTRACT-V3.md` §1/§2。
 *
 * 导出：
 *   EditError                        code: 'not-found' | 'changed' | 'outside-roots' | 'unsupported'
 *   isTodoLine(line)                 => boolean（与 scan.js 的复选框正则一致）
 *   cancelLine(line)                 => string；作废（正文包 ~~，保留缩进/引用/bullet/checkbox/元数据）
 *   restoreLine(line)                => string；启用（去掉包裹的首尾 ~~）
 *   applyTodoAction(opts)            => Promise<{ action, filePath, line, raw }>
 *
 * 作废/启用是【纯行变换】：只改 `[ ]` 之后 rest 里的正文部分，把元数据留在 `~~` 外面，
 * 这样 scan.js 的「去元数据后整体被 ~~…~~ 包裹 ⇒ cancelled」判定才能成立，
 * 且 cancel → restore 能逐字节复原。行首的缩进 / `>` 引用 / bullet / checkbox 标记原样保留。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

/* ------------------------------------------------------------------ */
/* 错误类型                                                            */
/* ------------------------------------------------------------------ */

const EDIT_ERROR_CODES = new Set(['not-found', 'changed', 'outside-roots', 'unsupported']);

export class EditError extends Error {
  /**
   * @param {'not-found'|'changed'|'outside-roots'|'unsupported'} code
   * @param {string} [message]
   */
  constructor(code, message) {
    super(message ?? code);
    this.name = 'EditError';
    this.code = EDIT_ERROR_CODES.has(code) ? code : 'unsupported';
  }
}

/* ------------------------------------------------------------------ */
/* 与 scan.js 保持一致的复选框正则                                      */
/* ------------------------------------------------------------------ */

// 必须与 scan.js 的 CHECKBOX_RE 完全一致：
// 缩进 / `>` 引用 / `-` `*` `+` / 有序列表 / `[ ]` `[x]` `[X]` `[-]` `[/]`
const TODO_RE = /^(?<indent>[ \t]*)(?:>\s*)?(?:[-*+]|\d+[.)])\s+\[(?<mark>[ xX\-\/])\]\s?(?<rest>.*)$/;

// 元数据 token 的「位置遮罩」用正则：与 scan.js 的剥离规则同源。
// 这些只用来判断 rest 里哪段是「正文」、哪段是元数据，使 `~~` 只包正文。
const EMOJI_DATE_MASK_RE = /(?:📅|⏳|🛫|✅)\uFE0F?\s*\d{4}-\d{2}-\d{2}/gu;
const EMOJI_LOOSE_MASK_RE = /(?:📅|⏳|🛫|✅)\uFE0F?\s*/gu;
const AT_DUE_MASK_RE = /@due\(\s*[^)]*?\s*\)/gi;
const DUE_BRACKET_MASK_RE = /\[\s*due::\s*[^\]]*?\s*\]/gi;
const DUE_PLAIN_MASK_RE = /due::\s*[^\s\]]+/gi;
const PRIORITY_MASK_RE = /(?:🔺|⏫|🔼|🔽|⏬)/gu;
const WIKILINK_MASK_RE = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
const TAG_MASK_RE = /#[\p{L}\p{N}_\-/]+/gu;

const MASK_RES = [
  EMOJI_DATE_MASK_RE,
  EMOJI_LOOSE_MASK_RE,
  AT_DUE_MASK_RE,
  DUE_BRACKET_MASK_RE,
  DUE_PLAIN_MASK_RE,
  PRIORITY_MASK_RE,
  WIKILINK_MASK_RE,
  TAG_MASK_RE,
];

const LOOP_MARKER = '🔁';
const STRIKE = '~~';
const MAX_RAW_CHARS = 500;

/* ------------------------------------------------------------------ */
/* 行级工具                                                            */
/* ------------------------------------------------------------------ */

/** 与 scan.js 的复选框正则一致。 */
export function isTodoLine(line) {
  return typeof line === 'string' && TODO_RE.test(line);
}

/**
 * 把 todo 行拆成「原始前缀」与「rest」。
 * prefix 包含缩进 / `>` / bullet / checkbox 标记，以及 `]` 后最多一个空白。
 */
function splitTodoLine(line) {
  const match = TODO_RE.exec(line);
  if (!match) return null;
  const rest = match.groups.rest ?? '';
  return {
    mark: match.groups.mark,
    indent: match.groups.indent ?? '',
    rest,
    prefix: line.slice(0, line.length - rest.length),
  };
}

/** 把 rest 里所有元数据 token 的位置标成 1（供定位正文区域）。 */
function maskMetadata(rest) {
  const mask = new Uint8Array(rest.length);
  for (const regex of MASK_RES) {
    for (const match of rest.matchAll(regex)) {
      const start = match.index ?? 0;
      const end = Math.min(rest.length, start + match[0].length);
      for (let index = start; index < end; index += 1) mask[index] = 1;
    }
  }
  return mask;
}

/**
 * 找 rest 的「正文区域」[first, last]。
 * - `🔁` 只包裹它之前的部分（循环标记及其后原样留在 `~~` 外面）；
 * - 元数据（日期/优先级/链接/tags/…）不算正文，留在 `~~` 外面；
 * - 首尾空白不算正文，原样保留。
 */
function bodyRegion(rest) {
  const loopIndex = rest.indexOf(LOOP_MARKER);
  const regionEnd = loopIndex === -1 ? rest.length : loopIndex;
  const mask = maskMetadata(rest);

  let first = -1;
  let last = -1;
  for (let index = 0; index < regionEnd; index += 1) {
    if (mask[index]) continue;
    const char = rest[index];
    if (char === ' ' || char === '\t') continue;
    if (first === -1) first = index;
    last = index;
  }
  return { first, last };
}

/* ------------------------------------------------------------------ */
/* 作废 / 启用                                                         */
/* ------------------------------------------------------------------ */

/**
 * 作废一行：把正文用 `~~` 包起来，保留缩进/引用/bullet/checkbox/元数据与行尾空白。
 * 已经是作废状态时幂等返回原行；不是 todo 行或没有正文时抛 unsupported。
 */
export function cancelLine(line) {
  if (typeof line !== 'string') throw new EditError('unsupported', '不是合法的 todo 行');
  const parsed = splitTodoLine(line);
  if (!parsed) throw new EditError('unsupported', '不是合法的 todo 行');

  const { rest, prefix } = parsed;
  const { first, last } = bodyRegion(rest);
  if (first === -1) throw new EditError('unsupported', '这一行没有可作废的正文');

  const segment = rest.slice(first, last + 1);
  // 已经整体被 ~~…~~ 包裹：幂等，避免重复包一层
  if (segment.length >= 4 && segment.startsWith(STRIKE) && segment.endsWith(STRIKE)) return line;

  const nextRest = `${rest.slice(0, first)}${STRIKE}${segment}${STRIKE}${rest.slice(last + 1)}`;
  return prefix + nextRest;
}

/**
 * 启用（撤销作废）：去掉 rest 里第一个 `~~` 和同一个包裹的最后一个 `~~`，其余不动。
 * 没有成对的 `~~` 时原样返回；不是 todo 行抛 unsupported。
 */
export function restoreLine(line) {
  if (typeof line !== 'string') throw new EditError('unsupported', '不是合法的 todo 行');
  const parsed = splitTodoLine(line);
  if (!parsed) throw new EditError('unsupported', '不是合法的 todo 行');

  const { rest, prefix } = parsed;
  const first = rest.indexOf(STRIKE);
  const last = rest.lastIndexOf(STRIKE);
  // 没有成对包裹（只有一个 ~~ 或没有）时无可撤销，原样返回
  if (first === -1 || last < first + 2) return line;

  const nextRest = rest.slice(0, first) + rest.slice(first + 2, last) + rest.slice(last + 2);
  return prefix + nextRest;
}

/* ------------------------------------------------------------------ */
/* 路径校验 / 文件读写                                                 */
/* ------------------------------------------------------------------ */

/** filePath 必须落在某个 markdownRoot 内（path.relative 不含 `..`）。 */
function isInsideRoots(filePath, roots) {
  if (!Array.isArray(roots)) return false;
  const target = path.resolve(filePath);
  for (const root of roots) {
    if (root === null || root === undefined || typeof root !== 'object') continue;
    const rootPath = root.path;
    if (typeof rootPath !== 'string' || rootPath.trim() === '') continue;
    const rootAbs = path.resolve(rootPath);
    const relative = path.relative(rootAbs, target);
    if (relative === '') continue; // root 本身不是文件
    if (relative === '..' || relative.startsWith(`..${path.sep}`)) continue;
    if (path.isAbsolute(relative)) continue;
    return true;
  }
  return false;
}

/** 检测全文换行风格：首个 `\n` 前是 `\r` 则为 CRLF。 */
function detectEol(text) {
  const index = text.indexOf('\n');
  if (index > 0 && text[index - 1] === '\r') return '\r\n';
  return '\n';
}

/**
 * 同目录 `.tmp` + rename 原子替换。
 * rename 失败（Windows 上文件被占用）时清理 tmp 并抛 changed，绝不半截写。
 */
async function atomicWrite(filePath, output) {
  const tmpPath = `${filePath}.tmp`;
  try {
    await fsp.writeFile(tmpPath, output, 'utf8');
  } catch (error) {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
  try {
    await fsp.rename(tmpPath, filePath);
  } catch {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    throw new EditError('changed', '文件被占用，未修改');
  }
}

/* ------------------------------------------------------------------ */
/* applyTodoAction                                                     */
/* ------------------------------------------------------------------ */

/**
 * 对一个本地 Markdown todo 行执行写回动作。
 *
 * @param {{
 *   action: 'cancel'|'restore'|'delete',
 *   filePath: string,
 *   line: number,                       // 1-based
 *   raw: string,                        // scan.js 存的原始行（最多 500 字符）
 *   roots: Array<{path: string}>        // effective scanConfig.markdownRoots
 * }} opts
 * @returns {Promise<{action: string, filePath: string, line: number, raw: string|null}>}
 *          raw 为写回后的该行内容（delete 后该行不存在，返回 null）。
 */
export async function applyTodoAction(opts) {
  const options = opts !== null && typeof opts === 'object' ? opts : {};
  const { action, filePath, line, raw, roots } = options;

  if (action !== 'cancel' && action !== 'restore' && action !== 'delete') {
    throw new EditError('unsupported', `不支持的操作: ${String(action)}`);
  }
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new EditError('unsupported', '缺少 filePath');
  }
  if (!isInsideRoots(filePath, roots)) {
    throw new EditError('outside-roots', `文件不在笔记根目录内: ${filePath}`);
  }
  if (!Number.isInteger(line) || line < 1) {
    throw new EditError('changed', `行号非法: ${String(line)}`);
  }

  // 只能改已存在的文件；读失败不能退化成覆盖空文件
  let original;
  try {
    original = await fsp.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new EditError('not-found', `文件不存在: ${filePath}`);
    }
    throw error;
  }

  const hasBom = original.startsWith('\uFEFF');
  const text = hasBom ? original.slice(1) : original;
  const eol = detectEol(text);
  const lines = text.split(eol);

  if (line > lines.length) {
    throw new EditError('changed', `行号越界: ${line} > 文件行数 ${lines.length}`);
  }

  const lineText = lines[line - 1];
  const expectedRaw = typeof raw === 'string' ? raw : '';
  // raw 最多 500 字符：兼容「扫描时截断」的情况
  const rawMatched =
    lineText === expectedRaw ||
    lineText.slice(0, MAX_RAW_CHARS) === expectedRaw.slice(0, MAX_RAW_CHARS);
  if (!rawMatched) {
    throw new EditError('changed', '文件内容已变化，请刷新后重试');
  }
  if (!isTodoLine(lineText)) {
    throw new EditError('unsupported', '该行不是合法的 todo 行');
  }

  let nextLines;
  let resultRaw;
  if (action === 'delete') {
    nextLines = lines.slice();
    nextLines.splice(line - 1, 1);
    resultRaw = null;
  } else if (action === 'cancel') {
    const nextLine = cancelLine(lineText);
    nextLines = lines.slice();
    nextLines[line - 1] = nextLine;
    resultRaw = nextLine;
  } else {
    const nextLine = restoreLine(lineText);
    nextLines = lines.slice();
    nextLines[line - 1] = nextLine;
    resultRaw = nextLine;
  }

  const output = (hasBom ? '\uFEFF' : '') + nextLines.join(eol);
  await atomicWrite(filePath, output);

  return { action, filePath, line, raw: resultRaw };
}
