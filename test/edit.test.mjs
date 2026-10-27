/**
 * leo-status/edit.js 单测（node:test + node:assert/strict）
 *
 * 全部使用 os.tmpdir() 下的临时 fixture；不读取、不修改真实 vault。
 * 运行：node --test leo-status/test/edit.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { EditError, isTodoLine, cancelLine, restoreLine, setDoneLine, applyTodoAction } from '../edit.js';
import { aggregate } from '../scan.js';

/* ------------------------------------------------------------------ */
/* 测试工具                                                            */
/* ------------------------------------------------------------------ */

/** 建临时目录 -> 跑 fn -> 一定清理。 */
async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leo-status-edit-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeFixture(dir, relPath, content) {
  const filePath = path.join(dir, ...relPath.split('/'));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
  return filePath;
}

function rootsOf(dir) {
  return [{ id: 'test', label: '测试库', path: dir }];
}

function scanConfig(dir) {
  return { markdownRoots: rootsOf(dir), includeDshTodos: false, cacheTtlMs: 0 };
}

async function assertEditError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof EditError, `期望 EditError，实际: ${error && error.constructor && error.constructor.name}`);
    assert.equal(error.name, 'EditError');
    assert.equal(error.code, code);
    return true;
  });
}

async function assertNoTmp(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const tmp = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.tmp'));
  assert.deepEqual(tmp.map((entry) => entry.name), []);
}

/* ------------------------------------------------------------------ */
/* isTodoLine                                                          */
/* ------------------------------------------------------------------ */

test('isTodoLine：与 scan.js 复选框正则一致的各种变体', () => {
  const valid = [
    '- [ ] 任务',
    '* [x] 任务',
    '+ [X] 任务',
    '1. [ ] 任务',
    '12) [ ] 任务',
    '> - [ ] 引用任务',
    '  - [ ] 缩进任务',
    '\t- [ ] tab 缩进',
    '- [-] 作废任务',
    '- [/] 作废任务',
    '- [ ] ',
    '- [ ]',
    '- [ ]\t任务',
  ];
  for (const line of valid) assert.equal(isTodoLine(line), true, `应识别: ${JSON.stringify(line)}`);

  const invalid = ['普通文本', '# 标题', '- [  ] 任务', '- [] 任务', '- [z] 任务', '', '   '];
  // 注意：'- [ ]x' 其实匹配（`]` 后的 `\s?` 可选），单独断言
  assert.equal(isTodoLine('- [ ]x'), true);
  for (const line of invalid) assert.equal(isTodoLine(line), false, `不应识别: ${JSON.stringify(line)}`);
  assert.equal(isTodoLine(null), false);
  assert.equal(isTodoLine(42), false);
});

/* ------------------------------------------------------------------ */
/* cancelLine                                                          */
/* ------------------------------------------------------------------ */

test('cancelLine：正文包 ~~，元数据/缩进/引用/bullet/checkbox/行尾空白保留', () => {
  // 契约 §1 的两个例子，逐字节一致
  assert.equal(cancelLine('- [ ] 找数据集 📅 2026-10-30'), '- [ ] ~~找数据集~~ 📅 2026-10-30');
  assert.equal(cancelLine('\t- [x] 已做的 📅 2026-10-30'), '\t- [x] ~~已做的~~ 📅 2026-10-30');

  assert.equal(cancelLine('- [ ] 普通任务'), '- [ ] ~~普通任务~~');
  assert.equal(cancelLine('* [ ] 星号任务'), '* [ ] ~~星号任务~~');
  assert.equal(cancelLine('+ [x] 加号任务'), '+ [x] ~~加号任务~~');
  assert.equal(cancelLine('1. [ ] 有序任务'), '1. [ ] ~~有序任务~~');
  assert.equal(cancelLine('12) [ ] 有序任务'), '12) [ ] ~~有序任务~~');
  assert.equal(cancelLine('> - [ ] 引用任务'), '> - [ ] ~~引用任务~~');
  assert.equal(cancelLine('  > - [ ] 引用缩进'), '  > - [ ] ~~引用缩进~~');
  assert.equal(cancelLine('  - [ ] 缩进任务'), '  - [ ] ~~缩进任务~~');

  // 元数据在尾部、开头都在 ~~ 外面
  assert.equal(cancelLine('- [ ] 任务 #tag 🔺 [[链接]] @due(2026-11-01)'), '- [ ] ~~任务~~ #tag 🔺 [[链接]] @due(2026-11-01)');
  assert.equal(cancelLine('- [ ] 任务 ✅ 2026-10-01'), '- [ ] ~~任务~~ ✅ 2026-10-01');
  assert.equal(cancelLine('- [ ] 📅 2026-10-30 找数据集'), '- [ ] 📅 2026-10-30 ~~找数据集~~');

  // 行尾空白原样保留
  assert.equal(cancelLine('- [ ] 任务   '), '- [ ] ~~任务~~   ');
  assert.equal(cancelLine('- [ ] 任务 📅 2026-10-30   '), '- [ ] ~~任务~~ 📅 2026-10-30   ');
});

test('cancelLine：🔁 只包裹它之前的部分，后面原样保留', () => {
  assert.equal(cancelLine('- [ ] 每天写 🔁 every day'), '- [ ] ~~每天写~~ 🔁 every day');
  assert.equal(cancelLine('\t- [ ] 每周复盘 🔁 every week'), '\t- [ ] ~~每周复盘~~ 🔁 every week');
  assert.equal(
    cancelLine('- [ ] 每天写 📅 2026-10-30 🔁 every day'),
    '- [ ] ~~每天写~~ 📅 2026-10-30 🔁 every day',
  );
  // 空格数量原样
  assert.equal(cancelLine('- [ ] 每天写   🔁 every day'), '- [ ] ~~每天写~~   🔁 every day');
});

test('cancelLine：已作废幂等；非 todo / 无正文抛 unsupported', () => {
  const already = '- [ ] ~~旧任务~~ 📅 2026-10-30';
  assert.equal(cancelLine(already), already);
  assert.equal(cancelLine('\t- [x] ~~已做的~~'), '\t- [x] ~~已做的~~');

  assert.throws(() => cancelLine('普通文本'), (error) => error instanceof EditError && error.code === 'unsupported');
  assert.throws(() => cancelLine('- [ ]'), (error) => error instanceof EditError && error.code === 'unsupported');
  assert.throws(() => cancelLine('- [ ]   '), (error) => error instanceof EditError && error.code === 'unsupported');
  assert.throws(() => cancelLine('- [ ] 📅 2026-10-30'), (error) => error instanceof EditError && error.code === 'unsupported');
  assert.throws(() => cancelLine(null), (error) => error instanceof EditError && error.code === 'unsupported');
});

/* ------------------------------------------------------------------ */
/* restoreLine                                                         */
/* ------------------------------------------------------------------ */

test('restoreLine：去掉包裹的首尾 ~~，其余不动', () => {
  assert.equal(restoreLine('- [ ] ~~任务~~'), '- [ ] 任务');
  assert.equal(restoreLine('- [ ] ~~任务~~ 📅 2026-10-30'), '- [ ] 任务 📅 2026-10-30');
  assert.equal(restoreLine('- [ ] ~~每天写~~ 🔁 every day'), '- [ ] 每天写 🔁 every day');
  assert.equal(restoreLine('\t- [x] ~~已做的~~ 📅 2026-10-30'), '\t- [x] 已做的 📅 2026-10-30');
  assert.equal(restoreLine('> - [ ] ~~引用任务~~'), '> - [ ] 引用任务');
  assert.equal(restoreLine('- [ ] ~~任务~~   '), '- [ ] 任务   ');
});

test('restoreLine：没有成对 ~~ 时原样返回；非 todo 抛 unsupported', () => {
  assert.equal(restoreLine('- [ ] 任务'), '- [ ] 任务');
  assert.equal(restoreLine('- [ ] 任务 ~~'), '- [ ] 任务 ~~');
  assert.equal(restoreLine('- [ ] ~~半个'), '- [ ] ~~半个');
  assert.throws(() => restoreLine('普通文本'), (error) => error instanceof EditError && error.code === 'unsupported');
  assert.throws(() => restoreLine(undefined), (error) => error instanceof EditError && error.code === 'unsupported');
});

test('cancelLine -> restoreLine roundtrip 逐字节复原', () => {
  const lines = [
    '- [ ] 找数据集 📅 2026-10-30',
    '\t- [x] 已做的 📅 2026-10-30',
    '> - [ ] 引用任务',
    '  - [ ] 缩进任务 #tag 🔺 [[链接笔记]]',
    '- [ ] 每天写 🔁 every day',
    '- [ ] 每天写 📅 2026-10-30 🔁 every day',
    '- [ ] 任务   ',
    '- [ ] 部分 ~~删除线~~ 不算作废',
    '* [X] 星号任务 ✅ 2026-10-01',
    '1. [ ] 有序任务 @due(2026-11-01)',
  ];
  for (const line of lines) {
    assert.equal(restoreLine(cancelLine(line)), line, `roundtrip 失败: ${JSON.stringify(line)}`);
  }
});

/* ------------------------------------------------------------------ */
/* applyTodoAction：写文件                                             */
/* ------------------------------------------------------------------ */

test('applyTodoAction cancel：只改目标行、返回形如契约、scan.js 能识别 cancelled', async () => {
  await withTempDir(async (dir) => {
    const original = [
      '# 计划',
      '',
      '- [ ] 任务一 📅 2026-10-30',
      '- [x] 已做任务',
      '- [ ] 每天写 🔁 every day',
      '',
    ].join('\n');
    const filePath = await writeFixture(dir, 'note.md', original);
    const roots = rootsOf(dir);

    const result = await applyTodoAction({
      action: 'cancel',
      filePath,
      line: 3,
      raw: '- [ ] 任务一 📅 2026-10-30',
      roots,
    });
    assert.deepEqual(result, {
      action: 'cancel',
      filePath,
      line: 3,
      raw: '- [ ] ~~任务一~~ 📅 2026-10-30',
    });

    const expected = [
      '# 计划',
      '',
      '- [ ] ~~任务一~~ 📅 2026-10-30',
      '- [x] 已做任务',
      '- [ ] 每天写 🔁 every day',
      '',
    ].join('\n');
    assert.equal(await fs.readFile(filePath, 'utf8'), expected);
    await assertNoTmp(dir);

    // scan.js 视角：cancelled=true、text 干净、元数据仍在
    const snapshot = await aggregate(scanConfig(dir), { force: true });
    const cancelled = snapshot.todos.find((todo) => todo.line === 3);
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.done, false);
    assert.equal(cancelled.text, '任务一');
    assert.equal(cancelled.due, '2026-10-30');

    // [x] 行作废：cancelled 优先，done=false；其余行不受影响
    await applyTodoAction({ action: 'cancel', filePath, line: 4, raw: '- [x] 已做任务', roots });
    const afterX = await aggregate(scanConfig(dir), { force: true });
    const doneLine = afterX.todos.find((todo) => todo.line === 4);
    assert.equal(doneLine.cancelled, true);
    assert.equal(doneLine.done, false);

    // 🔁 行作废：recurrence 保留、cancelled 生效
    await applyTodoAction({ action: 'cancel', filePath, line: 5, raw: '- [ ] 每天写 🔁 every day', roots });
    const afterLoop = await aggregate(scanConfig(dir), { force: true });
    const loopLine = afterLoop.todos.find((todo) => todo.line === 5);
    assert.equal(loopLine.cancelled, true);
    assert.equal(loopLine.text, '每天写');
    assert.equal(loopLine.recurrence, 'every day');

    // 第一次 cancel 的那行再 cancel 是幂等的（文件不变）
    const before = await fs.readFile(filePath, 'utf8');
    const again = await applyTodoAction({
      action: 'cancel',
      filePath,
      line: 3,
      raw: '- [ ] ~~任务一~~ 📅 2026-10-30',
      roots,
    });
    assert.equal(again.raw, '- [ ] ~~任务一~~ 📅 2026-10-30');
    assert.equal(await fs.readFile(filePath, 'utf8'), before);
  });
});

test('applyTodoAction cancel -> restore：文件逐字节复原，scan 回到未作废', async () => {
  await withTempDir(async (dir) => {
    const original = [
      '# 标题',
      '',
      '\t- [x] 已做的 📅 2026-10-30',
      '> - [ ] 引用任务   ',
      '- [ ] 每天写 🔁 every day',
    ].join('\n');
    const filePath = await writeFixture(dir, 'round.md', original);
    const roots = rootsOf(dir);

    await applyTodoAction({ action: 'cancel', filePath, line: 3, raw: '\t- [x] 已做的 📅 2026-10-30', roots });
    await applyTodoAction({ action: 'cancel', filePath, line: 4, raw: '> - [ ] 引用任务   ', roots });
    await applyTodoAction({ action: 'cancel', filePath, line: 5, raw: '- [ ] 每天写 🔁 every day', roots });

    const cancelledSnapshot = await aggregate(scanConfig(dir), { force: true });
    assert.equal(cancelledSnapshot.todos.length, 3);
    assert.ok(cancelledSnapshot.todos.every((todo) => todo.cancelled === true));

    const current = await fs.readFile(filePath, 'utf8');
    assert.equal(await applyTodoAction({ action: 'restore', filePath, line: 3, raw: current.split('\n')[2], roots }).then((r) => r.raw), '\t- [x] 已做的 📅 2026-10-30');

    const nowFile = await fs.readFile(filePath, 'utf8');
    await applyTodoAction({ action: 'restore', filePath, line: 4, raw: nowFile.split('\n')[3], roots });
    const nowFile2 = await fs.readFile(filePath, 'utf8');
    await applyTodoAction({ action: 'restore', filePath, line: 5, raw: nowFile2.split('\n')[4], roots });

    assert.equal(await fs.readFile(filePath, 'utf8'), original);
    await assertNoTmp(dir);

    const restoredSnapshot = await aggregate(scanConfig(dir), { force: true });
    assert.ok(restoredSnapshot.todos.every((todo) => todo.cancelled === false));
    const doneLine = restoredSnapshot.todos.find((todo) => todo.line === 3);
    assert.equal(doneLine.done, true);
  });
});

test('applyTodoAction delete：整行删除（中间/首行/末行/唯一行/CRLF）', async () => {
  await withTempDir(async (dir) => {
    const roots = rootsOf(dir);

    // 中间行
    let filePath = await writeFixture(dir, 'mid.md', 'a\n- [ ] 删我\nb\n');
    await applyTodoAction({ action: 'delete', filePath, line: 2, raw: '- [ ] 删我', roots });
    assert.equal(await fs.readFile(filePath, 'utf8'), 'a\nb\n');

    // 首行
    filePath = await writeFixture(dir, 'first.md', '- [ ] 删我\nb\n');
    await applyTodoAction({ action: 'delete', filePath, line: 1, raw: '- [ ] 删我', roots });
    assert.equal(await fs.readFile(filePath, 'utf8'), 'b\n');

    // 末行（无行尾换行）：连同它前面的换行一起删掉，文件不以空行收尾
    filePath = await writeFixture(dir, 'last.md', 'a\n- [ ] 删我');
    await applyTodoAction({ action: 'delete', filePath, line: 2, raw: '- [ ] 删我', roots });
    assert.equal(await fs.readFile(filePath, 'utf8'), 'a');

    // 唯一行（无换行 / 有换行）
    filePath = await writeFixture(dir, 'only.md', '- [ ] 删我');
    await applyTodoAction({ action: 'delete', filePath, line: 1, raw: '- [ ] 删我', roots });
    assert.equal(await fs.readFile(filePath, 'utf8'), '');

    filePath = await writeFixture(dir, 'only-nl.md', '- [ ] 删我\n');
    const result = await applyTodoAction({ action: 'delete', filePath, line: 1, raw: '- [ ] 删我', roots });
    assert.equal(await fs.readFile(filePath, 'utf8'), '');
    assert.equal(result.raw, null);

    // CRLF
    filePath = await writeFixture(dir, 'crlf-del.md', 'a\r\n- [ ] 删我\r\nb\r\n');
    await applyTodoAction({ action: 'delete', filePath, line: 2, raw: '- [ ] 删我', roots });
    assert.equal(await fs.readFile(filePath, 'utf8'), 'a\r\nb\r\n');

    await assertNoTmp(dir);
  });
});

test('applyTodoAction：CRLF + BOM + 行尾空白原样保留', async () => {
  await withTempDir(async (dir) => {
    const original = '\uFEFF# 标题\r\n\r\n- [ ] 任务 📅 2026-10-30   \r\n- [ ] 第二\r\n';
    const filePath = await writeFixture(dir, 'crlf.md', original);
    const roots = rootsOf(dir);

    assert.equal(await fs.readFile(filePath, 'utf8'), original); // 写入读回一致（BOM 保留）

    const result = await applyTodoAction({
      action: 'cancel',
      filePath,
      line: 3,
      raw: '- [ ] 任务 📅 2026-10-30   ',
      roots,
    });
    assert.equal(result.raw, '- [ ] ~~任务~~ 📅 2026-10-30   ');

    const expected = '\uFEFF# 标题\r\n\r\n- [ ] ~~任务~~ 📅 2026-10-30   \r\n- [ ] 第二\r\n';
    const afterCancel = await fs.readFile(filePath, 'utf8');
    assert.equal(afterCancel, expected);
    // BOM 只有一个；换行全部是 CRLF，没有孤立 LF / CR
    assert.ok(afterCancel.startsWith('\uFEFF'));
    assert.equal(afterCancel.split('\uFEFF').length, 2);
    assert.equal(afterCancel.replace(/\r\n/g, '').includes('\n'), false);
    assert.equal(afterCancel.replace(/\r\n/g, '').includes('\r'), false);

    await applyTodoAction({ action: 'restore', filePath, line: 3, raw: result.raw, roots });
    assert.equal(await fs.readFile(filePath, 'utf8'), original);
    await assertNoTmp(dir);
  });
});

test('applyTodoAction：raw 最多 500 字符的兼容比较（长行）', async () => {
  await withTempDir(async (dir) => {
    const longText = 'x'.repeat(600);
    const original = `- [ ] ${longText}\n`;
    const filePath = await writeFixture(dir, 'long.md', original);
    const roots = rootsOf(dir);
    const truncatedRaw = `- [ ] ${longText}`.slice(0, 500);

    const result = await applyTodoAction({ action: 'cancel', filePath, line: 1, raw: truncatedRaw, roots });
    const expected = `- [ ] ~~${longText}~~\n`;
    assert.equal(await fs.readFile(filePath, 'utf8'), expected);
    assert.equal(result.raw, `- [ ] ~~${longText}~~`);

    // scan 侧 raw 仍是 500 字符截断
    const snapshot = await aggregate(scanConfig(dir), { force: true });
    assert.equal(snapshot.todos[0].raw.length, 500);
    assert.equal(snapshot.todos[0].cancelled, true);
  });
});

/* ------------------------------------------------------------------ */
/* applyTodoAction：错误分支                                           */
/* ------------------------------------------------------------------ */

test('applyTodoAction changed：raw 不匹配 / 行号越界 / 行号非法，且文件不变', async () => {
  await withTempDir(async (dir) => {
    const filePath = await writeFixture(dir, 'note.md', '第一行\n- [ ] 原任务\n');
    const roots = rootsOf(dir);
    const before = await fs.readFile(filePath, 'utf8');

    await assertEditError(
      applyTodoAction({ action: 'cancel', filePath, line: 2, raw: '- [ ] 别的任务', roots }),
      'changed',
    );
    await assertEditError(
      applyTodoAction({ action: 'delete', filePath, line: 99, raw: '- [ ] 原任务', roots }),
      'changed',
    );
    await assertEditError(
      applyTodoAction({ action: 'cancel', filePath, line: 0, raw: '- [ ] 原任务', roots }),
      'changed',
    );
    await assertEditError(
      applyTodoAction({ action: 'cancel', filePath, line: 1.5, raw: '- [ ] 原任务', roots }),
      'changed',
    );

    assert.equal(await fs.readFile(filePath, 'utf8'), before);
    await assertNoTmp(dir);
  });
});

test('applyTodoAction not-found：文件不存在', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'missing.md');
    await assertEditError(
      applyTodoAction({ action: 'cancel', filePath, line: 1, raw: '- [ ] 任务', roots: rootsOf(dir) }),
      'not-found',
    );
    await assertNoTmp(dir);
  });
});

test('applyTodoAction outside-roots：根外文件 / .. 穿越 / roots 为空或缺失', async () => {
  await withTempDir(async (dir) => {
    const insideDir = path.join(dir, 'inside');
    const outsideDir = path.join(dir, 'outside');
    await fs.mkdir(insideDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    const insideFile = await writeFixture(insideDir, 'a.md', '- [ ] 任务\n');
    const outsideFile = await writeFixture(outsideDir, 'b.md', '- [ ] 任务\n');

    // 同目录另有 root 时才允许；这里 roots 只含 inside
    await assertEditError(
      applyTodoAction({ action: 'cancel', filePath: outsideFile, line: 1, raw: '- [ ] 任务', roots: [{ path: insideDir }] }),
      'outside-roots',
    );
    // `..` 穿越（路径字面量以 root 开头也不行）
    const traversal = path.join(insideDir, '..', 'outside', 'b.md');
    await assertEditError(
      applyTodoAction({ action: 'cancel', filePath: traversal, line: 1, raw: '- [ ] 任务', roots: [{ path: insideDir }] }),
      'outside-roots',
    );
    await assertEditError(
      applyTodoAction({ action: 'cancel', filePath: outsideFile, line: 1, raw: '- [ ] 任务', roots: [] }),
      'outside-roots',
    );
    await assertEditError(
      applyTodoAction({ action: 'cancel', filePath: outsideFile, line: 1, raw: '- [ ] 任务' }),
      'outside-roots',
    );

    // 根内文件正常
    const ok = await applyTodoAction({
      action: 'cancel',
      filePath: insideFile,
      line: 1,
      raw: '- [ ] 任务',
      roots: [{ path: insideDir }],
    });
    assert.equal(ok.raw, '- [ ] ~~任务~~');
  });
});

test('applyTodoAction unsupported：非 todo 行 / 非法 action', async () => {
  await withTempDir(async (dir) => {
    const filePath = await writeFixture(dir, 'note.md', '普通文本\n');
    const roots = rootsOf(dir);

    await assertEditError(
      applyTodoAction({ action: 'cancel', filePath, line: 1, raw: '普通文本', roots }),
      'unsupported',
    );
    await assertEditError(
      applyTodoAction({ action: 'archive', filePath, line: 1, raw: '普通文本', roots }),
      'unsupported',
    );
    await assertEditError(
      applyTodoAction({ action: 'cancel', filePath, line: 1, raw: '普通文本' }),
      'outside-roots',
    );
  });
});

/* ------------------------------------------------------------------ */
/* v3.1：勾选 / 取消勾选（setDoneLine + done/undone）                   */
/* ------------------------------------------------------------------ */

test('setDoneLine：正反向切换，其余（缩进/引用/bullet/元数据/行尾空白）逐字节保留', () => {
  assert.equal(setDoneLine('- [ ] 写测试 📅 2026-11-01', true), '- [x] 写测试 📅 2026-11-01');
  assert.equal(setDoneLine('- [x] 写测试 📅 2026-11-01', false), '- [ ] 写测试 📅 2026-11-01');

  assert.equal(setDoneLine('\t- [ ] 已做的 📅 2026-10-30   ', true), '\t- [x] 已做的 📅 2026-10-30   ');
  assert.equal(setDoneLine('> - [x] 引用任务', false), '> - [ ] 引用任务');
  assert.equal(setDoneLine('  > - [ ] 引用缩进', true), '  > - [x] 引用缩进');
  assert.equal(setDoneLine('* [ ] 星号任务', true), '* [x] 星号任务');
  assert.equal(setDoneLine('+ [x] 加号任务', false), '+ [ ] 加号任务');
  assert.equal(setDoneLine('12) [ ] 有序任务 #tag 🔺 [[链接]] @due(2026-11-01)', true), '12) [x] 有序任务 #tag 🔺 [[链接]] @due(2026-11-01)');
  assert.equal(setDoneLine('- [ ] 每天写 🔁 every day', true), '- [x] 每天写 🔁 every day');
  assert.equal(setDoneLine('- [x] 带尾空格   ', false), '- [ ] 带尾空格   ');
});

test('setDoneLine：已是目标状态幂等；大写 [X] 不强行改写', () => {
  assert.equal(setDoneLine('- [x] 任务', true), '- [x] 任务');
  assert.equal(setDoneLine('- [X] 任务', true), '- [X] 任务');
  assert.equal(setDoneLine('- [ ] 任务', false), '- [ ] 任务');
  // 目标为 false 时 [X] 也要变成 [ ]
  assert.equal(setDoneLine('- [X] 任务', false), '- [ ] 任务');
  assert.equal(setDoneLine('\t- [x] 任务 📅 2026-11-01', true), '\t- [x] 任务 📅 2026-11-01');
});

test('setDoneLine：非 todo 行与作废行抛 unsupported', () => {
  const unsupported = [
    '普通文本',
    '# 标题',
    '- [  ] 任务',
    '- [] 任务',
    '- [z] 任务',
    '',
    '- [-] 任务',
    '- [/] 任务',
    '- [ ] ~~作废任务~~',
    '\t- [x] ~~已做的~~ 📅 2026-10-30',
    '> - [ ] ~~引用里的作废~~',
    '- [ ] ~~每天写~~ 🔁 every day',
  ];
  for (const line of unsupported) {
    assert.throws(
      () => setDoneLine(line, true),
      (error) => error instanceof EditError && error.code === 'unsupported',
      `应抛 unsupported: ${JSON.stringify(line)}`,
    );
  }
  assert.throws(() => setDoneLine(null, true), (error) => error instanceof EditError && error.code === 'unsupported');
});

test('applyTodoAction done / undone：写回文件、scan.js 状态变化、幂等、无 tmp 残留', async () => {
  await withTempDir(async (dir) => {
    const original = [
      '# 待办',
      '',
      '- [ ] 写测试 📅 2026-11-01',
      '- [x] 已完成的',
      '- [ ] 每天写 🔁 every day',
      '',
    ].join('\n');
    const filePath = await writeFixture(dir, 'done.md', original);
    const roots = rootsOf(dir);

    // done：[ ] -> [x]
    const doneResult = await applyTodoAction({
      action: 'done',
      filePath,
      line: 3,
      raw: '- [ ] 写测试 📅 2026-11-01',
      roots,
    });
    assert.deepEqual(doneResult, {
      action: 'done',
      filePath,
      line: 3,
      raw: '- [x] 写测试 📅 2026-11-01',
    });
    const afterDone = [
      '# 待办',
      '',
      '- [x] 写测试 📅 2026-11-01',
      '- [x] 已完成的',
      '- [ ] 每天写 🔁 every day',
      '',
    ].join('\n');
    assert.equal(await fs.readFile(filePath, 'utf8'), afterDone);
    await assertNoTmp(dir);

    const doneSnapshot = await aggregate(scanConfig(dir), { force: true });
    const doneTodo = doneSnapshot.todos.find((todo) => todo.line === 3);
    assert.equal(doneTodo.done, true);
    assert.equal(doneTodo.cancelled, false);
    assert.equal(doneTodo.text, '写测试');
    assert.equal(doneTodo.due, '2026-11-01');

    // undone：[x] -> [ ]，文件逐字节复原
    await applyTodoAction({
      action: 'undone',
      filePath,
      line: 3,
      raw: '- [x] 写测试 📅 2026-11-01',
      roots,
    });
    assert.equal(await fs.readFile(filePath, 'utf8'), original);
    await assertNoTmp(dir);

    const undoneSnapshot = await aggregate(scanConfig(dir), { force: true });
    assert.equal(undoneSnapshot.todos.find((todo) => todo.line === 3).done, false);

    // done 幂等：已完成行再 done，文件不变
    const before = await fs.readFile(filePath, 'utf8');
    const idempotent = await applyTodoAction({ action: 'done', filePath, line: 4, raw: '- [x] 已完成的', roots });
    assert.equal(idempotent.raw, '- [x] 已完成的');
    assert.equal(await fs.readFile(filePath, 'utf8'), before);

    // 作废行不能勾选：先 cancel 再 done => unsupported，文件不变
    await applyTodoAction({ action: 'cancel', filePath, line: 5, raw: '- [ ] 每天写 🔁 every day', roots });
    const cancelledLine = (await fs.readFile(filePath, 'utf8')).split('\n')[4];
    assert.equal(cancelledLine, '- [ ] ~~每天写~~ 🔁 every day');
    const afterCancel = await fs.readFile(filePath, 'utf8');
    await assertEditError(
      applyTodoAction({ action: 'done', filePath, line: 5, raw: cancelledLine, roots }),
      'unsupported',
    );
    await assertEditError(
      applyTodoAction({ action: 'undone', filePath, line: 5, raw: cancelledLine, roots }),
      'unsupported',
    );
    assert.equal(await fs.readFile(filePath, 'utf8'), afterCancel);
    await assertNoTmp(dir);
  });
});

test('applyTodoAction done：CRLF + BOM + 行尾空白原样保留', async () => {
  await withTempDir(async (dir) => {
    const original = '\uFEFF# 标题\r\n\r\n- [ ] 写测试 📅 2026-11-01   \r\n';
    const filePath = await writeFixture(dir, 'crlf-done.md', original);
    const roots = rootsOf(dir);

    const result = await applyTodoAction({
      action: 'done',
      filePath,
      line: 3,
      raw: '- [ ] 写测试 📅 2026-11-01   ',
      roots,
    });
    assert.equal(result.raw, '- [x] 写测试 📅 2026-11-01   ');

    const expected = '\uFEFF# 标题\r\n\r\n- [x] 写测试 📅 2026-11-01   \r\n';
    const afterDone = await fs.readFile(filePath, 'utf8');
    assert.equal(afterDone, expected);
    assert.ok(afterDone.startsWith('\uFEFF')); // 仍只有一个 BOM
    assert.equal(afterDone.split('\uFEFF').length, 2);
    assert.equal(afterDone.replace(/\r\n/g, '').includes('\n'), false);
    assert.equal(afterDone.replace(/\r\n/g, '').includes('\r'), false);

    await applyTodoAction({
      action: 'undone',
      filePath,
      line: 3,
      raw: '- [x] 写测试 📅 2026-11-01   ',
      roots,
    });
    assert.equal(await fs.readFile(filePath, 'utf8'), original);
    await assertNoTmp(dir);
  });
});
