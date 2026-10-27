/**
 * leo-status v0.4.0 · suggest.js 测试（node:test / 零第三方依赖）
 *
 * 覆盖 CONTRACT-V4 §3：
 *   - classifySessionTodo：wrapup / relevant / noise、thresholds、subagent、reasons
 *   - suggestionId：稳定性与 16 hex
 *   - deriveSuggestions：只取 dsh 未完成、stats、skipped、同会话 >6 截断
 *   - createSuggestionStore：原子写、mergeDerived 以 pending 为基线、accept/dismiss/
 *     remove 持久化、dismissed/accepted 不复活、坏 JSON 容忍
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  SUGGESTION_VERSION,
  DEFAULT_FILTER,
  classifySessionTodo,
  suggestionId,
  deriveSuggestions,
  createSuggestionStore,
} from '../suggest.js';

/* ------------------------------------------------------------------ */
/* fixture                                                             */
/* ------------------------------------------------------------------ */

let todoSeq = 0;

/** scan.js 形状的 dsh todo（含 V4 可能新增的 status，缺省 pending）。 */
function dshTodo(overrides = {}) {
  todoSeq += 1;
  return {
    id: `dsh:sess-${todoSeq}:${todoSeq}`,
    kind: 'dsh',
    text: '整理 leo-status 的收尾文档',
    raw: '',
    done: false,
    cancelled: false,
    sourceId: 'dsh-sessions',
    sourceLabel: 'DSH 会话 (AI 抽取)',
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
    sessionId: 'sess-1',
    sessionTitle: 'leo-status 开发',
    project: 'C:\\work\\demo',
    status: 'pending',
    ...overrides,
  };
}

function snapshot(todos) {
  return {
    ok: true,
    version: 1,
    generatedAt: new Date().toISOString(),
    tookMs: 1,
    sources: [],
    todos,
    stats: {},
    config: {},
  };
}

/** 直接构造一条派生建议（store 测试用，避免依赖分类细节）。 */
function derivedItem(id, overrides = {}) {
  return {
    id,
    text: `建议 ${id}`,
    normalized: `建议 ${id}`,
    sessionId: 'sess-1',
    sessionTitle: '会话',
    project: null,
    kind: 'wrapup',
    score: 0.85,
    bucket: 'accept',
    reasons: ['收尾类'],
    status: 'pending',
    source: 'session',
    createdAt: '2026-10-27T00:00:00.000Z',
    ...overrides,
  };
}

/** mergeDerived 返回条目数组，这里压成计数方便断言。 */
function mergeSummary(result) {
  return { added: result.added.length, kept: result.kept.length, dismissed: result.dismissed.length };
}

async function withStore(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'leo-status-suggest-'));
  const store = createSuggestionStore(dir);
  await store.load();
  t.after(async () => {
    // 先等待后台原子写结束，避免 Windows 上 rm 与 rename 竞争导致 ENOTEMPTY。
    try {
      await store.flush();
    } catch {
      /* ignore */
    }
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, store };
}

/* ------------------------------------------------------------------ */
/* 常量 / 分类                                                         */
/* ------------------------------------------------------------------ */

test('导出常量：SUGGESTION_VERSION=1，DEFAULT_FILTER 为契约默认值', () => {
  assert.equal(SUGGESTION_VERSION, 1);
  assert.deepEqual({ ...DEFAULT_FILTER }, {
    enabled: true,
    acceptScore: 0.55,
    reviewScore: 0.35,
    skipSubagentSessions: true,
  });
});

test('classify：中文收尾 → wrapup/accept，score=0.6+0.25', () => {
  const result = classifySessionTodo({ kind: 'dsh', text: '整理 leo-status 的收尾文档' });
  assert.equal(result.kind, 'wrapup');
  assert.equal(result.score, 0.85);
  assert.equal(result.bucket, 'accept');
  assert.deepEqual(result.reasons, ['收尾类', '与你相关：leo-status']);
  assert.equal(result.normalized, '整理 leo-status 的收尾文档');
});

test('classify：英文 wrapup 生效；三分量叠加封顶 1；英文单词有词边界', () => {
  const en = classifySessionTodo({ text: 'wrap up and deploy the release' });
  assert.equal(en.kind, 'wrapup');
  assert.equal(en.score, 0.6);
  assert.equal(en.bucket, 'accept');
  assert.equal(en.reasons[0], '收尾类');

  const full = classifySessionTodo({ text: '我想收尾 leo-status 的发布' });
  assert.equal(full.score, 1); // 0.6 + 0.25 + 0.25 => min(1, 1.1)
  assert.equal(full.bucket, 'accept');
  assert.deepEqual(full.reasons, ['收尾类', '与你相关：leo-status', '你亲口说的']);
  assert.equal(full.reasons.length, 3);

  // "contest" 里的 test 不算 wrapup（\b）
  const notWrapup = classifySessionTodo({ text: 'the latest contest was great' });
  assert.equal(notWrapup.score, 0);
  assert.equal(notWrapup.bucket, 'noise');
});

test('classify：项目词+第一人称 → relevant/review，理由补低置信', () => {
  const result = classifySessionTodo({ text: '我想改进看板' });
  assert.equal(result.kind, 'relevant');
  assert.equal(result.score, 0.5);
  assert.equal(result.bucket, 'review');
  assert.deepEqual(result.reasons, ['与你相关：看板', '你亲口说的', '低置信']);

  const onlyProject = classifySessionTodo({ text: '看板好像有点问题' });
  assert.equal(onlyProject.kind, 'relevant');
  assert.equal(onlyProject.score, 0.25);
  assert.equal(onlyProject.bucket, 'noise'); // 低于 reviewScore
});

test('classify：无任何信号 → noise / score 0', () => {
  const result = classifySessionTodo({ text: '随便写点东西' });
  assert.deepEqual(result, {
    kind: 'noise',
    score: 0,
    bucket: 'noise',
    reasons: ['低置信'],
    normalized: '随便写点东西',
  });
});

test('classify：noise 优先（task-\\d / 英文命令 / 工具步骤 / 过短）', () => {
  const noiseTexts = [
    'task-3 总结',
    'return a short summary',
    'you are a helpful teammate',
    'spawn a teammate for this',
    'research the API surface',
    'read the docs',
    'explore src directory',
    'investigate the bug',
    'implement the parser',
    'write a short report',
    'update todo list',
    'verify the build',
    '/api/board',
    '<tool_use>',
    'ab',
    'read C:\\notes\\a.md',
    'cat /var/log/app.log',
  ];
  for (const text of noiseTexts) {
    const result = classifySessionTodo({ text });
    assert.equal(result.bucket, 'noise', `应为 noise: ${text}`);
    assert.equal(result.kind, 'noise', `kind 应为 noise: ${text}`);
    assert.equal(result.score, 0.1, `noise 分数应为 0.1: ${text}`);
  }

  // 含中文时英文开头命令不生效
  assert.equal(classifySessionTodo({ text: '研究一下 leo-status 的接口' }).kind, 'relevant');
  // 中文收尾即使含英文也不再被 noise 抢先
  assert.equal(classifySessionTodo({ text: '整理 leo-status 收尾' }).bucket, 'accept');
});

test('classify：子代理会话 → noise；skipSubagentSessions=false 时正常分类', () => {
  const todo = dshTodo({ text: '整理 leo-status 的文档', sessionTitle: 'Research teammate · spider' });

  const skipped = classifySessionTodo(todo);
  assert.equal(skipped.bucket, 'noise');
  assert.equal(skipped.score, 0.1);
  assert.deepEqual(skipped.reasons, ['子代理会话']);

  const unfiltered = classifySessionTodo(todo, { filter: { skipSubagentSessions: false } });
  assert.equal(unfiltered.kind, 'wrapup');
  assert.equal(unfiltered.bucket, 'accept');
});

test('classify：acceptScore/reviewScore 可配置（直传或 filter 包裹）', () => {
  const direct = classifySessionTodo(
    { text: '整理 leo-status 收尾' },
    { acceptScore: 0.9, reviewScore: 0.8 },
  );
  assert.equal(direct.score, 0.85);
  assert.equal(direct.bucket, 'review');
  assert.ok(direct.reasons.includes('低置信'));

  const wrapped = classifySessionTodo(
    { text: '整理 leo-status 收尾' },
    { filter: { acceptScore: 0.9, reviewScore: 0.9 } },
  );
  assert.equal(wrapped.kind, 'wrapup');
  assert.equal(wrapped.bucket, 'noise');
});

test('suggestionId：稳定 16 hex，文本归一化，会话/文本变化即变', () => {
  const a = suggestionId({ sessionId: 's1', text: '整理 leo-status 文档' });
  const b = suggestionId({ sessionId: 's1', text: '  整理   leo-status   文档  ' });
  const c = suggestionId({ sessionId: 's2', text: '整理 leo-status 文档' });
  const d = suggestionId({ sessionId: 's1', text: '整理 leo-status 发布' });

  assert.match(a, /^sug:[0-9a-f]{16}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
  assert.equal(suggestionId({ text: 'x' }), suggestionId({ text: 'x', sessionId: undefined }));
});

/* ------------------------------------------------------------------ */
/* 派生                                                                */
/* ------------------------------------------------------------------ */

test('deriveSuggestions：只取 dsh 未完成，stats 正确，items 字段齐全', () => {
  const now = Date.parse('2026-10-27T10:00:00.000Z');
  const accept = dshTodo({ text: '整理 leo-status 的收尾文档', sessionId: 's1', sessionTitle: '开发 A' });
  const review = dshTodo({ text: '我想改进看板', sessionId: 's2', sessionTitle: '开发 B' });
  const noise = dshTodo({ text: 'read the docs', sessionId: 's3' });
  const done = dshTodo({ text: '整理收尾', done: true, sessionId: 's1' });
  const statusDone = dshTodo({ text: '整理收尾', status: 'completed', done: false, sessionId: 's1' });
  const cancelled = dshTodo({ text: '整理收尾', cancelled: true });
  const markdown = { ...dshTodo({ text: '整理收尾' }), kind: 'markdown' };
  const subagent = dshTodo({ text: '整理收尾', sessionTitle: 'subagent 会话', sessionId: 's4' });

  const result = deriveSuggestions(
    snapshot([accept, review, noise, done, statusDone, cancelled, markdown, subagent]),
    { now },
  );

  assert.deepEqual(result.stats, { total: 3, accept: 1, review: 1, noise: 1, skippedSessions: 1 });
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.skipped, [
    { sessionId: 's4', title: 'subagent 会话', reason: '子代理会话' },
  ]);

  const byId = new Map(result.items.map((item) => [item.id, item]));
  const acceptItem = byId.get(suggestionId(accept));
  assert.ok(acceptItem, '应有 accept 建议');
  assert.deepEqual(
    {
      text: acceptItem.text,
      normalized: acceptItem.normalized,
      sessionId: acceptItem.sessionId,
      sessionTitle: acceptItem.sessionTitle,
      project: acceptItem.project,
      kind: acceptItem.kind,
      score: acceptItem.score,
      bucket: acceptItem.bucket,
      status: acceptItem.status,
      source: acceptItem.source,
      createdAt: acceptItem.createdAt,
    },
    {
      text: '整理 leo-status 的收尾文档',
      normalized: '整理 leo-status 的收尾文档',
      sessionId: 's1',
      sessionTitle: '开发 A',
      project: 'C:\\work\\demo',
      kind: 'wrapup',
      score: 0.85,
      bucket: 'accept',
      status: 'pending',
      source: 'session',
      createdAt: '2026-10-27T10:00:00.000Z',
    },
  );
  assert.deepEqual(acceptItem.reasons, ['收尾类', '与你相关：leo-status']);
  assert.equal(acceptItem.id, suggestionId(accept));

  const reviewItem = byId.get(suggestionId(review));
  assert.ok(reviewItem);
  assert.equal(reviewItem.bucket, 'review');
  assert.equal(reviewItem.kind, 'relevant');
});

test('deriveSuggestions：同会话同文本去重（保留高分那条）', () => {
  const first = dshTodo({ text: '整理 leo-status 收尾', sessionId: 'dup' });
  const second = dshTodo({ text: '整理 leo-status 收尾', sessionId: 'dup' });
  const result = deriveSuggestions(snapshot([first, second]));
  assert.equal(result.stats.total, 1);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, suggestionId(first));
});

test('deriveSuggestions：filter.enabled=false 返回空结果', () => {
  const result = deriveSuggestions(snapshot([dshTodo({})]), { filter: { enabled: false } });
  assert.deepEqual(result, {
    items: [],
    stats: { total: 0, accept: 0, review: 0, noise: 0, skippedSessions: 0 },
    skipped: [],
  });

  // 空 snapshot / 非法输入也不抛
  assert.equal(deriveSuggestions(undefined).stats.total, 0);
  assert.equal(deriveSuggestions({ todos: null }).stats.total, 0);
});

test('deriveSuggestions：subagent 会话整会话跳过，可关闭', () => {
  const subagentTodo = dshTodo({
    text: '整理 leo-status 的文档',
    sessionTitle: 'Research teammate · spider',
    sessionId: 'sub-1',
  });

  const skipped = deriveSuggestions(snapshot([subagentTodo]));
  assert.equal(skipped.items.length, 0);
  assert.equal(skipped.stats.skippedSessions, 1);
  assert.deepEqual(skipped.skipped, [
    { sessionId: 'sub-1', title: 'Research teammate · spider', reason: '子代理会话' },
  ]);

  const disabled = deriveSuggestions(snapshot([subagentTodo]), {
    filter: { skipSubagentSessions: false },
  });
  assert.equal(disabled.stats.skippedSessions, 0);
  assert.equal(disabled.items.length, 1);
});

test('deriveSuggestions：同会话 accept >6 截断，只留最高分 6 条，其余 review', () => {
  const todos = [];
  // 2 条满分 1.0（wrapup + project + intent）
  for (let index = 0; index < 2; index += 1) {
    todos.push(dshTodo({ text: `我想收尾 leo-status 的发布 ${index}`, sessionId: 'many' }));
  }
  // 6 条 0.85
  for (let index = 0; index < 6; index += 1) {
    todos.push(dshTodo({ text: `整理 leo-status 的收尾文档 ${index}`, sessionId: 'many' }));
  }

  const result = deriveSuggestions(snapshot(todos));
  assert.equal(result.stats.total, 8);
  assert.equal(result.stats.accept, 6);
  assert.equal(result.stats.review, 2);
  assert.equal(result.stats.noise, 0);

  const accepted = result.items.filter((item) => item.bucket === 'accept');
  const demoted = result.items.filter((item) => item.bucket === 'review');
  assert.equal(accepted.length, 6);
  assert.equal(demoted.length, 2);
  assert.equal(accepted.filter((item) => item.score === 1).length, 2);
  assert.ok(accepted.every((item) => item.score >= 0.85));
  assert.ok(demoted.every((item) => item.score === 0.85));
  assert.ok(demoted.every((item) => item.reasons.includes('同会话限额')));
  assert.ok(demoted.every((item) => item.reasons.length <= 3));

  // 每个会话独立截断
  const other = [];
  for (let index = 0; index < 7; index += 1) {
    other.push(dshTodo({ text: `整理 leo-status 收尾 other ${index}`, sessionId: 'other' }));
  }
  const otherResult = deriveSuggestions(snapshot(other));
  assert.equal(otherResult.stats.accept, 6);
  assert.equal(otherResult.stats.review, 1);
});

/* ------------------------------------------------------------------ */
/* 存储                                                                */
/* ------------------------------------------------------------------ */

test('createSuggestionStore：mergeDerived 以 pending 为基线，accept/dismiss 后不复活', async (t) => {
  const { dir, store } = await withStore(t);
  assert.equal(store.file, path.join(dir, 'suggestions.json'));

  assert.deepEqual(store.snapshot(), { version: 1, items: [] });
  assert.deepEqual(store.list(), []);
  assert.equal(store.get('nope'), null);

  const derived = [derivedItem('sug:a'), derivedItem('sug:b')];
  const firstMerge = store.mergeDerived(derived);
  assert.deepEqual(firstMerge.added.map((item) => item.id).sort(), ['sug:a', 'sug:b']);
  assert.deepEqual(mergeSummary(firstMerge), { added: 2, kept: 2, dismissed: 0 });
  assert.deepEqual(mergeSummary(store.mergeDerived(derived)), { added: 0, kept: 2, dismissed: 0 });
  assert.deepEqual(store.list('pending').map((item) => item.id).sort(), ['sug:a', 'sug:b']);

  const accepted = store.accept('sug:a');
  assert.equal(accepted.status, 'accepted');
  assert.ok(typeof accepted.acceptedAt === 'string' && accepted.acceptedAt !== '');
  assert.deepEqual(store.list('pending').map((item) => item.id), ['sug:b']);
  assert.deepEqual(store.list('accepted').map((item) => item.id), ['sug:a']);
  assert.equal(store.get('sug:a').status, 'accepted');

  // accepted 的 id 不会再被派生带回来
  const afterAccept = store.mergeDerived(derived);
  assert.deepEqual(mergeSummary(afterAccept), { added: 0, kept: 1, dismissed: 1 });
  assert.deepEqual(afterAccept.dismissed.map((item) => item.id), ['sug:a']);
  assert.equal(afterAccept.dismissed[0].status, 'accepted');
  assert.deepEqual(store.list('pending').map((item) => item.id), ['sug:b']);

  const dismissed = store.dismiss('sug:b');
  assert.equal(dismissed.status, 'dismissed');
  assert.ok(typeof dismissed.dismissedAt === 'string' && dismissed.dismissedAt !== '');
  assert.deepEqual(mergeSummary(store.mergeDerived(derived)), { added: 0, kept: 0, dismissed: 2 });
  assert.deepEqual(store.list('pending'), []);

  // 未知 id
  assert.equal(store.accept('nope'), null);
  assert.equal(store.dismiss('nope'), null);
  assert.equal(store.remove('nope'), false);

  // 接受后 snapshot 全量可见（供 GET state 用）
  const snap = store.snapshot();
  assert.equal(snap.items.length, 2);
  assert.deepEqual(snap.items.map((item) => item.status).sort(), ['accepted', 'dismissed']);
});

test('createSuggestionStore：原子写持久化，重建实例状态不丢', async (t) => {
  const { dir, store } = await withStore(t);
  store.mergeDerived([derivedItem('sug:a'), derivedItem('sug:b')]);
  store.accept('sug:a');
  store.dismiss('sug:b');
  await store.flush();

  const file = path.join(dir, 'suggestions.json');
  const onDisk = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(onDisk.version, SUGGESTION_VERSION);
  assert.equal(onDisk.items.length, 2);
  const byId = new Map(onDisk.items.map((item) => [item.id, item]));
  assert.equal(byId.get('sug:a').status, 'accepted');
  assert.equal(byId.get('sug:b').status, 'dismissed');

  // 原子写：无 .tmp 残留；POSIX 文件 0600
  assert.deepEqual(
    (await readdir(dir)).filter((name) => name.endsWith('.tmp')),
    [],
  );
  if (process.platform !== 'win32') {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }

  const reloaded = createSuggestionStore(dir);
  await reloaded.load();
  assert.equal(reloaded.get('sug:a').status, 'accepted');
  assert.equal(reloaded.get('sug:b').status, 'dismissed');
  assert.deepEqual(reloaded.list('pending'), []);
  assert.deepEqual(mergeSummary(reloaded.mergeDerived([derivedItem('sug:a'), derivedItem('sug:b')])), {
    added: 0,
    kept: 0,
    dismissed: 2,
  });
  await reloaded.flush();
});

test('createSuggestionStore：remove 软删除（removed）且不复活', async (t) => {
  const { store } = await withStore(t);
  store.mergeDerived([derivedItem('sug:a')]);
  assert.equal(store.remove('sug:a'), true);
  assert.equal(store.get('sug:a').status, 'removed');
  assert.deepEqual(store.list('pending'), []);
  assert.equal(store.list('removed').length, 1);

  assert.deepEqual(mergeSummary(store.mergeDerived([derivedItem('sug:a')])), { added: 0, kept: 0, dismissed: 1 });
  assert.equal(store.remove('sug:a'), true); // 重复删除幂等
  await store.flush();
});

test('createSuggestionStore：坏 JSON / 缺失文件容忍为空，之后可正常写', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'leo-status-suggest-bad-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const file = path.join(dir, 'suggestions.json');
  await writeFile(file, '{broken json', 'utf8');

  const store = createSuggestionStore(dir);
  await store.load();
  assert.deepEqual(store.snapshot(), { version: 1, items: [] });
  assert.deepEqual(store.list('pending'), []);

  assert.deepEqual(mergeSummary(store.mergeDerived([derivedItem('sug:a')])), { added: 1, kept: 1, dismissed: 0 });
  await store.flush();
  const onDisk = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(onDisk.items.length, 1);
  assert.equal(onDisk.items[0].status, 'pending');

  // 目录不存在时 load 自动创建
  const nested = path.join(dir, 'deep', 'nested');
  const fresh = createSuggestionStore(nested);
  await fresh.load();
  assert.deepEqual(fresh.snapshot(), { version: 1, items: [] });
});

test('createSuggestionStore：mergeDerived 刷新 pending 的分数/理由，保留 createdAt', async (t) => {
  const { store } = await withStore(t);
  store.mergeDerived([derivedItem('sug:a', { score: 0.4, bucket: 'review', reasons: ['低置信'] })]);
  const before = store.get('sug:a');
  store.mergeDerived([
    derivedItem('sug:a', { score: 0.9, bucket: 'accept', reasons: ['收尾类'], createdAt: '2027-01-01T00:00:00.000Z' }),
  ]);
  const after = store.get('sug:a');
  assert.equal(after.score, 0.9);
  assert.equal(after.bucket, 'accept');
  assert.deepEqual(after.reasons, ['收尾类']);
  assert.equal(after.createdAt, before.createdAt); // 首次入箱时间保留
  await store.flush();
});
