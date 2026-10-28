# leo-status 1.0.0 / ayuan 2.0.0 拆分契约

- leo-status：看板、扫描、来源筛选、建议审核、中心与设备同步、leo_status 工具。
- ayuan：浮框/气泡、Agent 会话、记忆、提醒、状态、来源上下文、历史。
- 两包不得互相 import。leo-status 提供 leoBoard、leoHub；ayuan 提供 ayuanRuntime、ayuanMemory、ayuanStatus、ayuanContext、ayuanAgent。
- 阿源所有插件行 ID 必须使用 ayuan 前缀，不可覆盖宿主 tools 等通用行。旧交接示例中的 memory/status/context/tools 行 ID 已废弃。
- 本地阿源 HTTP 为 /ayuan/api/*；中心为 /api/yuan/*，经 leoHub.registerRoute 挂载。建议审核留在看板。
- 数据目录各自独立：C:\data\leo-status 与 C:\data\ayuan。旧数据不迁移、不删除。
- 上下文：页面捕获快照、来源会话、同目录其它主会话标题；来源有效期十分钟，详细内容需显式查询，不读取同目录全部正文。
- 历史命名：首条直接用户消息后设置 阿源 · <话题>，不在创建空会话时强制统一命名。
- 普通会话不应获得阿源身份。停用阿源不得替换核心 AgentLoop 或 ToolRuntime。
- 原 CONTRACT-LEGACY-V1.md 和 CONTRACT-V*.md 为历史材料，不再代表当前文件分工或只读限制。

- leoHub.registerRoute(prefix, handler) 返回幂等卸载函数；消费方必须将注册绑定到注入作用域的 effect，服务重建或停用时解除。
