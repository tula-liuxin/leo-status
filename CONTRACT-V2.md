# leo-status v2 · 多设备 + 中心 + 中转 契约

> v1（单机只读 todo 看板）已完成并安装。v2 目标：
> **任何装了本插件的设备都能加入中心**；中心是本机（保存数据）；设备以 `deviceId/name` 区分；
> 简单密码认证（默认 `<中心密码>`）；VPS（`ssh sh`）只做中转，不存 todo。
>
> 关键决策（用户已确认）：A 合并 todo；A 本机关机远端不需要看旧数据；A 新建独立 relay；A 发布到 GitHub；A 目录 `C:\data\leo-status\` + `/opt/leo-status/`。

## 1. 总体拓扑

```
设备 A（本机=hub）                       VPS `sh` (<VPS_IP>)               设备 B/C...
┌────────────────────┐    ssh -R 反向隧道   ┌──────────────────────────┐   HTTPS   ┌──────────────┐
│ DSH + leo-status   │  18899→127.0.0.1:8790│ Caddy(dsh.agencyarche.com)│──────────▶│ DSH + leo-   │
│  · 本地扫描         │─────────────────────▶│  /leo-status/* →         │           │ status(device)│
│  · hub HTTP :8790  │                      │  172.18.0.1:18888        │           │  · 本地扫描   │
│  · 数据 C:\data\…   │                      │ forward.py → 127.0.0.1:  │           │  · 上报/拉取  │
└────────────────────┘                      │   18899（隧道口）          │           └──────────────┘
                                            └──────────────────────────┘
```

- 设备 → VPS：`https://dsh.agencyarche.com/leo-status/api/*`（Caddy 去掉 `/leo-status` 前缀后转发）。
- VPS → 本机：Caddy → 宿主 `172.18.0.1:18888`（python 转发器）→ `127.0.0.1:18899`（SSH 反向隧道）→ 本机 `127.0.0.1:8790`（hub HTTP server，只绑 loopback）。
- 本机关机时链路断开，远端设备显示本地缓存 + 离线提示（VPS 不缓存 todo）。
- 安全：密码 `Bearer` 认证走 HTTPS；hub 端口只绑 loopback；VPS 转发器只绑 docker 网关地址，不对外暴露。

## 2. 数据目录与设置

**dataDir 解析顺序**：row config `dataDir` → 环境变量 `LEO_STATUS_DATA` → Windows `%USERPROFILE%\Documents\leo-status` / 其他 `~/.local/share/leo-status`。
本机 profile patch 里显式设 `dataDir: 'C:\data\leo-status'`。

`<dataDir>/settings.json`（**不进 git**，明文密码；UI“加入中心”会自动写它）：

```json
{
  "mode": "hub",                          // "local" | "hub" | "device"
  "deviceName": "leo",
  "markdownRoots": [{ "id": "obsidian-main", "label": "Obsidian 主库", "path": "C:\\Users\\me\\Desktop\\my_obsidian" }],
  "includeDshTodos": true,
  "includeDshCompleted": false,
  "syncIntervalMs": 60000,
  "hub": {
    "port": 8790,
    "password": "<中心密码>",
    "tunnel": { "enabled": true, "sshTarget": "sh", "remotePort": 18899 }
  },
  "device": {
    "deviceId": "",                       // 首次 join 后写入
    "name": "leo-laptop",
    "hubUrl": "https://dsh.agencyarche.com/leo-status",
    "password": "<中心密码>"
  }
}
```

- 有效扫描配置 = `DEFAULTS` ← row config ← settings（settings 覆盖 `markdownRoots` / `includeDshTodos` / `includeDshCompleted`）。
- `mode` 缺省 `local`（保持 v1 行为；其他设备装完默认 local，页面出现“加入中心”卡片）。
- hub 模式缺 password → hub server 不启动，board 的 `hub.error` 说明原因。
- `<dataDir>/hub/devices.json`：`{ "version":1, "devices": { "<id>": {id,name,platform,pluginVersion,firstSeen,lastSeen,lastPush,remark} } }`
- `<dataDir>/hub/snapshots/<id>.json`：`{ deviceId, receivedAt, generatedAt, platform, pluginVersion, todos:[...], stats:{...}, sources:[...] }`
- 写盘：先写 `.tmp` 再 rename；读失败/坏 JSON 容错为空。

## 3. Host 模块边界

| 文件 | 所有者 | 职责 |
|---|---|---|
| `hub.js` | **hub-builder** | 纯 Node：设备表 + 快照存储 + 合并 board + HTTP handler（认证/限额/错误），无 DSH 依赖 |
| `test/hub.test.mjs` | **hub-builder** | `node:test`，temp dir fixture，用真实 http 请求测 handler |
| `sync.js` | **lead** | 设备侧：`joinHub` / `pushSnapshot` / `fetchBoard`（global fetch + Bearer） |
| `index.js` | **lead** | 设置加载、角色切换、hub server + SSH 隧道子进程、设备同步定时器、DSH 路由 |
| `client.js` | **client-ui** | 看板 UI：设备 chips/徽标、加入中心卡片、离线/中转状态 |
| `scan.js` | lead（小改） | DEFAULTS 去掉个人路径（`markdownRoots: []`），其余不动 |

`hub.js` 导出：

```js
export function createHubStore(dataDir)   // { load(), listDevices(), upsertDevice(d), getDevice(id),
                                          //   setRemark(id, remark), removeDevice(id),
                                          //   saveSnapshot(id, snap), getSnapshots(), prune(beforeMs) }
export function buildBoard(opts)          // 纯函数，见 §5；opts = { local, localDevice, store, now, syncIntervalMs, meta }
export function createHubHandler(opts)    // (req,res)=>Promise<void>；opts = { password, store, boardProvider, log }
export function startHubServer(opts)      // => Promise<{url, close}>；opts = { port:8790, handler, log }
```

## 4. Hub HTTP API（`/api/*`，设备经 Caddy 访问时去掉 `/leo-status` 前缀）

响应统一 `application/json; charset=utf-8`、`cache-control: no-store`。

| Method+Path | 认证 | Body | 成功响应 |
|---|---|---|---|
| GET `/api/health` | 否 | — | `{ok:true, version:2, role:'hub', time, devices:Number}` |
| POST `/api/join` | Bearer | `{deviceId?, name, platform, pluginVersion}` | `{ok:true, deviceId, hubTime, syncIntervalMs}` |
| POST `/api/push` | Bearer | `{deviceId, name, platform, pluginVersion, snapshot}` | `{ok:true, receivedAt, todoCount}` |
| GET `/api/board` | Bearer | — | Board（§5） |
| POST `/api/devices/:id/remark` | Bearer | `{remark}` | `{ok:true, device}` |
| DELETE `/api/devices/:id` | Bearer | — | `{ok:true}` |

规则：
- 认证：`authorization: Bearer <password>`，`timingSafeEqual`；缺失/错误 → 401 `{ok:false,error:'unauthorized'}`。
- `join`：`deviceId` 缺省由 hub 生成（`crypto.randomUUID()` 去掉横线或 24 hex）；已存在则更新 name/platform/lastSeen；`name` 截断 60 字符。
- `push`：`snapshot.todos` 必须是数组；body ≤ 4 MiB（超出 413）；每条 todo 只保留白名单字段（见 §5）；存快照并更新设备 lastSeen/lastPush。
- `board`：只读合并。
- 未知路径 404；方法不符 405；JSON 解析失败 400；异常 500（不泄露堆栈）。
- `GET /api/health` 不需要鉴权（给 Caddy/运维探活），不返回设备细节。

## 5. Board（v2，客户端吃这个）

```jsonc
{
  "ok": true,
  "version": 2,
  "generatedAt": "2026-10-27T09:00:00.000Z",
  "tookMs": 12,
  "mode": "hub",                    // hub | device | local
  "role": "hub",                    // 与 mode 相同
  "device": { "id": "local", "name": "leo", "platform": "win32" },
  "hub": { "connected": true, "lastSyncAt": null, "error": null,
           "relay": { "enabled": true, "state": "running", "error": null } },
  // relay.state ∈ running | starting | stopped | disabled；starting 表示隧道进程已拉起、尚未确认存活
  "devices": [
    { "id": "local", "name": "leo", "platform": "win32", "version": "0.2.0",
      "online": true, "lastSeen": "2026-10-27T09:00:00.000Z", "lastPush": null, "todoCount": 40, "local": true },
    { "id": "abc123", "name": "leo-laptop", "platform": "win32", "version": "0.2.0",
      "online": true, "lastSeen": "...", "lastPush": "...", "todoCount": 17, "local": false }
  ],
  "sources": [ /* 本机 v1 sources 原样，每项带 deviceId:"local" */ ],
  "todos": [
    { /* v1 todo 全部字段 */, "id": "local:md:obsidian-main:…:12",
      "deviceId": "local", "deviceName": "leo", "local": true }
  ],
  "stats": { "total": 57, "open": 50, "done": 4, "cancelled": 3, "overdue": 0, "dueToday": 0, "dueSoon": 0, "undated": 50 },
  "config": { "includeDshTodos": true, "markdownRootCount": 1, "syncIntervalMs": 60000 }
}
```

合并规则（`buildBoard`）：
- 本机 todo：`id = "local:" + todo.id`，`deviceId:"local"`，`deviceName = localDevice.name`。
- 远端 todo：`id = deviceId + ":" + todo.id`，`deviceId/deviceName` 取设备记录（remark 优先）；字段白名单同 v1（含 `cancelled`）。
- `sources` 只放本机 sources（加 `deviceId:"local"`）；远端只用 `devices[].todoCount` 表达。
- `online`：local 恒 true；远端 `now - lastSeen <= max(3*syncIntervalMs, 180000)`。
- `stats` 按合并后的 todos 重算（口径同 v1：open 排除 done/cancelled；cancelled 单独计数）。
- `devices` 本机排第一，其余按 `name` 本地化排序（`localeCompare('zh')`）。
- Board 在 device 模式下由 hub `/api/board` 返回；hub 不可达时由 index.js 生成 `mode:"device"` + `hub.connected:false` 的本机兜底 board（todos 只含本机，`device.id` 为本机 deviceId）。

## 6. 设备同步（index.js 行为）

- 激活时：读 settings；`mode==='device'` 且有 `hubUrl/password` → 立刻执行一次 `syncOnce()`，之后每 `syncIntervalMs` 一次（`ctx.timer`/setInterval + effect 清理）。
- `syncOnce()`：本地 `aggregate`（force=false 用 TTL 缓存；页面 `?refresh=1` 时 force=true）→ `joinHub`（幂等，新 deviceId 写回 settings）→ `pushSnapshot` → `fetchBoard` → 缓存为 `lastBoard`；失败保留旧 board 并置 `hub.connected=false`，记录 `hub.error`。
- `mode==='hub'`：启动 hub server（`127.0.0.1:hub.port`）；`hub.tunnel.enabled` 时 spawn：
  `ssh -N -T -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -R 127.0.0.1:<remotePort>:127.0.0.1:<port> <sshTarget>`
  进程退出后 5s 重试（指数退避到 60s）；状态写进 board 的 `hub.relay.state`（`running|stopped|disabled`）。插件卸载/禁用时 kill。
- `mode==='local'`：v1 行为（不连中心、不启 server）。
- DSH 路由（v1 已有 `/leo-status/api/todos`）：
  - `GET /leo-status/api/todos`：按 mode 返回 Board（local=本机快照；hub=合并；device=hub board 或兜底）。
  - `POST /leo-status/api/join`：仅 device 加入流程；body `{hubUrl, password, name, markdownRoot?}`；host 调 hub `/api/join` 校验 → 写 settings（mode=device、device.*、可选追加 markdownRoots）→ 启动同步 → 返回 `{ok:true, board}`；失败 `{ok:false,error}`。
  - `GET /leo-status/api/hub/status`：`{mode, hub:{connected,error,relay}, devices:Number}`，供 UI 显示。
  - 现有 DSH 鉴权保留（`connection.authorizeIndex`）。

## 7. 客户端 UI v2 增量（client.js）

在 v1 基础上增加：
1. **设备 chips 行**（`devices.length > 1` 时显示，位于来源 chips 上方）：`全部设备` + 本机 + 各远端设备；每个带在线点（在线绿 / 离线灰）和该设备 open 数；多选，空选=全部。
2. **行上设备徽标**：设备数 > 1 时，每行来源徽标旁显示 `本机` / 设备名（次要色、小号）；设备数 = 1 时不显示。
3. **header 状态**：`mode==='hub'` → `中心 · N 台设备`（N 含本机）；`mode==='device'` → `已连接中心` / `中心离线`；local 不显示。右侧刷新按钮旁。
4. **加入中心卡片**（`mode==='local'` 且有数据/或无数据都显示在 body 顶部）：标题「加入 leo-status 中心」+ 3 个输入（中心地址默认 `https://dsh.agencyarche.com/leo-status`、密码、本机名称默认 `props.device.name`）+ 可选「笔记目录」+ 提交按钮；POST `/leo-status/api/join`；成功刷新 board，失败显示错误。样式只用主题 token。
5. **离线横幅**（`mode==='device' && hub.connected!==true`）：`中心不可达，显示本机缓存` + `hub.error`（有的话）+ 最后同步时间。
6. 设备筛选与来源筛选、搜索、隐藏已完成可以叠加。
7. 兼容旧数据：`devices` 缺失时按单设备渲染（v1 行为）。

## 8. 部署与安装（lead + relay-ops）

- VPS `/opt/leo-status/`：`forward.py`（172.18.0.1:18888 → 127.0.0.1:18899）、`configure-edge.py`（幂等给 `dsh.agencyarche.com` 块插 `handle_path /leo-status/* { reverse_proxy 172.18.0.1:18888 }`，备份/validate/失败回滚）、systemd `leo-status-relay.service`、README。Caddy 改完 `docker restart co-align-v2-caddy-1`（先 `caddy validate`）。
- 本机：`ssh -R` 隧道由插件管理（无需手工）。
- GitHub：`tula-liuxin/leo-status` public；repo 内不含 settings/个人路径/密码；`cordis.patch.yml` 的 config 保持中性（`{}`），个人 `dataDir` 写在 profile patch。
- 其他设备：`plugin_manager install_bundle target="github:tula-liuxin/leo-status"` → 打开「待办」→ 填中心地址/密码/名称 → 加入。
