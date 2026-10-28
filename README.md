# leo-status 1.0.0

DSH 的 Leo 待办看板。针对 DSH 0.2.1-rc.3；阿源已拆分为独立 `ayuan` 2.0.0 插件。

## 使用

1. 打开「待办 → 数据源」，接入笔记目录或使用自动发现，选择复选框、标签、frontmatter、TODO 等规则。
2. Obsidian 待办自动进入看板；其它笔记和真实用户会话中的候选需要在待办页接受后才成为正式待办。AI 工作计划不作为个人承诺。
3. 可完成、恢复、作废和删除事项。本机笔记事项的明确操作会写回对应行；扫描本身不写笔记。建议审核仍属于待办页。
4. local / hub / device 模式支持设备同步和共享看板。密码与 token 留在数据目录，不包含在发行包中。

## 与阿源的边界

- 本包保留扫描、建议审核、看板 UI、中心服务、设备同步与 `leo_status` 工具。
- `ayuan` 提供浮框、可拖气泡、真实 Agent 会话、记忆、提醒和来源上下文；需要助手时请同时安装两包。
- 两包不互相 import 代码，通过 `leoBoard` / `leoHub` 服务通信。中心 `/api/yuan/*` 路由由阿源注册。
- 仅装本包时看板可用；仅装阿源时使用本地记忆，待办为空。
- `1.0.0` 不再提供旧版内置阿源。旧数据不自动迁移，也不删除。历史 0.x 功能与升级说明见 `HISTORY-0.x.md`，其中阿源相关内容不代表本包 1.0.0 的能力。

## 服务契约

`leoBoard`: `list(options?)`、`stats()`、`propose(text)`、`action(body)`。

`leoHub`: `mode()`、`isHub()`、`isDevice()`、`baseUrl()`、`remoteCall(route, body)`、`registerRoute(prefix, handler)`。扩展路由在中心鉴权之后执行，返回是否已处理。

## 安装和数据

使用 DSH 插件管理安装。每次只进行一个变更并等待应用结果，不要在安装卡住时重复触发热加载。

默认 Windows 数据目录 `C:\data\leo-status`；其他平台 `~/.local/share/leo-status`。覆盖顺序为插件 `dataDir`、`LEO_STATUS_DATA`、默认目录。`settings.json` 管理数据源与中心/设备设置。

已有服务器转发配置保持不变。升级到拆分版本后，中心和客户端若使用阿源，都需安装 `ayuan`。没有验证的跨版本设备组合不承诺兼容。

## 验证

```sh
node --check index.js
node --check client.js
node --test "test/*.test.mjs"
```

118 项测试覆盖扫描、来源确认、笔记回写、建议状态、HTTP 同步和路由。测试使用临时数据，不修改真实笔记。当前拆分契约见 `CONTRACT.md`；旧版契约文档保留供历史参考。
