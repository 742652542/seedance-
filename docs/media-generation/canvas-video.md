# Canvas 视频

使用常驻 Canvas 生成视频时，调用 [任务 API](../task-api.md) 的 `POST /api/ask`，传 `action: "generate_video"`。前置条件是已登录的 Dramart、成功初始化的共享 Canvas、当前团队可用的视频模型，以及可访问的参考素材。

## 选择模式和素材

| 模式 | 请求用法 |
| --- | --- |
| `reference_frame`，全能参考 | 默认模式。可仅传提示词，也可以带图、带视频，或把图片和视频混用。 |
| `head_tail_frame`，首尾帧 | 传 1 至 2 张图片。第一张为首帧，第二张为尾帧。该模式不接收参考视频。 |

1. 选择 [Canvas 视频模型](../task-api.md#34-支持的视频模型)，填写非空提示词和所需的比例、时长、分辨率及输出格式。模型可用的实际参数组合由 Dramart 决定。
2. 普通素材可用 URL、Data URL、Base64 或服务机器上的本地路径。已在当前团队可用的素材可传 [已有引用对象](../task-api.md#35-canvas-视频参考素材与生成模式)。图片和视频都提供 `Key` 和 URL。视频优先附上已有的 `ResourceId`，图片有资产 ID 时可一并传 `ArkAssetId`。
3. 保存受理返回的任务 ID。Canvas 视频的 `queue_position` 固定为 0。查询 `/api/result/<task_id>`，等待终态且 `result.status: success`，核对请求参数和视频地址。通过 `/api/files/<task_id>` 也可取统一格式的链接，再确认链接可播放或下载。
4. 离线验证运行 `node --test nodejs/canvas-video-session.test.js nodejs/task-server.test.js`。真实验收可先用全能参考纯文字请求验证生成，再用图片或视频覆盖实际需要的传输路径，或用两张图验证首尾帧顺序。

## 执行与排查

- [Canvas 视频会话](../../nodejs/canvas-video-session.js) 复用生图准备好的登录页面和当天项目。普通素材下载或复制到任务临时目录，经上传及资源登记后组成上游引用。远程素材流式写盘，上传也走流。远程和本地文件以及 Data URL 分支默认大小限制为图片 50 MiB、视频 500 MiB。限流覆盖整个共享视频会话，默认同时处理两个素材。
- 每个任务创建自己的输出 `ResourceId`，提交 `/tasks/video_gen/create` 后使用返回的 `TaskIds` 查询。阶段和结果也显示在 [共享状态面板](image-generation.md#浏览器进度)。页面异常时，会话尝试恢复查询，已提交任务使用原任务 ID。
- 若一直卡在素材阶段，依次检查输入有效性、下载大小限制、上游素材登记错误和 [传输配置](../operations/runtime-and-data.md#环境变量)。没有返回 `TaskIds` 或生成轮询超时会作为任务失败返回。项目、集或分镜相关排查见 [项目分镜视频](project-video.md)。
