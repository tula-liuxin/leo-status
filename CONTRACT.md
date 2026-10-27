# leo-status 插件 · 实现契约 v1

> 首期目标：把 leo 所有来源的 TODO 聚合起来，在 DSH Web UI 里用一个侧栏入口 + 整页看板展示。
> 只读，不做写入/勾选回写（v2 再做）。
> 所有文件都在本目录 `leo-status/`。纯 JS（ESM），无构建、无依赖、Node 24。

## 1. 文件所有权（禁止越界写）

| 文件 | 所有者 | 说明 |
|---|---|---|
| `scan.js` | **host-scanner** | 纯数据层：扫 Markdown、读 DSH session todos、聚合、统计 |
| `test/scan.test.mjs` | **host-scanner** | Node 内置 `node:test` 单测 |
| `client.js` | **client-ui** | 浏览器半边：侧栏图标 + 整页看板 |
| `index.js` | **lead** | Host 半边：HTTP API、缓存、调用 scan.js |
| `package.json` / `cordis.patch.yml` / `locale/*` / `icon.svg` | **lead** | 打包与展示元数据 |

其他人不要改别人的文件；发现契约问题先 `send_message` 给 lead。

## 2. 数据契约（scan.js 与 client.js 共同遵守）

`scan.js` 导出（ESM）：

```js
export const DEFAULTS                          // 完整默认配置对象（见 §4）
export const EMPTY_STATS                       // { total:0, open:0, done:0, overdue:0, dueToday:0, dueSoon:0, undated:0 }（冻结）
export function normalizeConfig(raw)           // (raw|undefined) => 校验后的 config，非法值抛 Error
export async function aggregate(config, opts)  // => Snapshot；opts = { now?: Date, force?: boolean }
```

`aggregate` 返回的 Snapshot（就是 HTTP API 的 JSON body，客户端直接吃）：

```jsonc
{
  "ok": true,
  "version": 1,
  "generatedAt": "2026-10-27T07:30:00.000Z",   // ISO
  "tookMs": 123,
  "sources": [
    {
      "id": "obsidian-main",
      "kind": "markdown",                       // "markdown" | "dsh"
      "label": "Obsidian 主库",
      "path": "C:\\Users\\me\\Desktop\\my_obsidian",
      "files": 240,                             // 实际扫描的 .md 文件数
      "count": 87,                              // 该来源解析出的 todo 数
      "open": 60,
      "done": 27,
      "error": null                             // 失败时 string；此时 files/count 可为 0
    },
    {
      "id": "dsh-sessions", "kind": "dsh", "label": "DSH 会话 (AI 抽取)",
      "path": "C:\\Users\\me\\.dsh\\storages\\session_projcache\\sessions",
      "files": 77, "count": 5, "open": 5, "done": 0, "error": null
    }
  ],
  "todos": [ /* 见下 */ ],
  "stats": { "total": 92, "open": 65, "done": 27, "cancelled": 3, "overdue": 3, "dueToday": 2, "dueSoon": 4, "undated": 50 },
  "config": { "includeDshTodos": true, "markdownRootCount": 1 }   // 客户端展示用，不放敏感细节
}
```

单条 todo（**字段全部存在**，缺省为 null / []）：

```jsonc
{
  "id": "md:obsidian-main:ideas/日记/2026/10月/10.26.md:12",  // 稳定、去重
  "kind": "markdown",                     // "markdown" | "dsh"
  "text": "写 leo-status 插件骨架",        // 去掉元数据 emoji 后的干净文本
  "raw": "- [ ] 写 leo-status 插件骨架 📅 2026-10-30",   // 原始行（可截断 500 字符）
  "done": false,
  "cancelled": false,                       // 作废（~~…~~ 或 [-]/[/] 标记）：既有但已放弃
  "sourceId": "obsidian-main",
  "sourceLabel": "Obsidian 主库",
  "file": "C:\\Users\\me\\Desktop\\my_obsidian\\ideas\\...\\10.26.md",  // markdown 用绝对路径；dsh 为 null
  "relPath": "ideas/日记/2026/10月/10.26.md",   // markdown 相对 root（/ 分隔）；dsh 为 null
  "line": 12,                              // 1-based；dsh 为 null
  "heading": "H1 标题 > H2 标题",            // 最近的标题链，空格 > 空格；没有则 null
  "indent": 0,                             // 0/1/2...（制表符算 1 层）
  "noteDate": "2026-10-26",                // 从文件名/所在目录推断的笔记日期；推断不出 null
  "due": "2026-10-30",                     // YYYY-MM-DD 或 null
  "scheduled": null,
  "start": null,
  "priority": "high",                      // "highest"|"high"|"medium"|"low"|"lowest"|null
  "tags": ["todo", "论文"],                 // 不含 # 前缀
  "links": ["10.15 核心idea"],              // [[wikilink]] 的内部文本
  "recurrence": null,
  "sessionId": null,                       // dsh 专用
  "sessionTitle": null,                    // dsh 专用
  "project": null                          // dsh 专用：会话 cwd
}
```

排序：`aggregate` 返回的 `todos` 不要求排序；客户端自己分组排序。

## 3. 解析规则（markdown）

按行扫描，**跳过 fenced code block**（``` / ~~~ 围栏内一律不解析）与 YAML frontmatter（文件首 `---` 到下一个 `---`）。

复选框正则（允许缩进、引用、`-`/`*`/`+`/有序列表、`[ ]`/`[x]`/`[X]`/`[-]`/`[/]`）：

```
/^(?<indent>[ \t]*)(?:>\s*)?(?:[-*+]|\d+[.)])\s+\[(?<mark>[ xX\-\/])\]\s?(?<rest>.*)$/
```

- `done = mark !== ' '`；`[x]`/`[X]` 都算完成；`[-]`/`[/]` 算**作废**（`done:false, cancelled:true`）。
- **作废**：任务文本整体被 `~~…~~` 包裹（去掉元数据后判断）→ `cancelled:true, done:false`，`text` 去掉 `~~`；否则 `cancelled:false`。
- **空任务**（`- [ ]`、`- [ ]   `，去元数据后 `text === ''`）直接丢弃，不产出 todo。
- `text`：`rest` 去掉下方所有元数据标记后 `trim()`；若为空则回退原始 `rest`。元数据可任意顺序出现。
- 元数据（全部可缺省，可任意顺序）：
  - 截止 `📅 2026-10-30`（也支持无空格 `📅2026-10-30`）→ `due`
  - 计划 `⏳ ...` → `scheduled`；开始 `🛫 ...` → `start`；完成日期 `✅ ...` 忽略
  - `@due(2026-10-30)`、`due:: 2026-10-30`、`[due:: 2026-10-30]` → `due`
  - 优先级：`🔺`/`⏫` → highest，`🔼` → high，`🔽` → low，`⏬` → lowest；`#p1`→highest、`#p2`→high、`#p3`→medium、`#p4`→low 也算（同时进 tags）
  - 循环 `🔁 ...` → `recurrence`（保留 emoji 后的整段文本）
  - tags：`/#[\p{L}\p{N}_\-/]+/gu`，去掉 `#`，过滤纯数字（`#123` 不算）
  - links：`/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g` 取内部文本（去掉 `|alias`、`#heading`）
- `heading`：维护标题栈（`^#{1,6}\s+(.*)$`），输出当前所有标题以 ` > ` 连接；标题文本去掉尾部 `#`。
- `noteDate` 推断：
  1. 文件名匹配 `^(\d{4})-(\d{2})-(\d{2})` → 该日期；
  2. 文件名匹配 `^(\d{1,2})\.(\d{1,2})(?:\D|$)`：月/日，年份取路径中最近的 `20\d\d` 目录，取不到再用当前年；
  3. 否则 null。
- `raw` 原行截断到 500 字符。`id = "md:" + sourceId + ":" + relPath + ":" + line`。
- 只读文本文件：单个文件 > `maxFileBytes` 跳过；总数超过 `maxFiles` 就停止并记 `error: "文件数超过上限"`（保留已解析结果）。
- 目录跳过：`excludeDirs`（默认 `.obsidian`, `.git`, `.trash`, `node_modules`, `obsd_attch`, `obs_attch`, `attachments`）。
- 文件名后缀跳过：`excludeSuffixes`（默认 `.excalidraw.md`，因为压缩绘图数据里有大量 `[ ]` 噪声）。

### DSH 会话 todo（kind = "dsh"）

目录：`<DSH_HOME>/storages/session_projcache/sessions/*.json`，每个文件形如：

```jsonc
{ "record": { "rows": {
  "title": { "ver": 1, "seq": 490, "val": "会话标题" },
  "workingDirectory": { "ver": 1, "seq": 490, "val": "C:\\some\\cwd" },
  "todos": { "ver": 2, "seq": 490, "val": [ { "content": "任务文本", "status": "pending" } ] }
} } }
```

规则：
- 取 `record.rows.todos.val` 数组；`status` 为 `pending` / `in_progress` / `completed` / `cancelled`（容忍其他值）。
- 只输出 `pending` 与 `in_progress`（除非 config 打开 `includeDshCompleted`）；`done = status === 'completed'`。
- `text = content.trim()`；`id = "dsh:" + <文件名去 .json> + ":" + index`；`sessionId` 为文件名；`sessionTitle = rows.title.val`；`project = rows.workingDirectory.val`。
- `sourceId = "dsh-sessions"`；`file/relPath/line/heading/due/...` 为 null；`tags/links` 为 `[]`。
- 读取失败（目录不存在）→ sources 里 `error` 说明，不抛错。
- 跳过 `sessionTitle` 含子代理标记的会话？**不跳过**，全部展示（客户端可自行降噪）。

## 4. 配置默认值

```js
export const DEFAULTS = {
  markdownRoots: [
    { id: 'obsidian-main', label: 'Obsidian 主库', path: 'C:\\Users\\me\\Desktop\\my_obsidian' },
  ],
  includeDshTodos: true,
  includeDshCompleted: false,
  dshCacheDir: '',              // 空 => <DSH_HOME>/storages/session_projcache/sessions
  excludeDirs: ['.obsidian', '.git', '.trash', 'node_modules', 'obsd_attch', 'obs_attch', 'attachments', '_history', '00legacy', '_论文'],
  excludeSuffixes: ['.excalidraw.md'],
  maxFileBytes: 1_500_000,
  maxFiles: 20000,
  dshMaxSessions: 300,
  cacheTtlMs: 15000,            // aggregate 内存缓存；force=true 绕过
}
```

`normalizeConfig`：逐字段校验（数组/布尔/数字/字符串），非法抛 `Error('leo-status config: ...')`；`markdownRoots` 每项必须有非空 `path`，`id` 缺省用 `obsidian-N`，`label` 缺省用目录名。

## 5. 客户端（client.js）要求

浏览器模块，格式必须与 DSH 现有插件一致（抄 `my-dsh-ui/client.js` 的骨架）：

```js
window.__ModuleLoader__.load({ id: 'leo-status', factory(require) { const React = require('react'); ... return { inject: ['slots','locale'], apply } } })
```

- 注册两个 slot（用 `ctx.slots.inject(slot, () => ctx.slots.register(...))`）：
  - `sidebar.panellist`：`{ id: 'leo-status', order: 20, label: () => t('nav'), locale: NS }`，组件画一个 checklist 图标（inline SVG，`size` prop，`active` 时用 `--dsw-alias-brand-primary`，否则 `currentColor`）。
  - `main`：`{ key: 'leo-status', locale: NS }`，组件是整页看板。
- 文案走 `ctx.locale.register(NS, { zh: {...}, en: {...} })`（NS = `'leoStatus'`），slot 注册时带 `locale: NS` 即可拿到 `t` prop。
- 数据：`fetch('/leo-status/api/todos')`，`credentials: 'same-origin'`；刷新按钮请求 `?refresh=1`；失败显示离线提示 + 重试。
- 页面结构（从上到下）：
  1. 标题行：`Leo 状态` + 副标题“待办 · 只读聚合”；右侧：最后扫描时间、刷新按钮。
  2. 统计条：未完成 / 逾期 / 今天 / 未来 7 天（数字大、标签小）。
  3. 工具栏：搜索框（按 text/heading/tags 过滤）、来源筛选 chips（全部 + 每个 source）、“隐藏已完成”开关。
  4. 分组列表：逾期 → 今天 → 未来 7 天 → 以后 → 无日期 → 已完成（默认折叠，显示数量）。空组不显示。每组有标题 + 数量。
  5. 每条：复选框样式的状态图标（只读）、文本（完成的加删除线）、右侧元信息（截止日 chip；逾期红/今天橙/未来中性）、优先级点、来源徽标（markdown：文件名；dsh：会话标题）、hover 时显示完整路径/标题链（用 `title` 属性即可）。
  6. 底部：扫描耗时、来源错误（若有）、文件数统计。
- 空状态：首次还没数据 → loading 骨架/文字；无 todo → 空状态说明 + 如何添加（写 `- [ ] 任务`）。
- 样式：`<style data-plugin-css="leo-status/…">` 注入（组件内 `useEffect` 插入/清理，或 `ctx.effect` + helper，选一种并保证卸载清理）；**只允许 `--dsw-alias-*` / `--dsw-radius-*` / `--dsw-focus-ring-*` 等主题 token**，禁止写死颜色（图标 artwork 除外）；类名前缀 `ls-`。
- 不 require 任何 `@deepseek-ai/*` 客户端包；不读写别的插件 DOM。
- 兼容 React 18；用 `React.useState/useEffect/useMemo`，不做 JSX（直接 `h(...)`）。
- 响应式：窄窗口下统计条/工具栏可换行；页面自身 `box-sizing:border-box; padding:24px 32px; overflow:auto; height:100%`。

## 6. 验证

- `node --check scan.js`、`node --check index.js`、`node --check client.js`（`node --check` 对 ESM 也可用；client.js 顶层是 `window`，语法检查不需要运行）。
- `node --test test/scan.test.mjs` 必须全绿。
- client.js 无法在本机单测（浏览器 React），至少保证：无 `require('@deepseek-ai/...')`、无顶层副作用（除 `__ModuleLoader__.load`）、slot 注册 key 正确。

## 7. 已核实的外部事实（不要重新调研）

- **侧栏导航**：`sidebar.panellist` 是 list slot；`id` 必须等于 `main` 的 `key`，侧栏按钮由 shell 画，label 由注册项投影。
- **整页**：`main` 是 keyed slot，注册 `{ name:'main', key:'leo-status' }`。
- **客户端 slot API**：`ctx.slots.inject(slotName, () => ctx.slots.register({ name, id|key, order, label, locale }, Component))`；参考实现 `C:\Users\me\.dsh\profiles\desktop\node_modules\my-dsh-ui\client.js` 第 712–746 行（注册）、第 832–847 行（insertStyle）、第 1261 行止（return）。
- **Host HTTP**：`ctx.inject(['webServer','connection'], (http) => { http.effect(() => http.webServer.register({ kind:'exact', path:'/leo-status/api/todos', handler }), '...') })`；handler 里先 `http.connection.authorizeIndex(req,res)`；参考 `my-dsh-ui/index.js` 第 257–323 行。
- 客户端 fetch 路径写绝对路径：`/leo-status/api/todos`。
- profile：desktop；`DSH_HOME` 默认 `C:\Users\me\.dsh`。
