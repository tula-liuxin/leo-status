/**
 * leo-status/scan.js · v0.4 Obsidian 自动发现 / 规则解析 / 增量缓存 单测
 *
 * 全部使用 os.tmpdir() 下的临时 fixture；不读取、不修改真实用户笔记。
 * 运行：node --test test/discover.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { aggregate, detectVaults, normalizeConfig } from '../scan.js';

/** 固定“当前时间”：本地时区 2026-10-27 12:00:00 */
const NOW = new Date(2026, 9, 27, 12, 0, 0);

/* ------------------------------------------------------------------ */
/* 测试工具                                                            */
/* ------------------------------------------------------------------ */

async function withTemp(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leo-status-discover-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeFiles(root, files) {
  for (const [relPath, content] of Object.entries(files)) {
    const filePath = path.join(root, ...relPath.split('/'));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
  }
}

/** 建一个 vault：<dir>/<name>/.obsidian + 若干 .md。 */
async function makeVault(dir, name, notes = {}) {
  const vaultDir = path.join(dir, name);
  await fs.mkdir(path.join(vaultDir, '.obsidian'), { recursive: true });
  await writeFiles(vaultDir, notes);
  return vaultDir;
}

/** 显式 roots 的扫描配置（关闭 autoDetect，避免碰真实目录）。 */
function rootConfig(dir, extra = {}) {
  return {
    markdownRoots: [{ path: dir }],
    includeDshTodos: false,
    autoDetect: false,
    cacheTtlMs: 0,
    ...extra,
  };
}

/** 空 roots + 自动发现的扫描配置。 */
function detectConfig(searchDir, extra = {}) {
  return {
    markdownRoots: [],
    includeDshTodos: false,
    autoDetect: true,
    searchRoots: [searchDir],
    vaultMaxDepth: 4,
    cacheTtlMs: 0,
    ...extra,
  };
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function byText(todos, text) {
  const todo = todos.find((item) => item.text === text);
  assert.ok(todo, `未找到 text=${JSON.stringify(text)}，实际: ${todos.map((t) => t.text).join(' | ')}`);
  return todo;
}

/* ------------------------------------------------------------------ */
/* detectVaults                                                        */
/* ------------------------------------------------------------------ */

test('detectVaults：找出含 .obsidian 的目录、noteCount/lastMtimeMs、按 noteCount 降序', async () => {
  await withTemp(async (dir) => {
    const search = path.join(dir, 'search');
    const small = await makeVault(search, 'vaultSmall', { 'a.md': '# a\n' });
    const big = await makeVault(search, 'vaultBig', {
      'a.md': '# a\n',
      'b.md': '# b\n',
      'sub/c.md': '# c\n',
    });
    await writeFiles(search, { 'plain/readme.txt': 'no vault here\n' });

    const vaults = await detectVaults({ searchRoots: [search] });
    assert.equal(vaults.length, 2);
    assert.deepEqual(
      vaults.map((vault) => vault.name),
      ['vaultBig', 'vaultSmall'],
    );
    assert.equal(vaults[0].noteCount, 3);
    assert.equal(vaults[1].noteCount, 1);
    assert.equal(vaults[0].path, big);
    assert.equal(vaults[1].path, small);
    for (const vault of vaults) {
      assert.equal(typeof vault.lastMtimeMs, 'number');
      assert.ok(vault.lastMtimeMs > 0);
    }

    // limit 截断
    const limited = await detectVaults({ searchRoots: [search], limit: 1 });
    assert.equal(limited.length, 1);
    assert.equal(limited[0].name, 'vaultBig');

    // 重复 searchRoot 去重
    const deduped = await detectVaults({ searchRoots: [search, search] });
    assert.equal(deduped.length, 2);
  });
});

test('detectVaults：maxDepth 生效、跳过 .git / node_modules / 不存在的根', async () => {
  await withTemp(async (dir) => {
    const search = path.join(dir, 'search');
    await fs.mkdir(search, { recursive: true });
    // 深度 3 的 vault
    await makeVault(path.join(search, 'a', 'b'), 'deep3', { 'x.md': '# x\n' });
    // 深度 4 的 vault
    await makeVault(path.join(search, 'a', 'b', 'c'), 'deep4', { 'y.md': '# y\n' });
    // 应被跳过的目录
    await makeVault(path.join(search, '.git'), 'gitVault', { 'z.md': '# z\n' });
    await makeVault(path.join(search, 'node_modules'), 'nmVault', { 'w.md': '# w\n' });

    const depth3 = await detectVaults({ searchRoots: [search], maxDepth: 3 });
    assert.deepEqual(depth3.map((vault) => vault.name), ['deep3']);
    const depth4 = await detectVaults({ searchRoots: [search], maxDepth: 4 });
    assert.deepEqual(depth4.map((vault) => vault.name).sort(), ['deep3', 'deep4']);

    const missing = await detectVaults({ searchRoots: [path.join(dir, 'nope')] });
    assert.deepEqual(missing, []);

    // AbortSignal：不抛错即可（允许返回部分结果）
    const controller = new AbortController();
    controller.abort();
    const aborted = await detectVaults({ searchRoots: [search], signal: controller.signal });
    assert.ok(Array.isArray(aborted));
  });
});

/* ------------------------------------------------------------------ */
/* aggregate：自动发现 + meta                                           */
/* ------------------------------------------------------------------ */

test('aggregate：markdownRoots 为空且 autoDetect 时自动接入发现的 vault', async () => {
  await withTemp(async (dir) => {
    const search = path.join(dir, 'search');
    const vaultDir = await makeVault(search, 'AutoVault', { 'idea.md': '- [ ] 自动发现的任务\n' });

    const snapshot = await aggregate(detectConfig(search), { now: NOW, force: true });
    assert.equal(snapshot.sources.length, 1);
    const source = snapshot.sources[0];
    assert.equal(source.kind, 'markdown');
    assert.match(source.id, /^vault-[0-9a-f]{8}$/);
    assert.equal(source.label, 'AutoVault');
    assert.equal(source.path, vaultDir);
    assert.equal(source.count, 1);
    assert.deepEqual(snapshot.meta.discoveredVaults, [{ path: vaultDir, name: 'AutoVault', noteCount: 1 }]);
    assert.deepEqual(snapshot.meta.cache, { enabled: false, files: 0, hits: 0, misses: 0 });
    assert.equal(snapshot.config.markdownRootCount, 1);
    assert.equal(snapshot.todos[0].text, '自动发现的任务');
    assert.equal(snapshot.todos[0].sourceId, source.id);
  });
});

test('aggregate：autoDetect=false 或已有 roots 时不自动发现', async () => {
  await withTemp(async (dir) => {
    const search = path.join(dir, 'search');
    await makeVault(search, 'IgnoredVault', { 'a.md': '- [ ] 不该出现\n' });

    const disabled = await aggregate(detectConfig(search, { autoDetect: false }), { now: NOW, force: true });
    assert.deepEqual(disabled.sources, []);
    assert.deepEqual(disabled.todos, []);
    assert.deepEqual(disabled.meta.discoveredVaults, []);
    assert.equal(disabled.config.markdownRootCount, 0);

    const explicit = await aggregate(
      { ...rootConfig(path.join(search, 'IgnoredVault')), autoDetect: true },
      { now: NOW, force: true },
    );
    assert.equal(explicit.sources.length, 1);
    assert.equal(explicit.sources[0].id, 'obsidian-1');
    assert.deepEqual(explicit.meta.discoveredVaults, []);
  });
});

/* ------------------------------------------------------------------ */
/* 规则解析：tag 行 / marker 行                                        */
/* ------------------------------------------------------------------ */

test('tagLines：含 #todo/#task/#待办 的行（含 #todo/must），checkbox 行优先', async () => {
  const content = [
    '## 工作',
    '- #todo 写文档',
    '* #task 修复 bug',
    '今天 #待办 整理资料',
    '#todo/must 子标签任务',
    '#其他 普通标签行',
    '- [ ] #todo 复选框优先',
  ].join('\n');

  await withTemp(async (dir) => {
    await writeFiles(dir, { 'tags.md': content });
    const snapshot = await aggregate(rootConfig(dir), { now: NOW, force: true });

    assert.deepEqual(snapshot.todos.map((todo) => todo.text), [
      '写文档',
      '修复 bug',
      '今天 整理资料',
      '子标签任务',
      '复选框优先',
    ]);
    assert.deepEqual(snapshot.todos.map((todo) => todo.line), [2, 3, 4, 5, 7]);

    const tagTodo = byText(snapshot.todos, '写文档');
    assert.equal(tagTodo.discoveredBy, 'tag');
    assert.equal(tagTodo.writable, false);
    assert.equal(tagTodo.confidence, 0.8);
    assert.deepEqual(tagTodo.tags, ['todo']);
    assert.equal(tagTodo.heading, '工作');
    assert.equal(tagTodo.raw, '- #todo 写文档');
    assert.equal(tagTodo.done, false);

    assert.deepEqual(byText(snapshot.todos, '修复 bug').tags, ['task']);
    assert.deepEqual(byText(snapshot.todos, '今天 整理资料').tags, ['待办']);
    assert.deepEqual(byText(snapshot.todos, '子标签任务').tags, ['todo/must']);

    const checkboxTodo = byText(snapshot.todos, '复选框优先');
    assert.equal(checkboxTodo.discoveredBy, 'checkbox');
    assert.equal(checkboxTodo.writable, true);
    assert.equal(checkboxTodo.confidence, 1);
    assert.deepEqual(checkboxTodo.tags, ['todo']);

    assert.deepEqual(snapshot.stats.discovered, { checkbox: 1, tag: 4, frontmatter: 0, marker: 0 });
  });
});

test('tagLines=false 时只识别 checkbox', async () => {
  await withTemp(async (dir) => {
    await writeFiles(dir, { 'tags.md': '- #todo 只有标签\n- [ ] 复选框\n' });
    const snapshot = await aggregate(
      rootConfig(dir, { conventions: { tagLines: false } }),
      { now: NOW, force: true },
    );
    assert.deepEqual(snapshot.todos.map((todo) => todo.text), ['复选框']);
  });
});

test('conventions.checkbox=false：复选框行整行跳过（tag 也不会误捡），普通 tag 行仍识别', async () => {
  await withTemp(async (dir) => {
    await writeFiles(dir, { 'off.md': '- [ ] #todo 复选框行\n- #todo 标签行\n' });
    const snapshot = await aggregate(
      rootConfig(dir, { conventions: { checkbox: false } }),
      { now: NOW, force: true },
    );
    assert.deepEqual(snapshot.todos.map((todo) => todo.text), ['标签行']);
    assert.equal(snapshot.todos[0].discoveredBy, 'tag');
    assert.equal(snapshot.stats.discovered.checkbox, 0);
    assert.equal(snapshot.stats.discovered.tag, 1);
  });
});

test('markers：TODO: / 待办： / FIXME:（大小写不敏感），默认关闭', async () => {
  const content = [
    '## 维护',
    '- TODO: 做某事',
    '待办：中文冒号任务',
    'FIXME: 修 bug',
    'todo: 小写也能匹配',
    'TODO:',
    '- [ ] TODO: 复选框内',
  ].join('\n');

  await withTemp(async (dir) => {
    await writeFiles(dir, { 'markers.md': content });

    // 默认 markers=false：没有任何 marker todo
    const off = await aggregate(rootConfig(dir), { now: NOW, force: true });
    assert.deepEqual(off.todos.map((todo) => todo.text), ['TODO: 复选框内']);

    // 打开 markers
    const on = await aggregate(
      rootConfig(dir, { conventions: { markers: true, tagLines: false } }),
      { now: NOW, force: true },
    );
    assert.deepEqual(on.todos.map((todo) => todo.text), [
      '做某事',
      '中文冒号任务',
      '修 bug',
      '小写也能匹配',
      'TODO:',
      'TODO: 复选框内',
    ]);
    const markerTodo = byText(on.todos, '做某事');
    assert.equal(markerTodo.discoveredBy, 'marker');
    assert.equal(markerTodo.writable, false);
    assert.equal(markerTodo.confidence, 0.75);
    assert.equal(markerTodo.heading, '维护');
    assert.equal(byText(on.todos, '中文冒号任务').discoveredBy, 'marker');
    assert.equal(byText(on.todos, 'TODO:').discoveredBy, 'marker');
    assert.equal(byText(on.todos, 'TODO: 复选框内').discoveredBy, 'checkbox');
  });
});

/* ------------------------------------------------------------------ */
/* frontmatter 标记 / frontmatter-list                                 */
/* ------------------------------------------------------------------ */

test('frontmatter：todo:true / status:todo / tags 含 todo 给文件加 fileFlag', async () => {
  await withTemp(async (dir) => {
    await writeFiles(dir, {
      'a.md': '---\ntodo: true\n---\n- [ ] 任务A\n',
      'b.md': '---\nstatus: todo\n---\n- [ ] 任务B\n',
      'c.md': '---\ntags:\n  - task\n---\n- [ ] 任务C\n',
      'd.md': '---\ntags: [x, y]\n---\n- [ ] 任务D\n',
    });
    const snapshot = await aggregate(rootConfig(dir), { now: NOW, force: true });
    for (const text of ['任务A', '任务B', '任务C']) {
      const todo = byText(snapshot.todos, text);
      assert.equal(todo.fileFlag, 'todo', `${text} 应带 fileFlag`);
      assert.equal(todo.writable, true);
      assert.equal(todo.confidence, 1);
    }
    assert.equal(byText(snapshot.todos, '任务D').fileFlag, null);

    // conventions.frontmatter=false：不再有 fileFlag
    const off = await aggregate(
      rootConfig(dir, { conventions: { frontmatter: false } }),
      { now: NOW, force: true },
    );
    assert.ok(off.todos.every((todo) => todo.fileFlag === null));
  });
});

test('frontmatter-list：todos 块列表/行内数组合成 todo，line=0 不可写，与 checkbox 文本去重', async () => {
  await withTemp(async (dir) => {
    await writeFiles(dir, {
      'block.md': ['---', 'todos:', '  - 买牛奶', '  - 写报告', '---', '- [ ] 写报告'].join('\n'),
      'inline.md': '---\ntodos: [A 任务, "B 任务"]\n---\n- [ ] 其他任务\n',
    });
    const snapshot = await aggregate(rootConfig(dir), { now: NOW, force: true });

    const blockTodos = snapshot.todos.filter((todo) => todo.relPath === 'block.md');
    assert.deepEqual(blockTodos.map((todo) => todo.text), ['写报告', '买牛奶']);
    const fmTodo = byText(snapshot.todos, '买牛奶');
    assert.equal(fmTodo.id, 'md:obsidian-1:block.md:fm:0');
    assert.equal(fmTodo.line, 0);
    assert.equal(fmTodo.raw, '');
    assert.equal(fmTodo.discoveredBy, 'frontmatter-list');
    assert.equal(fmTodo.writable, false);
    assert.equal(fmTodo.confidence, 0.7);
    assert.equal(fmTodo.fileFlag, null);

    const inlineTodos = snapshot.todos
      .filter((todo) => todo.relPath === 'inline.md' && todo.discoveredBy === 'frontmatter-list')
      .map((todo) => todo.text);
    assert.deepEqual(inlineTodos.sort(), ['A 任务', 'B 任务']);

    // frontmatterList=false：不合成
    const off = await aggregate(
      rootConfig(dir, { conventions: { frontmatterList: false } }),
      { now: NOW, force: true },
    );
    assert.ok(!off.todos.some((todo) => todo.discoveredBy === 'frontmatter-list'));
  });
});

/* ------------------------------------------------------------------ */
/* 绘图段 / 代码围栏 / 标题状态                                         */
/* ------------------------------------------------------------------ */

test('## Drawing / ## Text Elements 段内 checkbox 与 tag 行都被跳过', async () => {
  const content = [
    '## 安排',
    '- [ ] 正常任务',
    '## Drawing',
    '- [ ] 绘图噪声',
    '#todo 绘图标签噪声',
    '```',
    '- [ ] 围栏内噪声',
    '```',
    '## Text Elements',
    '- [ ] 文本元素噪声',
    '## 后续',
    '- [ ] 正常任务2',
  ].join('\n');

  await withTemp(async (dir) => {
    await writeFiles(dir, { 'drawing.md': content });
    const snapshot = await aggregate(rootConfig(dir), { now: NOW, force: true });
    assert.deepEqual(snapshot.todos.map((todo) => todo.text), ['正常任务', '正常任务2']);
    assert.equal(byText(snapshot.todos, '正常任务').heading, '安排');
    assert.equal(byText(snapshot.todos, '正常任务2').heading, '后续');
  });
});

test('headingStatus：最近标题推断 done / in_progress / blocked / pending，不改 done 布尔', async () => {
  const content = [
    '## 已完成',
    '- [ ] 完成区任务',
    '## 进行中',
    '- [ ] 进行区任务',
    '## 阻塞区',
    '- [ ] 阻塞区任务',
    '## 待办',
    '- [ ] 待办区任务',
    '- [x] 完成但属待办',
    '## 普通',
    '- [ ] 普通任务',
  ].join('\n');

  await withTemp(async (dir) => {
    await writeFiles(dir, { 'status.md': content });
    const snapshot = await aggregate(rootConfig(dir), { now: NOW, force: true });
    assert.equal(byText(snapshot.todos, '完成区任务').headingStatus, 'done');
    assert.equal(byText(snapshot.todos, '完成区任务').done, false);
    assert.equal(byText(snapshot.todos, '进行区任务').headingStatus, 'in_progress');
    assert.equal(byText(snapshot.todos, '阻塞区任务').headingStatus, 'blocked');
    assert.equal(byText(snapshot.todos, '待办区任务').headingStatus, 'pending');
    assert.equal(byText(snapshot.todos, '完成但属待办').headingStatus, 'pending');
    assert.equal(byText(snapshot.todos, '完成但属待办').done, true);
    assert.equal(byText(snapshot.todos, '普通任务').headingStatus, null);

    const off = await aggregate(
      rootConfig(dir, { conventions: { headingStatus: false } }),
      { now: NOW, force: true },
    );
    assert.ok(off.todos.every((todo) => todo.headingStatus === null));
  });
});

/* ------------------------------------------------------------------ */
/* 增量缓存                                                            */
/* ------------------------------------------------------------------ */

test('增量缓存：hits/misses、改内容/mtime 重解析、删文件移除、坏缓存容错、只存 todo 数据', async () => {
  await withTemp(async (dir) => {
    const vaultDir = path.join(dir, 'vault');
    await writeFiles(vaultDir, {
      'a.md': '- [ ] 任务A\n\nSECRET_BODY_ONLY_LINE\n',
      'b.md': '- [ ] 任务B\n',
    });
    const cacheFile = path.join(dir, 'data', 'cache', 'scan-cache.json');
    const config = rootConfig(vaultDir, { cacheFile });

    // 首次：全部 miss，缓存落盘
    const first = await aggregate(config, { now: NOW, force: true });
    assert.deepEqual(first.meta.cache, { enabled: true, files: 2, hits: 0, misses: 2 });
    assert.equal(first.todos.length, 2);

    const cacheRaw = await fs.readFile(cacheFile, 'utf8');
    assert.ok(!cacheRaw.includes('SECRET_BODY_ONLY_LINE'), '缓存不得包含笔记全文');
    const cacheJson = JSON.parse(cacheRaw);
    assert.equal(cacheJson.version, 1);
    const rootEntry = cacheJson.roots['obsidian-1'];
    assert.ok(rootEntry, '缓存应包含 rootId 条目');
    assert.deepEqual(Object.keys(rootEntry.files).sort(), ['a.md', 'b.md']);
    for (const entry of Object.values(rootEntry.files)) {
      assert.equal(typeof entry.mtimeMs, 'number');
      assert.equal(typeof entry.size, 'number');
      assert.ok(Array.isArray(entry.todos));
    }

    // 二次：全部 hit，结果一致
    const second = await aggregate(config, { now: NOW, force: true });
    assert.deepEqual(second.meta.cache, { enabled: true, files: 2, hits: 2, misses: 0 });
    assert.deepEqual(second.todos, first.todos);

    // 改内容：该文件 miss 重解析
    await fs.writeFile(path.join(vaultDir, 'b.md'), '- [ ] 任务B2\n- [ ] 新增B3\n', 'utf8');
    const third = await aggregate(config, { now: NOW, force: true });
    assert.deepEqual(third.meta.cache, { enabled: true, files: 2, hits: 1, misses: 1 });
    assert.ok(third.todos.some((todo) => todo.text === '任务B2'));
    assert.ok(third.todos.some((todo) => todo.text === '新增B3'));

    // 只改 mtime（内容不变）：仍然 miss 并重新解析
    const bPath = path.join(vaultDir, 'b.md');
    const future = new Date(Date.now() + 5000);
    await fs.utimes(bPath, future, future);
    const fourth = await aggregate(config, { now: NOW, force: true });
    assert.deepEqual(fourth.meta.cache, { enabled: true, files: 2, hits: 1, misses: 1 });
    assert.ok(fourth.todos.some((todo) => todo.text === '任务B2'));

    // 删除文件：从缓存移除
    await fs.rm(path.join(vaultDir, 'a.md'));
    const fifth = await aggregate(config, { now: NOW, force: true });
    assert.deepEqual(fifth.meta.cache, { enabled: true, files: 1, hits: 1, misses: 0 });
    const afterDelete = await readJson(cacheFile);
    assert.deepEqual(Object.keys(afterDelete.roots['obsidian-1'].files), ['b.md']);

    // 坏缓存：读失败不抛，按空缓存重新解析并覆盖
    await fs.writeFile(cacheFile, '{ not json', 'utf8');
    const sixth = await aggregate(config, { now: NOW, force: true });
    assert.equal(sixth.meta.cache.enabled, true);
    assert.equal(sixth.meta.cache.hits, 0);
    assert.equal(sixth.meta.cache.misses, 1);
    assert.equal(sixth.todos.length, 2);
    assert.equal((await readJson(cacheFile)).version, 1);

    // 原子写：无 .tmp 残留
    const leftovers = (await fs.readdir(path.dirname(cacheFile))).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);

    // 关闭 cache（cacheFile 为空）时 meta.cache 全零
    const noCache = await aggregate(rootConfig(vaultDir), { now: NOW, force: true });
    assert.deepEqual(noCache.meta.cache, { enabled: false, files: 0, hits: 0, misses: 0 });
  });
});

test('自动发现的 vault root id 稳定，二次扫描缓存命中', async () => {
  await withTemp(async (dir) => {
    const search = path.join(dir, 'search');
    const vaultDir = await makeVault(search, 'CacheVault', { 'note.md': '- [ ] 缓存任务\n' });
    const cacheFile = path.join(dir, 'cache', 'scan-cache.json');
    const config = detectConfig(search, { cacheFile });

    const first = await aggregate(config, { now: NOW, force: true });
    assert.equal(first.sources.length, 1);
    const rootId = first.sources[0].id;
    assert.match(rootId, /^vault-[0-9a-f]{8}$/);
    assert.equal(first.meta.cache.misses, 1);
    assert.equal(first.todos.length, 1);
    assert.equal(first.todos[0].file, path.join(vaultDir, 'note.md'));

    const second = await aggregate(config, { now: NOW, force: true });
    assert.equal(second.sources[0].id, rootId); // id 稳定
    assert.equal(second.meta.cache.hits, 1);
    assert.equal(second.meta.cache.misses, 0);
    assert.deepEqual(second.todos, first.todos);
  });
});

/* ------------------------------------------------------------------ */
/* normalizeConfig：v0.4 字段                                          */
/* ------------------------------------------------------------------ */

test('normalizeConfig：v0.4 字段默认值 / 校验 / 幂等', () => {
  const config = normalizeConfig({});
  assert.deepEqual(config.conventions, {
    checkbox: true,
    tagLines: true,
    tags: ['todo', 'task', '待办', 'TODO'],
    frontmatter: true,
    frontmatterList: true,
    markers: false,
    markerWords: ['TODO', '待办', 'FIXME'],
    headingStatus: true,
  });
  assert.equal(config.autoDetect, true);
  assert.deepEqual(config.searchRoots, []);
  assert.equal(config.vaultMaxDepth, 4);
  assert.equal(config.cacheFile, '');

  const custom = normalizeConfig({
    conventions: { markers: true, tags: ['待办'], headingStatus: false },
    autoDetect: false,
    searchRoots: ['C:\\notes'],
    vaultMaxDepth: 2,
    cacheFile: 'C:\\data\\cache.json',
  });
  assert.equal(custom.conventions.markers, true);
  assert.deepEqual(custom.conventions.tags, ['待办']);
  assert.equal(custom.conventions.headingStatus, false);
  assert.equal(custom.conventions.checkbox, true); // 未提供的字段兜底
  assert.equal(custom.autoDetect, false);
  assert.deepEqual(custom.searchRoots, ['C:\\notes']);
  assert.equal(custom.vaultMaxDepth, 2);
  assert.equal(custom.cacheFile, 'C:\\data\\cache.json');
  assert.deepEqual(normalizeConfig(custom), custom); // 幂等

  for (const raw of [
    { conventions: 'x' },
    { conventions: { tags: [] } },
    { conventions: { tags: [''] } },
    { conventions: { markerWords: [1] } },
    { autoDetect: 'yes' },
    { searchRoots: 'C:\\notes' },
    { searchRoots: [1] },
    { vaultMaxDepth: -1 },
    { vaultMaxDepth: 1.5 },
    { cacheFile: 3 },
  ]) {
    assert.throws(
      () => normalizeConfig(raw),
      (error) => error instanceof Error && error.message.startsWith('leo-status config: '),
      `应当拒绝: ${JSON.stringify(raw)}`,
    );
  }
});
