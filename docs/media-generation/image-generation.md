# 生图

需要给定提示词和至少一张参考图生成图片时，调用 [任务 API](../task-api.md) 的 `POST /api/ask`，显式设置 `action: "generate_image"`。服务依赖已登录的 Dramart 团队、可用风格、可访问的参考图和素材上传地址。

## 提交与验收

1. 准备一张服务端能读取的参考图。可使用 HTTP/HTTPS 地址、Data URL、Base64 或服务机器上的文件路径。远程参考图下载的默认上限是 50 MiB。
2. 至少填写 `prompt` 与 `images`。可传 `ratio`、`resolution`、`count` 和当次 `style_id`。需要指定模型时，按 [生图字段和模型](../task-api.md#37-生图请求字段) 核对 `model` 和对应名称。
3. 默认异步受理。保存顶层 `task_id`，查询 `GET /api/result/<task_id>`。生成成功时 `result.status` 为 `success`，所有返回的图片地址在 `result.data` 数组中。多张图的验收按数组逐张访问。统一媒体接口提供单个媒体地址。
4. 失败时查 `result.error`，并按任务 ID 看状态面板、服务日志和本地结果记录。离线运行 `node --test nodejs/image-session.test.js nodejs/image-task-status-panel.test.js nodejs/task-server.test.js`。

## 项目与任务如何执行

- [image-session.js](../../nodejs/image-session.js) 按上海日期 `YYYY-MM-DD` 分页查找当前团队同名项目。不存在才建 manual 项目，使用固定项目比例 `9:16`，确认资源后打开并保留 Canvas。同名项目复用条件以团队和实现中的项目检查为准。每次生图仍使用请求自己的比例。
- 共享项目风格在准备时确定，任务可覆盖当次生成的风格。初始化失败和风格选择见 [运行依赖与任务数据](../operations/runtime-and-data.md#登录团队与风格)。
- 参考图写入任务临时目录，经 TOS 上传后挂到项目图片资源。会话新建输出图片资源并提交生成，再以当前任务的 `ResourceId` 查结果。多个任务可共用 Canvas，同时独立上传和轮询。
- 页面关闭或浏览器断开时，共享会话可以重建。提交后出现可恢复的页面错误时，轮询用原资源继续。单个任务的普通业务错误不会关闭共享页面。服务重启与同一进程内的页面恢复行为见 [恢复说明](../operations/runtime-and-data.md#服务重启如何处理未完成任务)。

## 浏览器进度

[状态面板](../../nodejs/image-task-status-panel.js) 注入到常驻 Canvas，展示生图和 Canvas 视频的任务、阶段、耗时和近期终态。可见阶段包括准备会话、上传、创建资源、提交和生成。终态耗时冻结，成功渲染后默认保留 3 秒。页面重载或更换后，面板重新展示记录。面板渲染错误会记录日志，HTTP 查询及磁盘结果独立处理。
