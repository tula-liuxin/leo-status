# leo-status

DSH（DeepSeek Harness）插件：**Leo 状态看板**。把散落在各设备上的 TODO 聚合到一个只读看板里，并支持多设备加入同一个中心。

## 现在能做什么

- 从本机 Markdown 笔记（Obsidian）扫描 `- [ ]` / `- [x]` 任务，从 DSH 会话投影读取 AI 抽取的 todo；
- Web UI 侧栏「待办」入口 → 整页看板：逾期 / 今天 / 未来 7 天 / 以后 / 无日期 / 已完成，支持搜索、来源筛选、隐藏已完成；
- **行内操作**：本地 Markdown 来源的 todo 可以直接「作废 / 启用 / 删除」——作废是在笔记里给该行正文加 `~~删除线~~`（Obsidian 里可见，再次点击启用会去掉），删除是删掉源笔记的这一行（不可撤销，可用 Obsidian 文件恢复兜底）；DSH 会话与远端设备的 todo 只读；
- **多设备**：任意设备装同一插件后，用中心地址 + 密码加入；本机作中心保存数据，看板合并所有设备的 todo，按设备区分（设备筛选、行上设备徽标、在线状态）；
- 只读扫描 + 显式写回：除你点击「作废/启用/删除」外不改任何笔记，也不写 DSH 会话。

## 架构

```
设备 A（中心/hub）                         VPS（中转，可选）                      设备 B / C（device）
┌───────────────────────┐   ssh -R 隧道    ┌─────────────────────────┐  HTTPS   ┌──────────────────┐
│ DSH + leo-status      │  18899→8790     │ Caddy /leo-status/*     │─────────▶│ DSH + leo-status │
│  · 本地扫描            │────────────────▶│   → 172.18.0.1:18888    │          │  · 本地扫描       │
│  · hub HTTP :8790     │                 │   → forward.py          │          │  · join/push/    │
│  · 数据 C:\data\leo-status │              │   → 127.0.0.1:18899     │          │    board 同步     │
└───────────────────────┘                 └─────────────────────────┘          └──────────────────┘
```

- 中心只绑 `127.0.0.1:8790`，公网入口由 VPS 上的 HTTPS + TCP 转发 + 本机主动发起的 SSH 反向隧道提供（本机 IP 不固定也没关系）。
- 其他设备永远只**主动外连**：`join` → `push`（本机快照）→ `board`（合并看板）。
- 中心离线时，设备显示本机快照 + “中心离线”；VPS 不保存 todo 数据。

## 安装

### 中心（本机）

```powershell
plugin_manager install_bundle target="<leo-status 源码目录或 github:tula-liuxin/leo-status>"
```

安装后：

1. 数据目录默认 `C:\data\leo-status`（可用 row config `dataDir` 或环境变量 `LEO_STATUS_DATA` 覆盖）；
2. 在 `<dataDir>/settings.json` 里把 `mode` 设为 `hub`、填 `hub.password`、`markdownRoots`（笔记目录）与 `hub.tunnel`；
3. 侧栏「待办」页面出现「中心」状态后，中心就绪。

`settings.json` 示例（**不要提交进 git**）：

```json
{
  "mode": "hub",
  "deviceName": "leo",
  "markdownRoots": [{ "id": "obsidian-main", "label": "Obsidian 主库", "path": "<你的笔记库路径>" }],
  "includeDshTodos": true,
  "syncIntervalMs": 60000,
  "hub": {
    "port": 8790,
    "password": "<中心密码>",
    "tunnel": { "enabled": true, "sshTarget": "sh", "remotePort": 18899 }
  }
}
```

### 其他设备

```powershell
plugin_manager install_bundle target="github:tula-liuxin/leo-status"
```

打开侧栏「待办」→ 页面顶部出现「加入 leo-status 中心」卡片 → 填中心地址（默认 `https://dsh.agencyarche.com/leo-status`）、密码、本机名称（可选笔记目录）→ 加入。加入后本机每小时/每分钟自动上报并拉取合并看板。

### VPS 中转（可选，仅中心需要）

`deploy/vps/` 下有完整部署物：`forward.py`（TCP 转发）、`leo-status-relay.service`、`configure-edge.py`（幂等给 Caddy 加 `/leo-status/*` 路由）。部署与回滚见 [deploy/vps/README.md](deploy/vps/README.md)。

> ⚠️ co-align 重新部署会替换其 release 目录里的 Caddyfile，导致 `/leo-status` 路由丢失；重新部署后重跑一次 `configure-edge.py` 即可（幂等）。

## 数据与安全

- 数据目录：Windows 默认 `C:\data\leo-status`，其他平台 `~/.local/share/leo-status`；里面只有 `settings.json`（含明文密码，本机文件）和 `hub/`（设备表 + 各设备最近一次快照）。
- 认证：中心的 `/api/*` 除 `/api/health` 外都要求 `Authorization: Bearer <hub.password>`；公网请求经 HTTPS（Caddy），中心端口只绑 loopback。
- VPS 只做 TCP 转发，不落盘 todo；本机关机时远端不可用（显示本机缓存）。
- 笔记扫描只读；排除 `.excalidraw.md`、代码围栏、frontmatter、附件目录与 `_history` 等噪声目录。

## 支持的 TODO 语法

- 复选框：`- [ ]`、`* [ ]`、`+ [ ]`、`1. [ ]`，可缩进、可写 `>` 引用里；`[x]` / `[X]` 算完成，`[-]` / `[/]`、`~~删除线~~` 算作废；
- 日期：`📅 2026-10-30`（截止）、`⏳`（计划）、`🛫`（开始），也支持 `due:: 2026-10-30`、`@due(2026-10-30)`；
- 优先级：`🔺/⏫`、`🔼`、`🔽`、`⏬`，或 `#p1`…`#p4`；
- 标签 `#tag`、双链 `[[note]]`、循环 `🔁 ...`。

## 目录结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半边：角色切换（local/hub/device）、中心与隧道、DSH 路由 |
| `hub.js` | 中心：设备表/快照存储/合并 Board/HTTP API |
| `sync.js` | 设备侧：join / push / fetchBoard |
| `settings.js` | `<dataDir>/settings.json` 读写与默认值 |
| `edit.js` | 行内写回：作废/启用/删除 Markdown 的一行（原子写、路径校验） |
| `scan.js` | 纯数据层：Markdown + DSH 解析、聚合、统计 |
| `client.js` | 浏览器半边：侧栏入口 + 整页看板（设备筛选/徽标/加入卡片） |
| `test/*.test.mjs` | `node --test` 单测 |
| `deploy/vps/` | 可选 VPS 中转的部署物 |

## 开发

```powershell
node --check index.js
node --check hub.js
node --check sync.js
node --check settings.js
node --check scan.js
node --check client.js
node --check edit.js
node --test test/scan.test.mjs
node --test test/hub.test.mjs
node --test test/edit.test.mjs
```

接口与数据形状见 [CONTRACT.md](CONTRACT.md)（v1）、[CONTRACT-V2.md](CONTRACT-V2.md)（多设备）与 [CONTRACT-V3.md](CONTRACT-V3.md)（行内操作）。
