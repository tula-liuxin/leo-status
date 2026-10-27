/**
 * leo-status/scan.js 单测（node:test + node:assert/strict）
 *
 * 全部使用 os.tmpdir() 下的临时 fixture；不读取、不修改本机真实 vault / ~/.dsh。
 * 运行：node --test leo-status/test/scan.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { DEFAULTS, EMPTY_STATS, normalizeConfig, aggregate } from '../scan.js';

/** 固定“当前时间”：本地时区 2026-10-27 12:00:00 */
const NOW = new Date(2026, 9, 27, 12, 0, 0);

const TODO_KEYS = [
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

const SNAPSHOT_KEYS = [
  'ok',
  'version',
  'generatedAt',
  'tookMs',
  'sources',
  'todos',
  'stats',
  'config',
];

const SOURCE_KEYS = ['id', 'kind', 'label', 'path', 'files', 'count', 'open', 'done', 'error'];

/* ------------------------------------------------------------------ */
/* 测试工具                                                            */
/* ------------------------------------------------------------------ */

async function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const filePath = path.join(root, ...rel.split('/'));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
  }
}

/** 建临时目录 -> 写 fixture -> 跑 fn -> 一定清理。 */
async function withVault(files, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leo-status-'));
  try {
    await writeFiles(dir, files);
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** 只扫临时 vault 的配置（默认关掉 DSH，避免碰本机 ~/.dsh）。 */
function vaultConfig(dir, extra = {}) {
  return {
    markdownRoots: [{ path: dir }],
    includeDshTodos: false,
    cacheTtlMs: 0,
    ...extra,
  };
}

function findTodo(todos, text) {
  const todo = todos.find((item) => item.text === text);
  assert.ok(todo, `未找到 text=${JSON.stringify(text)} 的 todo，实际有: ${todos.map((t) => t.text).join(' | ')}`);
  return todo;
}

function todoByRelPath(todos, relPath) {
  const todo = todos.find((item) => item.relPath === relPath);
  assert.ok(todo, `未找到 relPath=${relPath} 的 todo`);
  return todo;
}

/* ------------------------------------------------------------------ */
/* §4 默认值 / normalizeConfig                                          */
/* ------------------------------------------------------------------ */

test('DEFAULTS 与 §4 完全一致，EMPTY_STATS 是冻结的全零统计', () => {
  assert.deepEqual(DEFAULTS, {
    // v2：默认不含个人路径，具体笔记目录写在本机 settings.json
    markdownRoots: [],
    includeDshTodos: true,
    includeDshCompleted: false,
    dshCacheDir: '',
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
    maxFiles: 20_000,
    dshMaxSessions: 300,
    cacheTtlMs: 15_000,
  });

  assert.deepEqual(EMPTY_STATS, {
    total: 0,
    open: 0,
    done: 0,
    cancelled: 0,
    overdue: 0,
    dueToday: 0,
    dueSoon: 0,
    undated: 0,
  });
  assert.ok(Object.isFrozen(EMPTY_STATS));
});

test('normalizeConfig(): undefined / null / {} 都得到完整默认配置的深拷贝', () => {
  for (const raw of [undefined, null, {}]) {
    const config = normalizeConfig(raw);
    assert.deepEqual(config, DEFAULTS);
    assert.notStrictEqual(config, DEFAULTS);
    assert.notStrictEqual(config.markdownRoots, DEFAULTS.markdownRoots);
    assert.notStrictEqual(config.excludeDirs, DEFAULTS.excludeDirs);
    assert.notStrictEqual(config.excludeSuffixes, DEFAULTS.excludeSuffixes);
  }

  // 不得共享引用污染 DEFAULTS
  const config = normalizeConfig();
  config.excludeDirs.push('污染');
  config.markdownRoots.push({ id: 'x', label: 'x', path: 'x' });
  assert.ok(!DEFAULTS.excludeDirs.includes('污染'));
  assert.equal(DEFAULTS.markdownRoots.length, 0);
});

test('normalizeConfig(): markdownRoots 每项补默认 id / label', () => {
  const config = normalizeConfig({
    markdownRoots: [{ path: 'C:\\vault\\notes' }, { path: 'C:\\vault\\二级', id: 'second', label: '第二库' }],
  });
  assert.deepEqual(config.markdownRoots[0], { id: 'obsidian-1', label: 'notes', path: 'C:\\vault\\notes' });
  assert.deepEqual(config.markdownRoots[1], { id: 'second', label: '第二库', path: 'C:\\vault\\二级' });
  assert.equal(normalizeConfig({ markdownRoots: [] }).markdownRoots.length, 0);
});

test('normalizeConfig(): 幂等', () => {
  const once = normalizeConfig({ markdownRoots: [{ path: 'x/y' }], includeDshTodos: false, maxFiles: 5 });
  const twice = normalizeConfig(once);
  assert.deepEqual(twice, once);
});

test('normalizeConfig(): 非法值抛 Error 且消息带 leo-status config: 前缀', () => {
  const cases = [
    'not-an-object',
    42,
    [],
    { markdownRoots: 'x' },
    { markdownRoots: [1] },
    { markdownRoots: [{}] },
    { markdownRoots: [{ path: '' }] },
    { markdownRoots: [{ path: 'ok', id: 3 }] },
    { markdownRoots: [{ path: 'ok', label: false }] },
    { includeDshTodos: 'yes' },
    { includeDshCompleted: 0 },
    { dshCacheDir: 7 },
    { excludeDirs: 'node_modules' },
    { excludeDirs: ['.git', 1] },
    { excludeSuffixes: [null] },
    { maxFileBytes: 'big' },
    { maxFileBytes: 0 },
    { maxFiles: 0 },
    { maxFiles: 1.5 },
    { dshMaxSessions: -1 },
    { cacheTtlMs: Number.NaN },
    { cacheTtlMs: -5 },
  ];
  for (const raw of cases) {
    assert.throws(
      () => normalizeConfig(raw),
      (error) => error instanceof Error && error.message.startsWith('leo-status config: '),
      `应当拒绝: ${JSON.stringify(raw)}`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* §3 Markdown 解析                                                    */
/* ------------------------------------------------------------------ */

test('基础 todo：缩进 / 完成状态 / 引用 / 有序列表 / 标题链 / 字段齐全', async () => {
  const content = [
    '# 项目 A',
    '',
    '## 子任务 B',
    '',
    '- [ ] 普通任务',
    '- [x] 已完成任务',
    '* [X] 星号完成',
    '+ [ ] 加号任务',
    '1. [ ] 有序任务',
    '> - [ ] 引用任务',
    '  - [ ] 缩进一层',
    '\t- [ ] 制表符一层',
  ].join('\n');

  await withVault({ 'notes.md': content }, async (dir) => {
    const snapshot = await aggregate(vaultConfig(dir), { now: NOW });

    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.todos.length, 8);
    assert.equal(snapshot.sources.length, 1);

    const source = snapshot.sources[0];
    assert.equal(source.kind, 'markdown');
    assert.equal(source.id, 'obsidian-1');
    assert.equal(source.path, dir);
    assert.equal(source.files, 1);
    assert.equal(source.count, 8);
    assert.equal(source.open, 6);
    assert.equal(source.done, 2);
    assert.equal(source.error, null);
    for (const key of SOURCE_KEYS) assert.ok(key in source, `source 缺字段 ${key}`);

    // 所有字段都存在
    for (const todo of snapshot.todos) {
      for (const key of TODO_KEYS) assert.ok(key in todo, `todo 缺字段 ${key}`);
    }

    const normal = findTodo(snapshot.todos, '普通任务');
    assert.equal(normal.id, 'md:obsidian-1:notes.md:5');
    assert.equal(normal.kind, 'markdown');
    assert.equal(normal.done, false);
    assert.equal(normal.cancelled, false);
    assert.equal(normal.sourceId, 'obsidian-1');
    assert.equal(normal.sourceLabel, path.basename(dir));
    assert.equal(normal.file, path.join(dir, 'notes.md'));
    assert.equal(normal.relPath, 'notes.md');
    assert.equal(normal.line, 5);
    assert.equal(normal.heading, '项目 A > 子任务 B');
    assert.equal(normal.indent, 0);
    assert.equal(normal.noteDate, null);
    assert.equal(normal.due, null);
    assert.equal(normal.scheduled, null);
    assert.equal(normal.start, null);
    assert.equal(normal.priority, null);
    assert.deepEqual(normal.tags, []);
    assert.deepEqual(normal.links, []);
    assert.equal(normal.recurrence, null);
    assert.equal(normal.sessionId, null);
    assert.equal(normal.sessionTitle, null);
    assert.equal(normal.project, null);
    assert.equal(normal.text, '普通任务');
    assert.equal(normal.raw, '- [ ] 普通任务');

    assert.equal(findTodo(snapshot.todos, '已完成任务').done, true);
    assert.equal(findTodo(snapshot.todos, '星号完成').done, true);
    assert.equal(findTodo(snapshot.todos, '加号任务').done, false);
    assert.equal(findTodo(snapshot.todos, '有序任务').done, false);
    assert.equal(findTodo(snapshot.todos, '引用任务').done, false);
    assert.equal(findTodo(snapshot.todos, '缩进一层').indent, 1);
    assert.equal(findTodo(snapshot.todos, '制表符一层').indent, 1);
  });
});

test('元数据：日期 emoji / @due / due:: / 优先级 / #pN / tags / links / recurrence / ✅', async () => {
  const content = [
    '- [ ] 写报告 📅 2026-10-30 ⏳ 2026-10-25 🛫 2026-10-20 🔺 #论文 [[10.15 核心idea]] #todo',
    '- [ ] 无空格📅2026-10-31',
    '- [ ] @due(2026-11-01) 的写法',
    '- [ ] due:: 2026-11-02 的写法',
    '- [ ] [due:: 2026-11-03] 的写法',
    '- [ ] 优先级 #p1 任务',
    '- [ ] 优先级 #p2 任务',
    '- [ ] 优先级 #p3 任务',
    '- [ ] 优先级 #p4 任务',
    '- [ ] 高 🔼 任务',
    '- [ ] 低 🔽 任务',
    '- [ ] 最低 ⏬ 任务',
    '- [ ] 最高 ⏫ 任务',
    '- [ ] 每天写 🔁 every day',
    '- [ ] 完成于 ✅ 2026-10-01',
    '- [ ] 坏日期 📅 2026-02-30',
  ].join('\n');

  await withVault({ 'meta.md': content }, async (dir) => {
    const { todos } = await aggregate(vaultConfig(dir), { now: NOW });

    const report = findTodo(todos, '写报告');
    assert.equal(report.due, '2026-10-30');
    assert.equal(report.scheduled, '2026-10-25');
    assert.equal(report.start, '2026-10-20');
    assert.equal(report.priority, 'highest');
    assert.deepEqual(report.tags, ['论文', 'todo']);
    assert.deepEqual(report.links, ['10.15 核心idea']);

    assert.equal(findTodo(todos, '无空格').due, '2026-10-31');
    assert.equal(findTodo(todos, '的写法').text, '的写法');
    const dueValues = todos.filter((todo) => todo.text === '的写法').map((todo) => todo.due);
    assert.deepEqual(dueValues.sort(), ['2026-11-01', '2026-11-02', '2026-11-03']);

    const priorityByTag = {};
    for (const tag of ['p1', 'p2', 'p3', 'p4']) {
      const todo = todos.find((item) => item.tags.includes(tag));
      assert.ok(todo, `未找到 tag=${tag} 的 todo`);
      priorityByTag[tag] = todo.priority;
      assert.equal(todo.text, '优先级 任务'); // #pN 作为元数据从 text 中剥离
    }
    assert.equal(priorityByTag.p1, 'highest');
    assert.equal(priorityByTag.p2, 'high');
    assert.equal(priorityByTag.p3, 'medium');
    assert.equal(priorityByTag.p4, 'low');
    assert.equal(findTodo(todos, '高 任务').priority, 'high');
    assert.equal(findTodo(todos, '低 任务').priority, 'low');
    assert.equal(findTodo(todos, '最低 任务').priority, 'lowest');
    assert.equal(findTodo(todos, '最高 任务').priority, 'highest');

    const recurring = findTodo(todos, '每天写');
    assert.equal(recurring.recurrence, 'every day');

    const completedAt = findTodo(todos, '完成于');
    assert.equal(completedAt.due, null);

    const invalidDate = findTodo(todos, '坏日期');
    assert.equal(invalidDate.due, null);
  });
});

test('元数据可任意顺序：emoji 在文本前 / 多个标签 / 多级 tag / 纯数字标签被过滤', async () => {
  const content = [
    '📅 2026-12-01 - [ ] 元数据在前',
    '- [ ] 多级 #ideas/核心idea #123 #ok #todo',
    '- [ ] 乱序 #p2 [[链接笔记]] 📅 2026-11-05 🔽',
  ].join('\n');

  await withVault({ 'order.md': content }, async (dir) => {
    const { todos } = await aggregate(vaultConfig(dir), { now: NOW });

    assert.equal(todos.length, 2); // 第一行 emoji 在列表符前，不是复选框行
    assert.equal(findTodo(todos, '多级').tags.join(','), 'ideas/核心idea,ok,todo');
    assert.equal(findTodo(todos, '乱序').due, '2026-11-05');
    assert.equal(findTodo(todos, '乱序').priority, 'high'); // #p2 与 🔽 取更高者
    assert.deepEqual(findTodo(todos, '乱序').links, ['链接笔记']);
    assert.deepEqual(findTodo(todos, '乱序').tags, ['p2']);
  });
});

test('跳过文件首 YAML frontmatter', async () => {
  const content = [
    '---',
    'title: 笔记标题',
    '- [ ] frontmatter 里的假任务',
    'tags: [a, b]',
    '---',
    '# 真标题',
    '- [ ] 真任务',
  ].join('\n');

  await withVault({ 'fm.md': content }, async (dir) => {
    const { todos } = await aggregate(vaultConfig(dir), { now: NOW });
    assert.equal(todos.length, 1);
    assert.equal(todos[0].text, '真任务');
    assert.equal(todos[0].heading, '真标题');
    assert.equal(todos[0].line, 7);
  });

  // 未闭合的 frontmatter 不吞掉正文（不存在结束 `---`）
  await withVault({ 'unclosed.md': '---\n- [ ] 未闭合正文任务\n' }, async (dir) => {
    const { todos } = await aggregate(vaultConfig(dir), { now: NOW });
    assert.equal(todos.length, 1);
    assert.equal(todos[0].text, '未闭合正文任务');
  });
});

test('跳过 fenced code block（``` / ~~~ / 未闭合到文件尾）', async () => {
  const content = [
    '- [ ] 顶部任务',
    '```js',
    '- [ ] 井号围栏内',
    '```',
    '~~~',
    '- [ ] 波浪号围栏内',
    '~~~',
    '```',
    '- [ ] 未闭合围栏内',
  ].join('\n');

  await withVault({ 'fence.md': content }, async (dir) => {
    const { todos } = await aggregate(vaultConfig(dir), { now: NOW });
    assert.equal(todos.length, 1);
    assert.equal(todos[0].text, '顶部任务');
  });
});

test('标题栈：更深标题弹出、尾部 # 去掉、7 级 # 不算标题', async () => {
  const content = [
    '# 一级',
    '## 二级',
    '### 三级',
    '####### 不是标题',
    '- [ ] 在三级',
    '## 二级二',
    '- [ ] 在二级二',
    '# 带尾巴 ###',
    '- [ ] 在新一级',
  ].join('\n');

  await withVault({ 'heading.md': content }, async (dir) => {
    const { todos } = await aggregate(vaultConfig(dir), { now: NOW });
    assert.equal(findTodo(todos, '在三级').heading, '一级 > 二级 > 三级');
    assert.equal(findTodo(todos, '在二级二').heading, '一级 > 二级二');
    assert.equal(findTodo(todos, '在新一级').heading, '带尾巴');
  });
});

test('links 提取与 text 清洗', async () => {
  const content = [
    '- [ ] 看 [[10.15 核心idea]]',
    '- [ ] 看 [[笔记#小节]]',
    '- [ ] 看 [[笔记|别名]]',
    '- [ ] 看 #tags_ok #中文标签 #a/b/c',
  ].join('\n');

  await withVault({ 'links.md': content }, async (dir) => {
    const { todos } = await aggregate(vaultConfig(dir), { now: NOW });
    assert.equal(todos.length, 4);
    assert.deepEqual(todos[0].links, ['10.15 核心idea']);
    assert.deepEqual(todos[1].links, ['笔记']);
    assert.deepEqual(todos[2].links, ['笔记']);
    assert.deepEqual(todos[3].tags, ['tags_ok', '中文标签', 'a/b/c']);
    assert.equal(todos[3].text, '看');
  });
});

test('raw 截断到 500 字符；CRLF 换行不残留 \\r；空文件不算 todo', async () => {
  const longText = 'x'.repeat(600);
  await withVault(
    {
      'long.md': `- [ ] ${longText}\n`,
      'crlf.md': ['# 标题', '', '- [ ] 任务'].join('\r\n'),
      'empty.md': '',
    },
    async (dir) => {
      const snapshot = await aggregate(vaultConfig(dir), { now: NOW });
      assert.equal(snapshot.sources[0].files, 3);

      const longTodo = snapshot.todos.find((todo) => todo.text === longText);
      assert.ok(longTodo);
      assert.equal(longTodo.raw.length, 500);
      assert.equal(longTodo.text.length, 600);

      const crlfTodo = findTodo(snapshot.todos, '任务');
      assert.equal(crlfTodo.heading, '标题');
      assert.ok(!crlfTodo.raw.includes('\r'));
      assert.equal(crlfTodo.relPath, 'crlf.md');
      assert.equal(crlfTodo.line, 3);
    },
  );
});

test('noteDate 三级推断：文件名日期 / 月日+目录年份 / 当前年 / 非法日期为 null', async () => {
  await withVault(
    {
      '2026-10-26.md': '- [ ] a',
      '2026/10月/10.26.md': '- [ ] b',
      '2026/8月/8.12 记录.md': '- [ ] c',
      'archive/2019/11.3.md': '- [ ] d',
      'misc/1.5.md': '- [ ] e',
      'misc/2.30.md': '- [ ] f',
      '2026-02-30.md': '- [ ] g',
      'misc/random.md': '- [ ] h',
    },
    async (dir) => {
      const { todos } = await aggregate(vaultConfig(dir), { now: NOW });
      assert.equal(todoByRelPath(todos, '2026-10-26.md').noteDate, '2026-10-26');
      assert.equal(todoByRelPath(todos, '2026/10月/10.26.md').noteDate, '2026-10-26');
      assert.equal(todoByRelPath(todos, '2026/8月/8.12 记录.md').noteDate, '2026-08-12');
      assert.equal(todoByRelPath(todos, 'archive/2019/11.3.md').noteDate, '2019-11-03');
      assert.equal(todoByRelPath(todos, 'misc/1.5.md').noteDate, '2026-01-05');
      assert.equal(todoByRelPath(todos, 'misc/2.30.md').noteDate, null);
      assert.equal(todoByRelPath(todos, '2026-02-30.md').noteDate, null);
      assert.equal(todoByRelPath(todos, 'misc/random.md').noteDate, null);
    },
  );
});

test('排除目录 / 排除后缀：默认值与自定义都生效', async () => {
  await withVault(
    {
      'real.md': '- [ ] 真实任务',
      'node_modules/pkg/a.md': '- [ ] 依赖里的',
      '.obsidian/b.md': '- [ ] 配置里的',
      'attachments/c.md': '- [ ] 附件里的',
      'sketch.excalidraw.md': '- [ ] 绘图噪声',
    },
    async (dir) => {
      const snapshot = await aggregate(vaultConfig(dir), { now: NOW });
      assert.equal(snapshot.todos.length, 1);
      assert.equal(snapshot.todos[0].text, '真实任务');
      assert.equal(snapshot.sources[0].files, 1);
    },
  );

  await withVault(
    {
      'keep.md': '- [ ] 保留',
      'skip/x.md': '- [ ] 自定义排除目录',
      'draft.draft.md': '- [ ] 自定义排除后缀',
      'other.draft.md': '- [ ] 另一个排除后缀',
    },
    async (dir) => {
      const snapshot = await aggregate(
        vaultConfig(dir, { excludeDirs: ['skip'], excludeSuffixes: ['.draft.md'] }),
        { now: NOW },
      );
      assert.deepEqual(snapshot.todos.map((todo) => todo.text), ['保留']);
      assert.equal(snapshot.sources[0].files, 1);
    },
  );
});

test('id 稳定且唯一；同一文件重扫 id 不变', async () => {
  const content = ['- [ ] 一', '- [ ] 二', '- [ ] 三'].join('\n');
  await withVault({ 'a.md': content, 'sub/b.md': '- [ ] 四' }, async (dir) => {
    const first = await aggregate(vaultConfig(dir), { now: NOW });
    const second = await aggregate(vaultConfig(dir, { cacheTtlMs: 0 }), { now: NOW, force: true });

    assert.deepEqual(second.todos.map((todo) => todo.id), first.todos.map((todo) => todo.id));
    const ids = first.todos.map((todo) => todo.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, /^md:obsidian-1:/);
    assert.equal(first.todos.find((todo) => todo.relPath === 'sub/b.md').id, 'md:obsidian-1:sub/b.md:1');
  });
});

/* ------------------------------------------------------------------ */
/* 限制 / 错误容忍                                                     */
/* ------------------------------------------------------------------ */

test('maxFileBytes：超大文件跳过，其余照常', async () => {
  await withVault(
    {
      'big.md': `- [ ] ${'x'.repeat(200)}`,
      'small.md': '- [ ] 小',
    },
    async (dir) => {
      const snapshot = await aggregate(vaultConfig(dir, { maxFileBytes: 50 }), { now: NOW });
      assert.equal(snapshot.sources[0].files, 1);
      assert.deepEqual(snapshot.todos.map((todo) => todo.text), ['小']);
    },
  );
});

test('maxFiles：超过上限停止并记 error，保留已解析结果', async () => {
  await withVault({ 'a.md': '- [ ] 甲', 'b.md': '- [ ] 乙' }, async (dir) => {
    const snapshot = await aggregate(vaultConfig(dir, { maxFiles: 1 }), { now: NOW });
    const source = snapshot.sources[0];
    assert.equal(source.files, 1);
    assert.equal(source.error, '文件数超过上限');
    assert.deepEqual(snapshot.todos.map((todo) => todo.text), ['甲']);
  });
});

test('markdown root 不存在：不抛错，source.error 有说明', async () => {
  await withVault({}, async (dir) => {
    const missing = path.join(dir, 'does-not-exist');
    const snapshot = await aggregate(
      {
        markdownRoots: [{ id: 'gone', label: ' Gone ', path: missing }],
        includeDshTodos: false,
        cacheTtlMs: 0,
      },
      { now: NOW },
    );
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.sources.length, 1);
    assert.equal(snapshot.sources[0].id, 'gone');
    assert.equal(snapshot.sources[0].files, 0);
    assert.equal(snapshot.sources[0].count, 0);
    assert.equal(typeof snapshot.sources[0].error, 'string');
    assert.ok(snapshot.sources[0].error.length > 0);
    assert.equal(snapshot.todos.length, 0);
    assert.deepEqual(snapshot.stats, {
      total: 0,
      open: 0,
      done: 0,
      cancelled: 0,
      overdue: 0,
      dueToday: 0,
      dueSoon: 0,
      undated: 0,
    });
  });
});

/* ------------------------------------------------------------------ */
/* DSH session todos                                                   */
/* ------------------------------------------------------------------ */

test('DSH todos：pending/in_progress 映射、坏 JSON/非数组缺字段全容忍、字段齐全', async () => {
  const sessionA = JSON.stringify({
    record: {
      rows: {
        title: { ver: 1, seq: 490, val: '会话 A' },
        workingDirectory: { ver: 1, seq: 490, val: 'C:\\proj\\a' },
        todos: {
          ver: 2,
          seq: 490,
          val: [
            { content: '任务一', status: 'pending' },
            { content: '  进行中任务  ', status: 'in_progress' },
            { content: '已完成任务', status: 'completed' },
            { content: '取消任务', status: 'cancelled' },
          ],
        },
      },
    },
  });
  const sessionB = JSON.stringify({ record: { rows: { title: { val: '会话 B' }, todos: { val: { nope: true } } } } });
  const weird = JSON.stringify({
    record: {
      rows: {
        todos: {
          val: [
            null,
            { status: 'pending' },
            { content: '   ', status: 'pending' },
            { content: '缺状态' },
            { content: '怪状态', status: 'weird' },
            { content: '正常', status: 'pending' },
          ],
        },
      },
    },
  });

  await withVault(
    {
      'vault/.keep': '',
      'dsh/sess-a.json': sessionA,
      'dsh/sess-b.json': sessionB,
      'dsh/broken.json': '{ not json',
      'dsh/weird.json': weird,
    },
    async (dir) => {
      const vaultDir = path.join(dir, 'vault');
      const dshDir = path.join(dir, 'dsh');
      const snapshot = await aggregate(
        { markdownRoots: [], includeDshTodos: true, dshCacheDir: dshDir, cacheTtlMs: 0 },
        { now: NOW },
      );

      assert.equal(snapshot.sources.length, 1);
      const source = snapshot.sources[0];
      assert.equal(source.id, 'dsh-sessions');
      assert.equal(source.kind, 'dsh');
      assert.equal(source.label, 'DSH 会话 (AI 抽取)');
      assert.equal(source.path, dshDir);
      assert.equal(source.files, 4);
      assert.equal(source.error, null);
      assert.equal(source.count, 3);
      assert.equal(source.open, 3);
      assert.equal(source.done, 0);

      assert.deepEqual(
        snapshot.todos.map((todo) => todo.text).sort(),
        ['任务一', '正常', '进行中任务'].sort(),
      );
      for (const todo of snapshot.todos) {
        assert.equal(todo.kind, 'dsh');
        assert.equal(todo.sourceId, 'dsh-sessions');
        assert.equal(todo.file, null);
        assert.equal(todo.relPath, null);
        assert.equal(todo.line, null);
        assert.equal(todo.heading, null);
        assert.equal(todo.indent, 0);
        assert.equal(todo.noteDate, null);
        assert.equal(todo.due, null);
        assert.deepEqual(todo.tags, []);
        assert.deepEqual(todo.links, []);
        assert.equal(todo.done, false);
        assert.equal(todo.cancelled, false);
        for (const key of TODO_KEYS) assert.ok(key in todo, `todo 缺字段 ${key}`);
      }

      const first = snapshot.todos.find((todo) => todo.text === '任务一');
      assert.equal(first.id, 'dsh:sess-a:0');
      assert.equal(first.sessionId, 'sess-a');
      assert.equal(first.sessionTitle, '会话 A');
      assert.equal(first.project, 'C:\\proj\\a');

      assert.equal(snapshot.todos.find((todo) => todo.text === '进行中任务').sessionId, 'sess-a');
      assert.equal(snapshot.todos.find((todo) => todo.text === '正常').id, 'dsh:weird:5');
      assert.equal(snapshot.todos.find((todo) => todo.text === '正常').sessionTitle, null);
      assert.equal(snapshot.todos.find((todo) => todo.text === '正常').project, null);

      // includeDshCompleted 打开后包含 completed，但仍不含 cancelled
      const withDone = await aggregate(
        {
          markdownRoots: [],
          includeDshTodos: true,
          includeDshCompleted: true,
          dshCacheDir: dshDir,
          cacheTtlMs: 0,
        },
        { now: NOW },
      );
      assert.equal(withDone.sources[0].count, 4);
      assert.equal(withDone.sources[0].done, 1);
      assert.equal(withDone.sources[0].open, 3);
      assert.ok(withDone.todos.some((todo) => todo.text === '已完成任务' && todo.done === true));
      assert.ok(!withDone.todos.some((todo) => todo.text === '取消任务'));

      // dshMaxSessions = 0：不读取任何会话
      const none = await aggregate(
        {
          markdownRoots: [],
          includeDshTodos: true,
          dshCacheDir: dshDir,
          dshMaxSessions: 0,
          cacheTtlMs: 0,
        },
        { now: NOW },
      );
      assert.equal(none.sources[0].files, 0);
      assert.equal(none.sources[0].count, 0);
      assert.equal(none.sources[0].error, null);
    },
  );
});

test('DSH 目录不存在：source.error 说明，不抛错；includeDshTodos=false 时没有 dsh source', async () => {
  await withVault({}, async (dir) => {
    const missing = path.join(dir, 'no-dsh');
    const snapshot = await aggregate(
      { markdownRoots: [], includeDshTodos: true, dshCacheDir: missing, cacheTtlMs: 0 },
      { now: NOW },
    );
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.sources.length, 1);
    assert.equal(snapshot.sources[0].kind, 'dsh');
    assert.equal(snapshot.sources[0].files, 0);
    assert.equal(typeof snapshot.sources[0].error, 'string');
    assert.ok(snapshot.sources[0].error.length > 0);
    assert.equal(snapshot.todos.length, 0);

    const disabled = await aggregate(
      { markdownRoots: [], includeDshTodos: false, cacheTtlMs: 0 },
      { now: NOW },
    );
    assert.deepEqual(disabled.sources, []);
  });
});

/* ------------------------------------------------------------------ */
/* stats                                                               */
/* ------------------------------------------------------------------ */

test('stats：本地时区 overdue / dueToday / dueSoon（不含今天、含第 7 天）/ undated', async () => {
  const content = [
    '- [ ] 逾期一 📅 2026-10-26',
    '- [ ] 逾期二 📅 2026-10-20',
    '- [ ] 今天 📅 2026-10-27',
    '- [ ] 明天 📅 2026-10-28',
    '- [ ] 第七天 📅 2026-11-03',
    '- [ ] 第八天 📅 2026-11-04',
    '- [ ] 无日期',
    '- [x] 完成逾期 📅 2026-10-01',
    '- [x] 完成无日期',
  ].join('\n');

  await withVault({ 'stats.md': content }, async (dir) => {
    const snapshot = await aggregate(vaultConfig(dir), { now: NOW });
    assert.equal(snapshot.generatedAt, NOW.toISOString());
    assert.deepEqual(snapshot.stats, {
      total: 9,
      open: 7,
      done: 2,
      cancelled: 0,
      overdue: 2,
      dueToday: 1,
      dueSoon: 2,
      undated: 1,
    });
  });
});

/* ------------------------------------------------------------------ */
/* Snapshot 形状 / config 摘要                                          */
/* ------------------------------------------------------------------ */

test('Snapshot 形状齐全，config 摘要只含 includeDshTodos / markdownRootCount', async () => {
  await withVault({ 'a.md': '- [ ] 甲' }, async (dir) => {
    const snapshot = await aggregate(vaultConfig(dir), { now: NOW });
    for (const key of SNAPSHOT_KEYS) assert.ok(key in snapshot, `snapshot 缺字段 ${key}`);
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.version, 1);
    assert.equal(typeof snapshot.tookMs, 'number');
    assert.ok(snapshot.tookMs >= 0);
    assert.deepEqual(snapshot.config, { includeDshTodos: false, markdownRootCount: 1 });
  });
});

/* ------------------------------------------------------------------ */
/* 缓存 / 并发                                                         */
/* ------------------------------------------------------------------ */

test('aggregate 缓存：TTL 内复用同一快照引用，force 绕过并刷新缓存', async () => {
  await withVault({ 'a.md': '- [ ] 一' }, async (dir) => {
    const config = vaultConfig(dir, { cacheTtlMs: 60_000 });
    const filePath = path.join(dir, 'a.md');

    const first = await aggregate(config, { now: NOW });
    assert.equal(first.todos.length, 1);

    const second = await aggregate(config, { now: new Date(NOW.getTime() + 1_000) });
    assert.strictEqual(second, first);

    await fs.writeFile(filePath, '- [ ] 一\n- [ ] 二\n', 'utf8');
    const forced = await aggregate(config, { now: NOW, force: true });
    assert.equal(forced.todos.length, 2);
    assert.notStrictEqual(forced, first);

    const cachedAfterForced = await aggregate(config, { now: NOW });
    assert.strictEqual(cachedAfterForced, forced);
  });
});

test('aggregate 并发调用共用 inflight promise', async () => {
  await withVault({ 'a.md': '- [ ] 一' }, async (dir) => {
    const config = vaultConfig(dir, { cacheTtlMs: 0 });
    const [a, b] = await Promise.all([aggregate(config, { now: NOW }), aggregate(config, { now: NOW })]);
    assert.strictEqual(a, b);
  });
});

/* ------------------------------------------------------------------ */
/* cancelled（作废）与空任务丢弃（契约 v1 追补）                        */
/* ------------------------------------------------------------------ */

test('cancelled：[-]/[/] 与整体 ~~…~~ 包裹；内部 ~~ 不算作废', async () => {
  const content = [
    '- [-] 手工作废',
    '- [/] 斜杠作废',
    '- [ ] ~~废弃的想法~~',
    '- [x] ~~已完成但作废~~',
    '- [ ] 部分 ~~删除线~~ 不算作废',
    '- [-] 带日期作废 📅 2026-10-30',
    '- [ ] ~~带日期作废二~~ 📅 2026-11-01',
    '- [ ] ~~ 带空格作废 ~~',
  ].join('\n');

  await withVault({ 'cancel.md': content }, async (dir) => {
    const snapshot = await aggregate(vaultConfig(dir), { now: NOW });
    const { todos } = snapshot;
    assert.equal(todos.length, 8);

    assert.equal(findTodo(todos, '手工作废').cancelled, true);
    assert.equal(findTodo(todos, '手工作废').done, false);
    assert.equal(findTodo(todos, '斜杠作废').cancelled, true);
    assert.equal(findTodo(todos, '斜杠作废').done, false);

    const striked = findTodo(todos, '废弃的想法');
    assert.equal(striked.cancelled, true);
    assert.equal(striked.done, false);
    assert.equal(striked.raw, '- [ ] ~~废弃的想法~~');

    const doneButStruck = findTodo(todos, '已完成但作废');
    assert.equal(doneButStruck.cancelled, true);
    assert.equal(doneButStruck.done, false);

    const partial = findTodo(todos, '部分 ~~删除线~~ 不算作废');
    assert.equal(partial.cancelled, false);
    assert.equal(partial.done, false);

    const datedMark = findTodo(todos, '带日期作废');
    assert.equal(datedMark.cancelled, true);
    assert.equal(datedMark.due, '2026-10-30');

    const datedStrike = findTodo(todos, '带日期作废二');
    assert.equal(datedStrike.cancelled, true);
    assert.equal(datedStrike.due, '2026-11-01');

    const spacedStrike = findTodo(todos, '带空格作废');
    assert.equal(spacedStrike.cancelled, true);
    assert.equal(spacedStrike.done, false);

    // source 计数口径：open = !done && !cancelled
    const source = snapshot.sources[0];
    assert.equal(source.count, 8);
    assert.equal(source.open, 1);
    assert.equal(source.done, 0);
  });
});

test('空任务丢弃：空正文、元数据-only、~~包裹后为空都不产出', async () => {
  const content = [
    '- [ ]',
    '- [ ]   ',
    '- [ ] 📅 2026-10-30',
    '- [ ] 🔺',
    '- [ ] ~~ ~~',
    '- [ ] ~~📅 2026-10-30~~',
    '- [x]',
    '- [-]',
    '- [ ] 有内容',
  ].join('\n');

  await withVault({ 'empty.md': content }, async (dir) => {
    const snapshot = await aggregate(vaultConfig(dir), { now: NOW });
    assert.equal(snapshot.todos.length, 1);
    assert.equal(snapshot.todos[0].text, '有内容');
    assert.equal(snapshot.todos[0].cancelled, false);
    assert.equal(snapshot.sources[0].count, 1);
    assert.equal(snapshot.sources[0].open, 1);
  });
});

test('默认 excludeDirs 命中 _history / 00legacy / _论文 目录时不计入', async () => {
  await withVault(
    {
      'real.md': '- [ ] 真实任务',
      '_history/top.md': '- [ ] 顶层 history 噪声',
      '小组汇报记录/_history/模板.md': '- [ ] memU 模板噪声',
      '00legacy/old.md': '- [ ] legacy 噪声',
      '_论文/paper.md': '- [ ] 论文目录噪声',
    },
    async (dir) => {
      const snapshot = await aggregate(vaultConfig(dir), { now: NOW });
      assert.deepEqual(snapshot.todos.map((todo) => todo.text), ['真实任务']);
      assert.equal(snapshot.sources[0].files, 1);
      assert.equal(snapshot.sources[0].count, 1);
    },
  );
});

test('cancelled 计数口径：source 的 open/done 排除 cancelled；stats 新增 cancelled 且不进日期桶', async () => {
  const content = [
    '- [ ] 开放任务',
    '- [ ] 开放逾期 📅 2026-10-26',
    '- [x] 完成任务',
    '- [x] 完成逾期 📅 2026-10-01',
    '- [-] 作废任务',
    '- [ ] ~~作废表情~~',
    '- [-] ~~作废带日期~~ 📅 2026-10-20',
  ].join('\n');

  await withVault({ 'counts.md': content }, async (dir) => {
    const snapshot = await aggregate(vaultConfig(dir), { now: NOW });
    const source = snapshot.sources[0];
    assert.equal(source.count, 7);
    assert.equal(source.open, 2);
    assert.equal(source.done, 2);

    assert.equal(snapshot.todos.length, 7);
    for (const todo of snapshot.todos) {
      assert.equal(typeof todo.cancelled, 'boolean');
    }
    assert.equal(findTodo(snapshot.todos, '作废任务').cancelled, true);
    assert.equal(findTodo(snapshot.todos, '作废表情').cancelled, true);
    assert.equal(findTodo(snapshot.todos, '作废带日期').cancelled, true);
    assert.equal(findTodo(snapshot.todos, '作废带日期').due, '2026-10-20');

    assert.deepEqual(snapshot.stats, {
      total: 7,
      open: 2,
      done: 2,
      cancelled: 3,
      overdue: 1,
      dueToday: 0,
      dueSoon: 0,
      undated: 1,
    });
  });
});
