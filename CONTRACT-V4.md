# leo-status v0.4.0 契约：自然导入 + 阿源

> 状态：实现中（2026-10-27）。前序契约见 `CONTRACT.md`(v1) / `CONTRACT-V2.md`(多设备) / `CONTRACT-V3.md`(行内操作)。
> 本版本目标（用户原话）：「让这些 todo 的导入更自然、准确」；Obsidian 自动发现；会话 todo 只收「收尾型 / 高相关且大概率乐意做」的，且**必须点 accept**；新增全局管家 agent「阿源」：composer 左下 icon + 展开对话、记忆、红点分类信号（todo 建议 / 事项提醒 / 关键 deadline）。

## 0. 一句话架构

```
Obsidian(.md) ──规则扫描/增量缓存──┐
                                  ├─→ scan snapshot ─→ board ─→ client 看板
DSH session_projcache ──精筛──→ suggestions（pending）
                                  │        └─ accept/dismiss ─→ 存储
阿源 chat（LLM, host ctx.llm）──→ 建议/记忆/提醒 ──→ signals（红点）
                                  └─→ 持久化 yuan/chat.jsonl · memory.jsonl · reminders.json
```

- 所有写入都在本机；不新增公网入口；沿用 v0.3.1 page-token 鉴权。
- 阿源不直接改笔记；它只能「建议」，accept 后进入收件箱（suggestions 存储），笔记写回仍只由看板行内操作完成。
- Obsidian checkbox 仍可直接看板操作；tag/marker/frontmatter 发现项只读（`writable:false`）。

## 1. 设置扩展（settings.js）

在现有 settings 上新增（缺省值必须中性、无个人路径）：

```jsonc
{
  "obsidian": {
    "autoDetect": true,              // 根 roots 为空时自动接入检测到的 vault
    "searchRoots": [],               // [] = 默认搜索根（Desktop/Documents/D:/C:\data）
    "maxDepth": 4,
    "conventions": {
      "checkbox": true,              // - [ ] / - [x]（始终启用，可显式关）
      "tagLines": true,              // 含 #todo/#task/#待办 的行
      "tags": ["todo", "task", "待办", "TODO"],
      "frontmatter": true,           // frontmatter todo:true / status:todo / tags 含 todo
      "frontmatterList": true,       // frontmatter todos: [..] → 合成 todo（line=0，不可写）
      "markers": false,              // 行内 TODO:/待办：
      "markerWords": ["TODO", "待办", "FIXME"],
      "headingStatus": true          // 用最近标题推断状态（进行中/已完成/阻塞）
    }
  },
  "sessionFilter": {
    "enabled": true,
    "acceptScore": 0.55,             // ≥ 直接进入待确认
    "reviewScore": 0.35,             // ≥ 低置信待确认
    "skipSubagentSessions": true
  },
  "yuan": {
    "enabled": true,
    "name": "阿源",
    "model": null,                   // null = agentDefaultModel 当前选择；{provider,model}
    "maxHistory": 30,                // 送进 prompt 的最近对话条数
    "maxMemory": 40                  // 送进 prompt 的记忆条数
  }
}
```

- `normalizeSettings` 必须兜底：未知字段保留；`conventions.tags` 非空字符串数组；阈值 0–1。
- `settings.version = 2`。
- 设置文件仍在 `<dataDir>/settings.json`；新增数据目录：
  - `<dataDir>/cache/scan-cache.json`（扫描缓存，可删）
  - `<dataDir>/suggestions.json`（建议箱）
  - `<dataDir>/yuan/chat.jsonl`、`yuan/memory.jsonl`、`yuan/reminders.json`
- `effectiveScanConfig(rowConfig, settings)` 追加：
  - `conventions = settings.obsidian.conventions`
  - `autoDetect = settings.obsidian.autoDetect`
  - `searchRoots = settings.obsidian.searchRoots`
  - `vaultMaxDepth = settings.obsidian.maxDepth`
  - `cacheFile = <dataDir>/cache/scan-cache.json`（由 index.js 传入，settings 不拼路径）

## 2. scan.js：Obsidian 自动发现

### 2.1 导出

```js
export function detectVaults({ searchRoots, maxDepth = 4, limit = 20, signal } = {})
// → Promise<Array<{ path, name, noteCount, lastMtimeMs }>>
// 规则：BFS 目录；某目录含 `.obsidian` 子目录 = vault；不进入 .obsidian/.git/node_modules；
//       跳过无权限目录；noteCount = 该 vault 下 .md 数量（上限 5000 个，防御性）；
//       按 noteCount 降序；路径去重（realpath 失败用 resolve）。
```

`aggregate(config, opts)` 保持签名与返回结构，新增：
- `snapshot.meta.discoveredVaults`：当自动发现生效时为 `[{path,name,noteCount}]`，否则 `[]`
- `snapshot.meta.cache = { enabled, files, hits, misses }`
- 每个 todo 新增：
  - `discoveredBy`: `'checkbox'|'tag'|'frontmatter'|'frontmatter-list'|'marker'|'dsh'`
  - `writable`: boolean（只有 checkbox 且 kind=markdown 为 true；dsh 为 false）
  - `confidence`: 0..1（checkbox=1，tag=0.8，frontmatter-list=0.7，marker=0.75）
- 旧字段全部保留（id/kind/text/raw/done/cancelled/...）。
- `snapshot.stats` 增加 `discovered: {checkbox, tag, frontmatter, marker}`。

### 2.2 自动发现与 roots

`normalizeConfig` 新增字段：`conventions`（对象，按 1 节默认值兜底）、`autoDetect`（bool）、`searchRoots`（string[]）、`vaultMaxDepth`（number）、`cacheFile`（string）。

生效顺序：
1. `config.markdownRoots` 非空 → 用配置 roots（不自动发现）。
2. `markdownRoots` 为空且 `autoDetect` → `detectVaults({ searchRoots: config.searchRoots.length ? config.searchRoots : DEFAULT_SEARCH_ROOTS, maxDepth: config.vaultMaxDepth })`，每个 vault 作为 `{ id: 'vault-<hash8>', label: name, path }` 的 root 扫描；结果放 `meta.discoveredVaults`。
3. 都没有 → 空快照（不报错）。

`DEFAULT_SEARCH_ROOTS`（Windows 下）：`Desktop`、`Documents`、`D:\`、`C:\data`（只取存在的；非 Windows 用 `~/Desktop`、`~/Documents`、`~/`）。

### 2.3 规则解析（parseMarkdownContent）

现有 checkbox 规则不变。新增（仅当对应 convention 开启）：

1. **tag 行**（`tagLines`）：行内出现 `#todo` / `#task` / `#待办`（大小写不敏感，允许 `#todo/must`），且该行不是标题、不在代码围栏、不是 checkbox 行、正文非空。todo 文本 = 去掉行首 bullet/引用符后的整行，去掉标签本身；`line` 为真实行号；`writable:false`。
2. **marker 行**（`markers`）：行内 `TODO:` / `待办：` / `待办:` / `FIXME:`（大小写不敏感）且不是 checkbox 行；文本取冒号后内容（为空则取整行）；`writable:false`。
3. **frontmatter**（`frontmatter`）：文件 frontmatter 含 `todo: true`、`status: todo` 或 `tags:` 中含 `todo/task/待办` → 该文件所有 checkbox 行置信度提升为 1，并给文件加 `fileFlag:'todo'`（不改变行数）。
4. **frontmatter-list**（`frontmatterList`）：frontmatter `todos:` 为 YAML 列表（`- text` 块或 `[a, b]` 行内）→ 每条合成一个 todo：`line:0`、`raw:''`、`relPath` 正常、`writable:false`、`id: md:<sourceId>:<relPath>:fm:<idx>`。
5. **标题状态**（`headingStatus`）：最近标题匹配 `已完成|done` → done；`进行中|doing|in progress` → 该行 `headingStatus:'in_progress'`；`阻塞|blocked|卡住` → `headingStatus:'blocked'`；`待做|待办|todo|future|计划` → `headingStatus:'pending'`。输出字段 `headingStatus`（无匹配为 null）。它不改 done/cancelled 布尔，只做展示提示。
6. **去重**：同一文件内 `checkbox` 优先于 `tag`/`marker`（同一行有 checkbox 则跳过 tag/marker）；frontmatter-list 与 checkbox 文本相同（归一化后）时不重复。
7. **排除**：仍沿用 excludeDirs/excludeSuffixes；`.excalidraw.md` 默认排除（现有 suffix）；`## Drawing` / `## Text Elements` 段内 `[ ]` 不得识别（当前 checkbox 正则会误判，本版必须跳过这两个二级标题之后的内容直到下一个同级/更高级标题）。

`aggregate` 的缓存：
- `cacheFile` 存在时读写 JSON：`{ version:1, roots: { [rootId]: { files: { [relPath]: { mtimeMs, size, todos:[...] } } } } }`。
- 同一 root 内，文件 `mtimeMs+size` 未变 → 复用 `todos`（`cache.hits++`），不读文件内容；变了/新增 → 解析（`misses++`）；删除的文件从缓存移除。
- 写缓存用 `.tmp` + rename，失败只 log 不抛。
- 缓存里只放 todo 数据（不含全文），避免把笔记内容复制到 dataDir。

## 3. suggest.js：会话 todo 精筛 + 建议箱

### 3.1 导出

```js
export const SUGGESTION_VERSION = 1
export const DEFAULT_FILTER = { enabled:true, acceptScore:0.55, reviewScore:0.35, skipSubagentSessions:true }

export function classifySessionTodo(todo, opts = {})
// todo: scan snapshot 里的 kind==='dsh' 项（含 text/sessionId/sessionTitle/project/done/status）
// → { kind:'wrapup'|'relevant'|'noise', score:number, bucket:'accept'|'review'|'noise',
//     reasons:string[], normalized:string }
// 规则见 3.2；纯函数、无 IO。

export function suggestionId(todo)  // 'sug:' + sha1(sessionId + '\u0000' + normalized).slice(0,16)

export function deriveSuggestions(snapshot, { filter, now = Date.now() } = {})
// → { items:[...], stats:{total,accept,review,noise,skippedSessions}, skipped:[{sessionId,title,reason}] }
// items: { id, text, normalized, sessionId, sessionTitle, project, kind, score, bucket, reasons,
//          status:'pending', source:'session', createdAt: nowISO }
// 只处理 kind==='dsh' && !done；skipSubagentSessions 时跳过 subagent 会话。

export function createSuggestionStore(dataDir)
// → {
//   file, load(): Promise<void>, snapshot(): {version, items:[...]},
//   list(status='pending'): items[], get(id),
//   mergeDerived(items): { added, kept, dismissed },   // 以 pending 为基线合并；dismissed/accepted 不复活
//   accept(id): item, dismiss(id): item,
//   remove(id): boolean
// }
// suggestions.json 原子写；status ∈ pending|accepted|dismissed|removed
```

### 3.2 精筛规则（确定性，无 LLM）

先判 noise（命中直接 noise，score 记为 0.1）：
- `task-\d` / `return .*summary` / `you are a .*teammate` / `spawn .*teammate` / `^research `/`^read `/`^explore `/`^investigate `/`^implement `/`^write .*report`/`^update todo list`/`^verify `（英文开头命令式，且不含中文）
- 会话标题命中 `research teammate|subagent|研究队友`（整会话跳过，见 3.1）。
- 纯工具步骤：以 `/` 开头、或 `<` 开头、或长度 < 4、或只有英文动词+路径。

wrapup 信号（命中 +0.6，可叠加最多 0.6）：
- 中文：收尾/收口/收束/整理/归档/提交/推送/发布/部署/上线/验证/核验/确认/检查/修复/回复/反馈/清理/总结/复盘/记录/同步/补测试/补文档/写文档/更新文档/更新 README
- 英文：wrap up|finalize|verify|test|commit|push|release|deploy|publish|cleanup|follow up|reply|respond|fix|document|update docs|README

高相关信号（命中 +0.25）：
- 项目词：leo-status/leo/阿源/co-align/看板/插件/obsidian/笔记/论文/汇报/记忆/对话助手/dsh/plugin/agent/todo
- 第一人称意图：我想/我要/我需要/我打算/我计划/我决定/应该/记得/别忘了/想要

分数 = min(1, wrapup + relevant + intent)，noise 直接 0.1。
bucket：score ≥ acceptScore → accept；≥ reviewScore → review；否则 noise。
reasons：最多 3 条中文短语，例：`收尾类`、`与你相关：leo-status`、`你亲口说的`、`低置信`。

会话级兜底：同一会话内若 accept 数 > 6，只保留分数最高的 6 条（防刷屏），其余降为 review。

## 4. yuan.js：阿源（记忆 + 聊天 + 提醒 + 信号）

### 4.1 导出

```js
export function createYuanStore(dataDir)
// → {
//   chatFile, memoryFile, reminderFile,
//   loadChat(limit=200): Promise<chat[]>,   // 尾部 limit 条，正序
//   appendChat(entry): Promise<chat>,        // {id, role:'user'|'assistant', text, at, proposals?, signal?}
//   loadMemory(limit=200), appendMemory({text, source='manual'|'chat', at?}), forgetMemory(id),
//   loadReminders(), saveReminders(list), addReminder({text, at}), doneReminder(id),
//   lastSeen(): Promise<number>, markSeen(at): Promise<void>,   // yuan/state.json
//   state(): { lastSeenAt }
// }

export function buildSignals({ board, suggestions, reminders, chat, lastSeenAt, now = Date.now() })
// → { signals:[{kind:'suggestion'|'reminder'|'deadline'|'unread', severity:'info'|'warn'|'urgent',
//                count, title, detail}], badge:{ total, urgent, kinds:{...}, hasUnread } }
// 规则：
//  - suggestion: pending+review 数（warn；review 不单独计 urgent）
//  - reminder: 未完成且 at <= now+24h（urgent；过期 detail 含「已过期」）
//  - deadline: board.todos 未完成且有 due，due <= now+3d（≤24h/过期 → urgent，否则 warn）
//  - unread: 最后一条 assistant.chat.at > lastSeenAt（info）
// 最多 6 条，按 urgent→warn→info 排序。

export function buildYuanPrompt({ board, suggestions, memory, reminders, chat, now })
// → { system, messages:[{role:'user'|'assistant',content:[{type:'text',text}]}] }
// system 要求：中文、简短、只基于给定事实；不编造；可输出标记：
//   <<TODO 文本>> 建议一条 todo
//   <<MEMORY 文本>> 记住一条事实
//   <<REMINDER 文本 | 2026-10-28T09:00:00+08:00>> 加提醒
// messages 用最近 chat（yuan.maxHistory）压成纯文本轮次。

export function parseYuanMarkers(text)
// → { text: 去标记后的正文, todos:[string], memories:[string], reminders:[{text,at}] }

export function createYuanService({ dataDir, log, llm, getModel, config })
// → { store, state(), chat(message, {board, suggestions, reminders, now}), remember(text), forget(id),
//      addReminder, doneReminder, signalsNow(...), markSeen() }
// chat：串行队列；追加 user；调 llm；失败/无 llm → fallbackReply(...)（确定性摘要，不抛）；
//       解析 markers → 写 memory/reminder/返回 proposals；追加 assistant；返回 { reply, chat, proposals, signals }
```

### 4.2 LLM 调用

- 模型解析：`getModel()` → `{provider, model, reasoningEffort}`；优先 `ctx.get('agentDefaultModel')?.currentSelection()`，其次 `config.yuan.model`，最后 `{provider:'deepseek-official', model:'deepseek-flash'}`。
- 调用：`llm.stream({ provider, model, reasoningEffort, system, messages, maxTokens: 900, temperature: 0.4, signal })`；收集 `text-delta`；`finish.kind==='error'|'aborted'` → fallback。
- 超时 20s（AbortController）；`llm` 未注册或 `listProviders()` 不含 provider → 直接用 fallback（不发请求）。
- fallback 文案（中文）：今日日期 + 未完成数 + 3 条待确认建议 + 最近截止 + 提醒；结尾说明「模型暂不可用，以上是看板摘要」。

### 4.3 记忆

- 对话：`yuan/chat.jsonl` 每行一条；启动加载尾部 200 条；面板展示最近 30 条。
- 事实：`yuan/memory.jsonl`；`remember(text, source)` 去重（归一化后相同不重复）；prompt 取最近 `maxMemory` 条。
- 「记住：xxx」「记住 xxx」命令：直接写 memory 并回执；不调用 LLM（省时）。
- 记忆删除：`forget(id)` 追加一条 `{type:'forget', target:id}` 或重写文件（简单起见重写，原子写）。

### 4.4 提醒

- `reminders.json`：`[{id, text, at, done, createdAt}]`。
- 自然语言添加由 LLM 标记或面板「+提醒」完成；时间解析只接受 ISO 或 `YYYY-MM-DD HH:mm`（本地时区，Asia/Shanghai 由宿主时区决定）。

## 5. index.js：路由与看板

### 5.1 看板注入

`buildLocalBoard(snapshot, meta)` 与 hub board 后统一经 `augmentBoard(board)`：
- `board.suggestions = store.list('pending')`（含 review，字段同 3.1）
- `board.yuan = { badge, signals, unread, name:'阿源' }`
- `board.todos` 追加 accepted 建议：`{ id, kind:'suggestion', text, done:false, cancelled:false, editable:false, writable:false, sourceLabel:'阿源', sessionId, sessionTitle, acceptedAt }`
- accepted 建议重复文本已在 markdown/dsh 中时仍保留（用户已接受），不自动去重。
- hub 远端快照不含 suggestions；仅本机 hub 进程合并自己的建议（多设备暂不同步建议，契约允许）。

### 5.2 路由（全部沿用 `authorized()`）

| 方法 | 路径 | 请求 | 返回 |
|---|---|---|---|
| GET | `/leo-status/api/yuan/state?chat=1&limit=30` | — | `{ok, signals, badge, unread, suggestions, chat, memory, reminders, model:{provider,model,available}, name}` |
| GET | `/leo-status/api/yuan/signals` | — | `{ok, signals, badge, unread, pending}`（轮询用，轻量） |
| POST | `/leo-status/api/yuan/chat` | `{message}` | `{ok, reply, chat, proposals, suggestions, signals, badge}` |
| POST | `/leo-status/api/yuan/suggestion/accept` | `{id}` | `{ok, item, suggestions, board}` |
| POST | `/leo-status/api/yuan/suggestion/dismiss` | `{id}` | `{ok, item, suggestions}` |
| POST | `/leo-status/api/yuan/remember` | `{text}` | `{ok, memory}` |
| POST | `/leo-status/api/yuan/memory/delete` | `{id}` | `{ok, memory}` |
| POST | `/leo-status/api/yuan/reminder` | `{text, at}` | `{ok, reminders, signals}` |
| POST | `/leo-status/api/yuan/reminder/done` | `{id}` | `{ok, reminders, signals}` |
| POST | `/leo-status/api/yuan/seen` | `{}` | `{ok, lastSeenAt}` |
| GET | `/leo-status/api/obsidian/vaults` | — | `{ok, vaults:[{path,name,noteCount,lastMtimeMs,attached}]}` |
| POST | `/leo-status/api/obsidian/attach` | `{path}` | `{ok, roots, board}` |
| GET | `/leo-status/api/settings` | — | `{ok, settings}`（脱敏：去掉 password） |
| POST | `/leo-status/api/settings` | 任意 safe 子集 | `{ok, settings}`（深合并，保留 password；只接受白名单字段） |

- 所有写操作需要 body ≤1MB；错误统一 `{ok:false,error,code?}`；LLM 失败仍 200 + fallback（UI 不红屏）。
- `POST /yuan/chat` 串行化（yuanQueue），防并发写 jsonl。
- accept/dismiss 后立即返回新 board（accept 会重新构建 board，含 accepted todo）。
- `GET /settings` 与 `POST /settings` 的白名单：`obsidian.*`、`sessionFilter.*`、`yuan.enabled/name/model/maxHistory/maxMemory`、`includeDshTodos`、`includeDshCompleted`、`syncIntervalMs`、`markdownRoots`（仅 attach/手动）。

### 5.3 启动

- startup 后 `suggestionStore.load()`、`yuanStore.loadChat()`、`userStore`；`augmentBoard` 每次 board 构建时重新派生 suggestions（`deriveSuggestions` + `mergeDerived`）。
- 扫描周期不变；suggestions 派生随快照刷新，无需额外定时器。
- 新设置保存后需要重建 scan config；`POST /settings` 成功后清 `localCache` 并触发一次 scan。

## 6. client.js：阿源 UI

### 6.1 入口

- 注册 `conversation.input.left`：`id:'leo-yuan'`, `order:100`, `locale:NS`；组件 `YuanEntry`。
  - 按钮：圆角小按钮 `ls-yuan-entry`，显示「源」字 + 右上红点（`.ls-yuan-dot`，类 `is-urgent|is-warn|is-info`）。
  - 点击 `toggleYuan()`；`aria-label`/`title` 走 locale。
  - 挂载时拉 `/yuan/signals`（60s 轮询，卸载清理），badge 变化刷新。
- 注册 `conversation.input.dock`：`id:'leo-yuan-panel'`, `order:5`, `locale:NS`；组件 `YuanPanel`。
  - `open===false` 时返回 null（不占空间）。
  - 面板：`ls-yuan-panel`，max-height 52vh，overflow auto；包含：
    1. header：源 icon + 阿源 + 副标题（模型/离线）+ 关闭；
    2. signal chips：`建议 n` / `提醒 n` / `截止 n`（点击滚动到对应 section）；
    3. 建议卡（pending/review）：文本、来源（会话标题/笔记）、reason chips、[接受] [忽略]；accepted 后卡片消失并提示；
    4. 提醒卡：文本 + 时间 + [完成]；已过期红色；
    5. chat：消息列表（用户右、阿源左、时间），proposals 内联卡片带 [接受]；滚动到底；发送中显示「阿源正在想…」；
    6. 记忆（折叠）：事实 chips + 删除 ×；输入「记住：xxx」也可。
    7. composer：单行输入 + 发送按钮；Enter 发送，Shift+Enter 换行；空文本禁用。
  - 所有文案走 locale（新增 zh/en 各 ≥45 key）；无硬编码中文（图标「源」除外）。
- 看板页 `DashboardPage` 顶部增加「阿源建议」卡（同 store）：显示 pending 数、前 3 条、接受/忽略、打开面板按钮（打开后滚到 composer 的 dock）。

### 6.2 store（module 级）

```js
const yuan = {
  open:false, loading:false, error:null, state:null, sending:false, lastLoadedAt:0,
  listeners:new Set(),
  subscribe(fn), emit(), set(patch),
  async load(force), async send(text), async acceptSuggestion(id), async dismissSuggestion(id),
  async addReminder(text, at), async remember(text), async deleteMemory(id), async markSeen(),
  toggle(), openPanel(), closePanel(),
}
```
- 组件用 `useState` + `useEffect` 订阅（兼容现有 mini-React harness；不要用 useSyncExternalStore）。
- `apiFetch`（已有）自动加 `x-leo-status-token`；所有请求 try/catch，错误写 `yuan.error`，不抛。
- 接受/忽略后乐观更新：先本地移除，再以响应为准；失败回滚。

### 6.3 视觉

- 沿用现有 CSS 变量/主题色（`--dsh-*`）；红点三种颜色：
  - urgent：`#e5484d`（红）
  - warn：`#f5a524`（琥珀）
  - info：`#3b82f6`（蓝）
- 面板与看板同字体/圆角；不覆盖宿主 composer 控件；不读别的插件 DOM。

## 7. 测试与验收

- 单测新增：
  - `test/discover.test.mjs`：detectVaults（临时目录 + `.obsidian`）；tag/marker/frontmatter-list 解析；代码围栏/绘图段排除；缓存命中（第二次扫描 hits>0 且结果一致；改 mtime 后重新解析）。
  - `test/suggest.test.mjs`：wrapup/relevant/noise 分类；subagent 跳过；同会话 >6 截断；store accept/dismiss 持久化、dismiss 不复活。
  - `test/yuan.test.mjs`：chat jsonl 追加/加载；memory 去重/删除；signals（suggestion/reminder/deadline/unread）；parseYuanMarkers；fallback reply；buildYuanPrompt 含看板摘要。
- 既有 74 测试必须全绿。
- `_scan/api-smoke.mjs` 扩展：14 条路由未授权 401；token 200；chat fallback 200（无 LLM 环境用假 llm 或直接 fallback）；accept 后 board 出现 suggestion todo。
- `_scan/client-render-test.mjs` 扩展：YuanEntry 渲染、点击打开面板、accept 调用 POST、locale key 对齐。
- 本机热更新后：真实模型 chat 至少一次成功；红点出现；accept 生效；Obsidian 自动发现 ≥1 个库且看板出现 auto root 的 todo。

## 8. 发布

- 版本 `0.4.0`；README/CONTRACT-V4 更新；`package.json` files 加 `suggest.js`,`yuan.js`,`discover`（若独立文件）。
- 提交并推 GitHub（`tula-liuxin/leo-status`），市场站点 `tula-liuxin/dsh-conversation-companion` 的 `docs/index.json` 增加 0.4.0（40 位 SHA + Unix 时间戳），验证线上 JSON/图标 200。
- 不在仓库写密码、本机绝对个人路径、VPS IP。
