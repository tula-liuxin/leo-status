# leo-status 2 服务契约

## 唯一内容树
笔记 draft / committed 为版本化 Tiptap JSON。taskItem.attrs.id 稳定且跨笔记唯一；正式待办由 committed 派生，不能独立维护正文。note.rev 每次写入递增。save/commit/trash 的旧 rev 返回 409；check 同时更新 draft 和 committed，旧草稿提交必须先解决冲突。完成父项不级联。

## 接口
同源 `/leo-status/api/notes-v1`，中心 `/api/notes-v1`：
GET state、note?id、timeline?kind&date&basis&depth；POST save、commit、check、trash、title、generate；POST attachment?name 原始字节；GET/HEAD attachment?id 支持单段 Range。

同源接口要求页 token 或宿主连接鉴权，拒绝 cross-site 请求；中心沿用 Bearer 密码。附件最多 100 MiB，独立完成上传后可提交引用，不接受外部图片地址；服务器验证附件存在。

## Agent 服务
leoNotes: get/list/save/timeline/check/trash/title；正式 commit 不暴露为 agent 工具。
leo_status: list/propose/done/undone；propose 返回待确认笔记草稿。
leo_notes: list/get/save/timeline。
leoBoard: list/stats/propose/action(done|undone)。旧来源 create/edit/delete 路由已停用，避免写回 Obsidian。
leoHub: mode/isHub/isDevice/baseUrl/remoteCall/registerRoute 保留；阿源路由注册与幂等释放不变。

## 停用项
无旧扫描器、会话扫描、旧快照推送或自动导入；旧 `/api/push` 返回 410。设置原件保留，但其 Obsidian 配置不再生效。

## 迁移与回退
notes-v1 与旧版数据相互独立。回退时只恢复插件备份，保留 notes-v1；不要把旧数据覆盖到新数据库，也不要删除 Obsidian 原件。插件只在会话空闲时热加载，不重启宿主。

## 2.0 增补
- Note view新增firstSubmittedAt；taskItem.attrs保留completedAt与completionEventId，board投影新增startedAt/completedAt。
- 首次提交时间由最早versions.at迁移，新笔记首次commit固定；笔记重新提交与后来新增task不重置。
- save只在明确的checkbox状态/事件变化时更新完成时间；旧completed未知保持null。check接受occurredAt并更新draft/committed。
- GET /todos: kind/year|month|week|day、date、basis/start|completed、q、hideCompleted，返回groups与matchCount；groups含key/label/unknown/todos/matchCount，祖先contextOnly不计匹配数。
- POST /trash/purge: {items:[{id,rev}]}，验证仍在回收站且版本一致后原子清理；成功返回deletedIds、cleanupPending、cleanupTasks。无agent永久删除工具。
- attachment_gc仅包含本次明确永久删除产生的候选文件；清理前再次检查所有正文和版本引用。模型任务generation避免迟到结果写回已删除内容。
