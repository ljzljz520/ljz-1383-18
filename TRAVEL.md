# 旅行影集叙事编辑器：设计与验收说明

这是在原个人主页基础上新增的独立应用，入口：

- 编辑器：`/travel/editor.html`
- 分享页：`/travel/share.html`
- 无依赖后台：`api-server.js`
- 纯数据内核：`js/travel/kernel.js`
- 本地持久化与 API 适配：`js/travel/repository.js`
- 可恢复媒体处理：`js/travel/media.js`
- 受控缓存：`travel/sw.js`

## 运行

```bash
node api-server.js
# 打开 http://localhost:8787/travel/editor.html
```

若直接用静态服务器打开，客户端会退化为 localStorage + IndexedDB 的 Mock API，仍可演示离线和跨标签页；正式持久化使用 Node API。

运行测试：

```bash
npm install
npm test
```

## 数据模型与稳定引用

文档是一个规范化图结构，而不是章节内嵌大 JSON：

- `chapters`：章节，位置存在 `pos`。
- `blocks`：故事段落、照片块、地图块；通过 `photoId`、`nodeId` 引用实体。
- `photos`：图注、人物区域、EXIF、原片 ID、衍生物 ID 和媒体版本。
- `nodes`：地图节点、精确坐标与 `removed` 状态。
- `people` / `consents`：同行人资料与许可版本。
- `shares` / `snapshots` / `generations`：分享策略、字段白名单快照和发布代次。

章节拖动只改 `chapter.pos`；块拖动只改 `block.pos` / `block.chapterId`，不复制照片或图注。位置用可无限插入的分数位字符串，支持在两个相邻章节之间持续插入，避免数组下标在并发重排中错位。

## 离线编辑与冲突合并

所有编辑都形成带 `id/clientId/ts` 的操作日志。同步时提交：

```json
{ "baseDoc": "...", "baseRev": 12, "ops": ["..."] }
```

服务端用 `rebase(baseDoc, remoteOps, localOps)` 做三路合并：

- 字段更新采用 HLC/时间戳 LWW。
- 两个标签页把同一章节拖到同一位置时，后操作自动插入相邻分数位；冲突面板解释“只调整位置，引用不变”。
- 引用的照片/节点已经删除时，不复活实体，而是列出 `DELETED_REFERENCE`。
- 离线稿含撤回信息时，服务端不持久原文；本地安全操作改为遮蔽文本，并返回 `WITHDRAWN_INFO_REUPLOAD` 冲突说明。

## 两种分享方式

### 全章共享 `mode: fullChapter`

- 选中章节的当前结构会整体进入发布代次。
- 字段可见范围仍独立生效：姓名、联系方式、精确位置分别控制。
- 新增段落会随当前章节结构发布，但不会突破字段范围。

### 白名单快照 `mode: snapshot`

- `unitIds` 冻结明确选中的段落、照片块和地图块。
- 后续新增段落不会隐式进入该分享。
- 快照保存投影后的 `chapters/blocks/photos/nodes/index/contentHash`。
- 联系方式默认关闭；精确位置关闭时坐标降低为约 10 公里区域并标记 `gpsStripped`。
- 姓名、联系方式和精确位置是三个独立字段，不捆绑成单一“公开/私密”。

## 许可撤回的级联范围

撤回不是只修改当前页面，而是生成新发布代次并级联：

1. `consents[personId]` 版本增加，状态为 `withdrawn`。
2. 找出受影响的照片、文本块、照片块、所有活跃快照和索引。
3. 照片 `mediaVersion + 1`，生成新的不可变衍生物 ID，例如 `ph_harbor.v1.blur`，并排入媒体任务。
4. 文本在快照投影和离线重传清洗中替换姓名、邮箱、电话。
5. 所有活跃分享在新代次重新生成快照、索引和 `contentHash`。
6. 受控副本标记 `purgeRequired`；重连 check-in 后删除旧 IndexedDB 衍生物并让 Service Worker 删除旧分享缓存。
7. 无法接触的外部下载、转发、JPEG/PDF 副本保留为 `kind: external/state: unreachable`，UI 如实列为“不可撤回范围”。

## 媒体处理中断

媒体任务包含：

```json
{
  "id": "job_ph_v1",
  "photoId": "ph_x",
  "targetDerivativeId": "ph_x.v1.blur",
  "state": "interrupted",
  "progress": 64,
  "attempts": 3
}
```

处理循环逐步持久 `progress/state`。中断后恢复仍写入同一个 `targetDerivativeId`，避免产生半成品孤儿图。原片单独存为 `.original`；衍生物不含 EXIF，撤回时对同框区域重新模糊并覆盖为新版本引用。

## 旧链接与同一发布代次

访客页必须同时满足：

- `share.generationId === doc.activeGenerationId`
- `snapshot.generationId === activeGenerationId`
- 地图引用节点未删除

否则显示墓碑，不用旧缓存正文兜底。撤下节点时，相关地图块从新快照移除，摘要中的坐标和节点名经投影清洗，索引也只引用新快照内的实体。

Service Worker 对分享 HTML 使用 network-first；离线无法验证代次时返回不含私人信息的中立占位页。撤回后编辑器向 SW 发送 `PURGE_SHARES`，已打开的访客标签页也会收到清理消息。

## 页面内验收按钮

1. **离线写已撤信息并重连**：先离线补入姓名/联系方式，同时后台撤回许可；恢复联网后可见服务端拒绝原文和安全改写。
2. **模拟两个标签页同时重排**：第二个持久客户端先提交移动，主客户端再移动到同一点，合并器自动选择相邻位置。
3. **媒体处理中断后继续**：任务保留百分比检查点，恢复后继续同一衍生物。
4. **打开已缓存旧分享链接**：请求旧代次，分享页显示墓碑而非旧正文。
