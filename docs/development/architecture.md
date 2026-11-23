# 项目结构与执行入口

## 服务边界

Seedance 是 Node.js 服务。Express 接收并记录任务，Puppeteer 控制已登录的 Chrome，在 Dramart 中提交生成和查询结果。服务把任务状态、生成地址和调试信息写入本地 JSON。生成和素材存储由 Dramart 及其返回的上传、媒体地址提供。

当前仓库交付物是 Node.js 源码和 npm 锁文件，可通过 npm 脚本启动。当前版本没有独立客户端页面、静态文件路由、数据库、外部队列、定时生成任务或随仓库交付的部署流水线。Chrome 到期轮换、待命页登出检查、认证等待、生成轮询和状态面板计时是进程运行期间的定时行为。早期 Git 历史里的 Python 服务、静态页面、代理服务、便携 Node 和调试脚本已从当前版本移除。健康响应中的 `seedance-python-task-server` 是保留的兼容值。

## 代码地图

| 文件 | 职责 |
| --- | --- |
| [package.json](../../package.json) / [package-lock.json](../../package-lock.json) | npm 入口、Node 版本要求与依赖锁定。 |
| [task-server.js](../../nodejs/task-server.js) | 应用构造、启动恢复、认证、任务校验、持久化、派发和查询。 |
| [chrome-runtime.js](../../nodejs/chrome-runtime.js) | 查找并启动可见的本机 Chrome，用活动任务计数避免到期轮换中断任务。 |
| [dramart-team.js](../../nodejs/dramart-team.js) / [dramart-style.js](../../nodejs/dramart-style.js) | 当前团队识别、风格分页发现和选择。 |
| [image-session.js](../../nodejs/image-session.js) | 当日共享项目、常驻 Canvas、图片上传、提交、轮询及会话恢复。 |
| [canvas-video-session.js](../../nodejs/canvas-video-session.js) | 复用常驻 Canvas，处理素材传输、视频资源、视频任务提交和轮询。 |
| [image-task-status-panel.js](../../nodejs/image-task-status-panel.js) | 注入 Canvas 的共享进度面板，展示生图和 Canvas 视频阶段、耗时及结果。 |
| [video-preparation-scheduler.js](../../nodejs/video-preparation-scheduler.js) | 项目视频在内存中的先来先准备队列，管理准备位置和阻塞。 |
| [video-child-runner.js](../../nodejs/video-child-runner.js) | 监视项目视频子进程、解析 `TASK_STARTED`、处理超时、退出确认和结束结果。 |
| [prepare-video-workflow.js](../../nodejs/prepare-video-workflow.js) | 项目和分镜准备、网页控件操作、上传校验、生成与结果查询。 |
| [video-temp-images.js](../../nodejs/video-temp-images.js) | 项目视频的参考图解码、下载、任务目录隔离和启动时残留清理。 |
| `nodejs/*.test.js` | 对应模块的 Node 原生测试，可按 [验证指南](local-verification.md) 运行。 |

## 从请求到结果

1. `startTaskServer()` 等待任务文件夹初始化和遗留任务检查，然后监听 HTTP 并在后台预加载共享 Canvas。
2. `POST /api/ask` 经 Express JSON 解析、请求转换、动作选择和参数校验后，写入 `requests` 与 `running`。通常随即返回本地任务 ID。
3. 后台执行拿到 Chrome 运行时租约，也就是活动任务计数中的一个名额，再等待 Dramart 登录。生图和 Canvas 视频直接进入各自会话。项目视频先进入准备队列，由父进程启动带页面标记的独立子进程。
4. 处理器先写 `results`，再尽力删除对应 `running` 文件。查询优先读终态结果。客户端查询、服务内部轮询 Dramart 和浏览器状态面板各有自己的用途和数据。

| 动作 | 执行入口 | 隔离和查询依据 |
| --- | --- | --- |
| `generate_image` | `createImageTaskRunner` → `imageSession.runTask` | 共享页面，按任务分开上传和创建资源，按 `ResourceId` 查询。 |
| `generate_video` | `createCanvasVideoTaskRunner` → `canvasVideoSession.runTask` | 共享页面，按任务创建视频资源，按 Dramart 的 `TaskIds` 查询。 |
| `generate_video_project` | 调度器 → `runDramartTask` → `runVideoChild` → `prepare-video-workflow.js` | 每个任务使用带标记的页面及自己的集和分镜。父进程持久化 `TASK_STARTED` 中的上下文后，下一项可开始准备。结果按 `ShotId` 查询。 |

## 命令行入口

| 命令 | 用途 |
| --- | --- |
| `npm run start:node-task` | 启动 `node nodejs/task-server.js`，对外提供 [4 条 HTTP 路由](http-route-reference.md)。 |
| `npm test` | 运行 `package.json` 中列出的 11 个测试文件。 |
| `node nodejs/prepare-video-workflow.js --json=请求文件 --submit` | 项目视频内部执行入口。通常由服务调用。单独调用时需要可用的 `BROWSER_URL` 和已经登录的 Chrome，详见 [项目分镜视频](../media-generation/project-video.md#单独排查子进程)。 |

详细的 [运行配置和数据位置](../operations/runtime-and-data.md) 与 [媒体生成流程](../media-generation/index.md) 可用于继续定位各环节。
