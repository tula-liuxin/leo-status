# leo-status

DSH（DeepSeek Harness）插件：**Leo 状态看板 + 管家「阿源」**。自动发现 Obsidian / DSH 会话里的 TODO，多设备聚合；会话建议先审后收，阿源记住你、盯截止、发红点。

## 现在能做什么

- **Obsidian 自动发现**：默认扫描本机常见位置里的 Obsidian 库（含 `.obsidian` 的目录），不需要手工登记路径；也可以在看板的「数据源」tab 里一键「接入」检测到的库（默认打开「待办」tab，不占页面）。识别规则是确定性的脚本规则（不是让 AI 读全盘笔记）：
  - 复选框：`- [ ]` / `* [ ]` / `+ [ ]` / `1. [ ]`，可缩进、可写 `>` 引用；`[x]` 完成、`[-]` / `[/]` / `~~删除线~~` 作废；
  - 标签行：行内出现 `#todo` / `#task` / `#待办`（含 `#todo/xxx`）→ 记为只读任务；
  - 标记行：`TODO:` / `待办：` / `FIXME:`（默认关闭，可在设置里打开）；
  - frontmatter：`todo: true` / `status: todo` / `tags` 含 todo，或 `todos:` 列表 → 合成任务（只读）；
  - 自动跳过代码围栏、`.excalidraw.md` 的 `## Drawing` / `## Text Elements` 段、`_history` / `00legacy` / `_论文` 等噪声目录；
  - 文件名 `9.1 motivation.md` 会推断笔记日期；标题里的「进行中 / 已完成 / 阻塞 / 待做」会作为状态提示。
- **DSH 会话 todo 精筛（0.4.1 起不再直接进看板）**：只把「收尾型」（验证/提交/整理/回复/修复/写文档…）和「与你高相关且大概率乐意做」的会话 todo 放进**建议箱**；研究/工具步骤/子代理会话（teammate / research teammate / subagent）默认整会话排除。**没有一条会自动进看板——必须由你在阿源里点「接受」**，接受后成为看板里的「阿源」任务；「忽略」的不会被重新推回。0.4.1 升级时会一次性清空旧版留下、几乎不可用的 session 建议（保留阿源自己提的建议）。
- **阿源（管家 agent，0.4.3 起是真实 Agent）**：会话输入框左下多一个「源」按钮，点开是阿源面板：
  - **完整能力**：阿源跑在一个真实的 DSH Agent 会话里（默认 preset 的全部工具，`danger-full-access` 沙箱 + `never` 审批，和你的权限一致）；它会像正常会话一样调用工具、读文件、跑代码——默认不会主动翻你的文件，只在需要时读；面板里会显示工具卡（工具名/参数/结果/错误）。面板头部还有「原生会话」按钮：一键用 DSH 原生会话 UI 打开同一个阿源 agent，工具/权限/界面与外部完全一致。
  - **聊天区**：接近 DSH 对话的阅读体验——阿源头像/时间/模型徽标、Markdown（标题/列表/代码块/引用/链接）、消息复制、发送中三点动画、失败重试、空会话 3 个快捷问题；完全自绘、`ls-yuan-*` 前缀，不覆盖宿主 UI。
  - **红点分三类**：待确认建议（琥珀）、提醒/截止（红）、新回复（蓝）；
  - **接受 / 忽略**建议；**提醒**可加、可完成；**记忆**折叠区可看待确认/已确认事实，说「记住：…」直接记；模型自动提取的记忆先标 pending，你确认后才进入后续上下文（防持久化提示注入）。
- **看板**：侧栏「待办」整页；逾期 / 今天 / 7 天 / 以后 / 无日期 / 已完成分组，搜索、来源筛选、设备筛选、隐藏已完成；本机 Markdown 行可直接**勾选/取消勾选**、**作废/启用/删除**（写回源笔记，原子写）。
- **多设备**：任意设备装同一插件，用中心地址 + 密码加入；中心合并所有设备快照，按设备区分；中心离线时设备显示本机缓存。
- **只读扫描 + 显式写回**：除你点选的看板操作外不改笔记；接受建议只写入 `suggestions.json`，不碰笔记。

## 阿源怎么用

1. 打开任意会话，在输入框左下点「源」；
2. 面板会列：待确认建议 → 提醒 → 聊天 → 记忆；空会话里有 3 个快捷问题可点；
3. 对建议点「接受」进看板、点「忽略」不再出现；
4. 直接和阿源聊：「今天先做哪三件？」「提醒我周五交报告」「记住：我晚上不看新任务」；
5. 阿源给出的建议如果是 `<<TODO …>>`，会变成一条待确认建议；`<<REMINDER … | ISO 时间>>` 会加提醒。

> 阿源默认用 DSH 的默认模型（`agentDefaultModel`）。模型不可用/超时时，它会用确定性看板摘要回复，界面不会报错。

## 架构

```
设备 A（中心/hub）                         VPS（中转，可选）                      设备 B / C（device）
┌───────────────────────┐   ssh -R 隧道    ┌─────────────────────────┐  HTTPS   ┌──────────────────┐
│ DSH + leo-status      │  18899→8790     │ Caddy /leo-status/*     │─────────▶│ DSH + leo-status │
│  · 自动发现 + 扫描      │────────────────▶│   → 172.18.0.1:18888    │          │  · 本地扫描       │
│  · 建议箱 + 阿源        │                 │   → forward.py          │          │  · join/push/    │
│  · hub HTTP :8790     │                 │   → 127.0.0.1:18899     │          │    board 同步     │
│  · 数据 C:\data\leo-status │              └─────────────────────────┘          └──────────────────┘
└───────────────────────┘
```

- 中心只绑 `127.0.0.1:8790`；公网入口由 VPS 的 HTTPS + TCP 转发 + 本机主动发起的 SSH 反向隧道提供。
- 其他设备只主动外连：`join` → `push` → `board`；VPS 不落盘 todo 数据。
- 建议箱与阿源记忆**只存在中心/本机**，暂不跨设备同步（设备端会显示中心看板里的建议，但接受操作在本地生效）。

## 安装

### 中心（本机）

```powershell
plugin_manager install_bundle target="<leo-status 源码目录或 github:tula-liuxin/leo-status>"
```

安装后：

1. 数据目录默认 `C:\data\leo-status`（可用 row config `dataDir` 或环境变量 `LEO_STATUS_DATA` 覆盖）；
2. 首次打开看板会自动发现 Obsidian 库；若要固定，可在 `<dataDir>/settings.json` 写 `markdownRoots`；
3. 中心模式：`mode: "hub"` + `hub.password` + `hub.tunnel`；
4. 侧栏「待办」页面出现「中心」状态后，中心就绪。

`settings.json` 示例（**不要提交进 git**）：

```json
{
  "mode": "hub",
  "deviceName": "leo",
  "markdownRoots": [],
  "obsidian": {
    "autoDetect": true,
    "searchRoots": [],
    "maxDepth": 4,
    "conventions": {
      "checkbox": true,
      "tagLines": true,
      "tags": ["todo", "task", "待办"],
      "frontmatter": true,
      "frontmatterList": true,
      "markers": false,
      "markerWords": ["TODO", "待办"],
      "headingStatus": true
    }
  },
  "sessionFilter": { "enabled": true, "acceptScore": 0.55, "reviewScore": 0.35, "skipSubagentSessions": true },
  "yuan": { "enabled": true, "name": "阿源", "model": null, "maxHistory": 30, "maxMemory": 40 },
  "includeDshTodos": true,
  "syncIntervalMs": 60000,
  "hub": {
    "port": 8790,
    "password": "<中心密码>",
    "tunnel": { "enabled": true, "sshTarget": "sh", "remotePort": 18899 }
  }
}
```

`searchRoots: []` = 使用默认搜索根（Desktop / Documents / 盘符根 / `C:\data`），深度 `maxDepth`。

### 其他设备

```powershell
plugin_manager install_bundle target="github:tula-liuxin/leo-status"
```

打开侧栏「待办」→ 顶部「加入 leo-status 中心」卡片 → 填中心地址（默认 `https://dsh.agencyarche.com/leo-status`）、密码、本机名称 → 加入。加入后自动上报并拉取合并看板。

### VPS 中转（可选，仅中心需要）

`deploy/vps/` 下有完整部署物：`forward.py`（TCP 转发）、`leo-status-relay.service`、`configure-edge.py`（幂等给 Caddy 加 `/leo-status/*` 路由）。部署与回滚见 [deploy/vps/README.md](deploy/vps/README.md)。

> ⚠️ co-align 重新部署会替换其 release 目录里的 Caddyfile，导致 `/leo-status` 路由丢失；重新部署后重跑一次 `configure-edge.py` 即可（幂等）。

## 数据与安全

- 数据目录：Windows 默认 `C:\data\leo-status`，其他平台 `~/.local/share/leo-status`：
  - `settings.json`（含明文密码，本机文件）
  - `hub/`（设备表 + 各设备最近快照）
  - `suggestions.json`（建议箱：pending / accepted / dismissed / removed）
  - `yuan/chat.jsonl`、`yuan/memory.jsonl`、`yuan/reminders.json`、`yuan/state.json`（对话、记忆、提醒、已读游标）
  - `cache/scan-cache.json`（按 mtime+size 的增量扫描缓存，可随时删除）
- 认证：中心 `/api/*` 除 `/api/health` 外要求 `Authorization: Bearer <hub.password>`；浏览器侧插件 API 沿用 DSH 页面 token（`x-leo-status-token`，持久化在 `<dataDir>/page-token`，插件重载不变）+ cookie 鉴权，拒绝 cross-site 请求。
- 笔记扫描只读；写回只发生在你点「勾选/作废/删除」时（原子写，保留 EOL/BOM/行尾空白）。
- 阿源聊天会把**看板摘要、待确认建议、记忆、提醒**发给宿主 `ctx.llm` 的默认模型；不发送笔记全文。模型生成的记忆默认 pending，确认后才进入上下文。
- VPS 只做 TCP 转发，不落盘 todo；本机关机时远端不可用（显示本机缓存）。

## 支持的 TODO 语法（续）

- 日期：`📅 2026-10-30`（截止）、`⏳`（计划）、`🛫`（开始），也支持 `due:: 2026-10-30`、`@due(2026-10-30)`；
- 优先级：`🔺/⏫`、`🔼`、`🔽`、`⏬`，或 `#p1`…`#p4`；
- 标签 `#tag`、双链 `[[note]]`、循环 `🔁 ...`；
- 只读发现项（`#todo` 行、`TODO:`、frontmatter `todos:`）没有 checkbox，看板上不可勾选/写回。

## 目录结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半边：角色切换（local/hub/device）、中心与隧道、18 条 DSH 路由（含阿源/设置/发现） |
| `hub.js` | 中心：设备表/快照存储/合并 Board/HTTP API |
| `sync.js` | 设备侧：join / push / fetchBoard |
| `settings.js` | `<dataDir>/settings.json` 读写、默认值与归一化 |
| `edit.js` | 行内写回：勾选/取消勾选、作废/启用/删除 Markdown 的一行（原子写、路径校验） |
| `scan.js` | 纯数据层：Obsidian 自动发现 + 规则解析 + 增量缓存 + DSH 解析 + 统计 |
| `suggest.js` | 会话 todo 精筛（wrapup/相关/noise）与建议箱存储 |
| `yuan.js` | 阿源：对话/记忆/提醒/信号/LLM 降级 |
| `client.js` | 浏览器半边：侧栏入口、看板、阿源入口/面板/红点、设备与加入卡片 |
| `test/*.test.mjs` | `node --test` 单测（scan/discover/hub/edit/suggest/yuan） |
| `deploy/vps/` | 可选 VPS 中转的部署物 |

## 开发

```powershell
node --check index.js
node --check scan.js
node --check suggest.js
node --check yuan.js
node --check client.js
node --test "test/*.test.mjs"   # Node 24：用 glob，不要用目录形式
node _scan/client-render-test.mjs   # 插件目录内的渲染 harness
```

接口与数据形状见 [CONTRACT.md](CONTRACT.md)（v1）、[CONTRACT-V2.md](CONTRACT-V2.md)（多设备）、[CONTRACT-V3.md](CONTRACT-V3.md)（行内操作/勾选）与 [CONTRACT-V4.md](CONTRACT-V4.md)（自动发现 + 阿源）。
