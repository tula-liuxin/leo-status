# leo-status v3 · 行内操作（作废 / 启用 / 删除）

> 只对**本机 Markdown 来源**的 todo 生效（`kind==='markdown'` 且该 todo 属于本机）。
> 远端设备的 todo、DSH 会话抽取的 todo 一律不显示操作按钮（只读）。
> 写回是直接改源笔记的那一行；删除不可撤销（Obsidian 文件恢复 / git 可兜底）。

## 1. 数据表示（作废）

扫描器已经支持：去元数据后的干净文本**整体被 `~~…~~` 包裹** ⇒ `cancelled:true, done:false`。

所以写回规则：

- **作废**：把 todo 行的正文（`[ ]` 之后的 `rest`）用 `~~` 包起来，**保留行首缩进/引用/bullet/checkbox 标记和所有元数据**。
  - 若 `rest` 里有循环标记 `🔁`，只包裹 `🔁` 之前的部分，`🔁…` 原样留在 `~~` 外面。
  - 例：`- [ ] 找数据集 📅 2026-10-30` → `- [ ] ~~找数据集~~ 📅 2026-10-30`
  - 例：`\t- [x] 已做的 📅 2026-10-30` → `\t- [x] ~~已做的~~ 📅 2026-10-30`（保留 `[x]`，启用后回到已完成）
- **启用（撤销作废）**：去掉 `rest` 里第一个 `~~` 和同一个包裹的最后一个 `~~`，其余不动。
- **删除**：整行删除（含换行），不动其它行、不动缩进子行。
- 行尾空白、CRLF/LF、BOM 都要原样保留；文件用「同目录 `.tmp` + rename」原子替换。
- 若该行当前不匹配预期（文件被改过）⇒ 抛 `changed`；找不到行 ⇒ `not-found`；文件不在配置的笔记根目录内 ⇒ `outside-roots`；行不是合法 todo 行 ⇒ `unsupported`。

## 2. `edit.js`（host-scanner 负责）

```js
export class EditError extends Error { /* name='EditError'; code: 'not-found'|'changed'|'outside-roots'|'unsupported' */ }
export function isTodoLine(line)                 // 与 scan.js 的复选框正则一致
export function cancelLine(line)                 // => string；不是 todo 行抛 unsupported
export function restoreLine(line)                // => string
export async function applyTodoAction(opts)      // => Promise<{action,filePath,line,raw}>
// opts = { action: 'cancel'|'restore'|'delete', filePath, line, raw, roots }
// roots = effective scanConfig.markdownRoots（每项 { path }）；校验 filePath 必须落在某个 root 内（path.relative 不含 '..'）
```

- `raw` 是 scan.js 存的原始行（**最多 500 字符**）；校验时用 `lineText === raw || lineText.slice(0,500) === raw.slice(0,500)`。
- `line` 为 1-based；越界 = `changed`。
- 写文件：保留原 EOL（检测文件首个换行是 `\r\n` 还是 `\n`，全文统一用同一种重组）；`fsp.writeFile(tmp)` + `fsp.rename(tmp, filePath)`；rename 在 Windows 上失败（被占用）时抛 `EditError('changed','文件被占用，未修改')`，不要退化成半截写入。
- 测试 `test/edit.test.mjs`：temp fixture 覆盖上面所有规则（含元数据、`🔁`、tab/空格缩进、`>` 引用、`[x]`、CRLF、行尾空格、roundtrip cancel→restore 复原、delete、changed/not-found/outside-roots/unsupported）。

## 3. Host API（lead 负责，index.js）

`POST /leo-status/api/todos/action`（同源 + DSH 鉴权，同现有路由）

```jsonc
// body
{ "action": "cancel" | "restore" | "delete", "id": "local:md:obsidian-main:ideas/...:12" }
// 成功 200
{ "ok": true, "action": "cancel", "todo": { /* 更新后的该 todo（来自新扫描） */ }, "board": { /* getBoard(true) 的最新 Board */ } }
// 失败：400/404/409/500 + { ok:false, error: "..." }
```

- `id` 归一化：去掉 `local:` 前缀；device 模式下若以 `<本机 deviceId>:` 开头也去掉。
- 用**新扫描**的本地快照按 `todo.id` 查找（必须 `kind==='markdown'`），拿到 `file/line/raw` 后调用 `applyTodoAction`。
- 串行化写操作（一个 Promise 队列），避免同一文件并发写。
- 成功后返回 `board = await getBoard(true)`（device 模式下这也会把变更 push 到中心）。
- 错误映射：`changed`→409、`not-found`→404、`outside-roots`/`unsupported`→400、其它→500。

## 4. Client（client-ui 负责，client.js）

- 只在 `todo.kind==='markdown' && isLocalTodo(todo)` 的行上显示操作区（行尾、来源徽标之后）：
  - 未作废：`作废` 按钮（circle-slash 图标）+ `删除`（trash 图标）；
  - 已作废：`启用` 按钮（rotate/undo 图标）+ `删除`。
  - 图标按钮 20×20，次要色，hover 变主题色；`title`/`aria-label` 本地化；不改变行高与现有布局。
- 删除需要**二次确认**：第一次点击进入 armed 状态（图标变 error 色 + title「再点一次确认删除」，3 秒后自动复位），第二次点击才发送。
- 点击动作：`POST /leo-status/api/todos/action`（同源 JSON，body `{action, id}`）；期间该行操作区 disabled；成功用返回的 `board` 走 `applyBoard`（没有 board 时回退 `refresh()`）；失败在工具栏下方显示错误条（自动消失或可关闭），不破坏现有数据。
- 新增 locale：`actionCancel / actionRestore / actionDelete / actionDeleteConfirm / actionFailed / actionPending`（zh/en 两份）。

## 5. 版本与发布

- `package.json` → `0.3.0`；README 增加「行内操作」说明（作废=在笔记里给正文加 `~~`，删除=删掉该行，不可撤销）。
- 发布顺序：leo-status 仓库提交推送 → 市场 `docs/index.json` 追加 0.3.0（保留 0.2.0）→ `parseMarketIndex` 校验 → 推送站点仓库 → 线上验证。
