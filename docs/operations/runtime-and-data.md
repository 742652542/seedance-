# 运行依赖与任务数据

## 进程、浏览器和外部服务

- Node.js 20 或更新版本。npm 安装 [package-lock.json](../../package-lock.json) 锁定的 Express 和 Puppeteer 依赖。使用 `puppeteer-core`，Chrome 由运行环境提供。
- [Chrome 运行时](../../nodejs/chrome-runtime.js) 依次检查 `CHROME_PATH`、`PROGRAMFILES`、`PROGRAMFILES(X86)`、`LOCALAPPDATA` 下的 Google Chrome 安装路径。服务管理的 Chrome 以可见窗口启动，使用项目根目录下的用户数据目录和 `1920 × 920` 视口。启动超时为 120 秒。运行 24 小时后在活动任务计数为零时轮换。正在等待登录、生成或清理的任务可能延后轮换。
- [服务](../../nodejs/task-server.js) 的待命页面负责登录和项目列表。每次认证会检查项目列表页面和上游项目列表 HTTP 响应。多个任务共享一次认证等待。共享 Canvas 在监听后尝试预加载，项目视频由独立子进程复用已认证浏览器。
- Dramart 工作台使用 `https://work.xiaomaomi.cn`，页面同源请求承担账号、团队、风格、项目、素材和生成操作。Node 还需访问调用方提供的素材 URL 和上游返回的 TOS 上传地址。TOS 是上游提供的对象存储，用于上传素材。调用方需能访问结果中的媒体域名。具体存储和媒体主机以响应为准。
- 有效的 `BROWSER_URL` 可用于待命页面连接和传给项目视频子进程。正常 HTTP 任务仍会先取得本机 Chrome 运行时的租约，因此运行机需要可用的本机 Chrome。待命连接不可用时服务可回退到本机 Chrome，单独运行的项目视频脚本则要求传入可用的浏览器地址。

## 登录、团队与风格

1. 启动前在进程环境设置 `DRAMART_USERNAME` 和 `DRAMART_PASSWORD`，或在项目根目录使用 UTF-8 的 `dramart-auth.json`，结构见 [README](../../README.md#账号配置)。登录时会先读取存在的配置文件，再按字段用非空环境变量覆盖。已有配置文件即使会被覆盖，也应是合法 JSON。
2. 服务优先检查浏览器现有会话。缺少完整账号密码时可在可见 Chrome 完成手动登录。任务在认证通过前等待，当前没有认证等待总超时。认证通过后沿用解析到的团队。
3. `TEAM_ID` 可指定团队。未配置时，[团队解析](../../nodejs/dramart-team.js) 调用 `DescribeUser`，优先选活动团队，否则使用第一个团队。无可用团队时报错。
4. 共享 Canvas 初始化先用 `DRAMART_VISUAL_PROMPT_ID`。未设时，[风格解析](../../nodejs/dramart-style.js) 分页读取可见自定义风格，唯一则使用，零个则用 `realistic_modern_urban`，多个时报错并列出候选。生图和 Canvas 视频的 `style_id` / `styleId` 在共享会话准备好后覆盖当次生成风格。若共享会话因风格歧义无法初始化，先修正服务级配置。项目分镜流程则在建项目之前决定风格，优先用请求值，其次用服务设置，最后按团队自动解析。

服务监听后每 180 秒用待命页打开项目列表。确认跳转到 Dramart 登录页后，复用现有登录流程。已有账号和密码时会自动登录，任务发起的认证可以共用这次登录。确认登录恢复后，服务关闭旧的共享 Canvas，并按现有当日项目规则重开。检查、登录或重开仍在进行时会跳过下一个检查周期。分镜任务使用各自的独立页面。

## 环境变量

当前 npm 启动脚本直接运行 Node。进程读取环境变量和登录 JSON，项目没有自动加载 `.env` 的代码。环境变量在启动终端或所用的进程管理方式中设置。表内时间均为毫秒。

| 变量 | 默认值及用途 |
| --- | --- |
| `HOST` | `0.0.0.0`，监听地址。本机使用可设为 `127.0.0.1`。 |
| `PORT` | `9091`，HTTP 监听端口。 |
| `SEEDANCE_DEBUG` | 默认开启，值为 `0` 才关闭调试日志。 |
| `CHROME_PATH` | 无，覆盖 Chrome 可执行文件查找顺序。 |
| `BROWSER_URL` | 无，Chrome 调试 HTTP 或 WebSocket 地址。 |
| `DRAMART_USERNAME` / `DRAMART_PASSWORD` | 无，自动登录字段。 |
| `TEAM_ID` | 无，由已登录的账号自动识别。 |
| `DRAMART_VISUAL_PROMPT_ID` | 无，团队风格配置。 |
| `LOGIN_POLL_INTERVAL_MS` | `2000`，两次认证尝试间的等待时间。 |
| `GENERATION_TIMEOUT_MS` | `900000`，生图和项目视频的生成结果等待上限。 |
| `VIDEO_GENERATION_TIMEOUT_MS` | `1800000`，Canvas 视频的结果等待上限。 |
| `POLL_INTERVAL_MS` | `3000`，生图和 Canvas 视频的生成轮询间隔。项目视频轮询在子进程内固定为 3000。 |
| `MEDIA_TRANSFER_CONCURRENCY` | `2`，整个 Canvas 视频会话的素材传输并发数。 |
| `MEDIA_TRANSFER_TIMEOUT_MS` | `900000`，Canvas 视频单素材下载和上传阶段各自的超时。 |
| `VIDEO_PREPARATION_TIMEOUT_MS` | `300000`，父进程等待项目视频子进程报出有效准备上下文的时间。 |
| `PROJECT_DATE` | 子进程本地日期，覆盖项目视频的项目日期。生图的项目日期使用上海时区。 |
| `IMAGE_UPLOAD_TIMEOUT_MS` | `120000`，项目视频等待参考图保存确认的时间。 |
| `SUBMIT_DELAY_MS` | `3000`，项目视频点击生成前的停留时间。 |
| `SEEDANCE_TASK_ID` / `SEEDANCE_TASK_PAGE_MARKER` | 父进程为项目视频子进程设置的本地任务 ID 和 Chrome 页标记。 |
| `SEEDANCE_REQUEST_JSON` | 子进程的可选 JSON 输入。优先级高于 `--json`，部署服务时应避免遗留这个变量覆盖逐任务请求。 |

## 数据、日志与清理

| 路径 | 内容与寿命 |
| --- | --- |
| `seedance_tasks/requests/<task_id>.json` | 规范化请求，可含提示词、路径、素材 URL 或内嵌输入。任务完成后保留，用于追踪和恢复排队项目视频。 |
| `seedance_tasks/running/<task_id>.json` | 原始任务状态和补充上下文。项目视频先写 `queued`，准备后更新为 `processing`。生图和 Canvas 视频直接写 `processing`。 |
| `seedance_tasks/results/<task_id>.json` | 终态、调试上下文和媒体链接或上游响应。成功或失败都会尝试写入。查询优先读这里。服务当前无结果或请求自动到期清理。 |
| `.chrome-user-data/` | 本机 Chrome 档案，含登录状态。由服务管理的 Chrome 复用。 |
| `dramart-auth.json` | 可选账号密码文件。由运行环境单独保存。 |
| `nodejs/tmp-upload-images/` | 生图和项目视频的任务级临时目录根路径。正常收尾各自清理。启动时按合法任务目录名和保留的 `running` 文件清理遗留目录。 |
| `nodejs/tmp-canvas-video/` | Canvas 视频的任务级临时目录根路径。进入生成流程后通常由会话的 `finally` 清理，启动清理范围不覆盖该目录。 |

任务 JSON 先写同目录临时文件，刷新并关闭后重命名到正式文件，再尝试移除运行记录。三类文件没有跨文件事务。异常时可同时留下运行和结果记录，查询会以结果为准。服务没有数据库、共享锁、多实例协调或仓库定义的备份恢复命令。多个实例使用同一工作副本的数据目录时会共享文件和 Chrome 档案。

服务输出到标准输出和标准错误。项目视频的子进程输出由父进程读取处理。任务数据、Chrome 档案、登录配置、日志和临时素材在 [.gitignore](../../.gitignore) 中排除。视频文件和生图输出通过上游媒体 URL 提供，本地结果文件主要保存状态及返回信息。

## 服务重启如何处理未完成任务

启动会扫描 `running`。异常文件名、JSON 无法解析或记录内的 `task_id` 与文件名不一致会阻止服务启动。对能够识别的两个视频动作，行为如下。

| 数据状态 | 启动行为 |
| --- | --- |
| 有对应结果 | 读取并确认结果 JSON 可解析，随后尝试清理该运行记录。 |
| 视频 `processing` 且没有结果 | 写入重启中断的错误结果，尝试清理运行记录。任务需要先核对上游实际结果，再决定是否重新提交。 |
| 项目视频 `queued` | 读取请求文件，按创建时间和任务 ID 顺序重新排队。缺失请求文件或无法读出 JSON 会阻止启动。 |
| 历史 `generate_video` 且状态为 `queued` | 作为旧项目视频恢复。 |
| 生图运行记录 | 通过文件名与 ID 检查后跳过，保留现有记录。没有结果的遗留生图记录仍可能在查询时返回 `processing`。 |

维护前核对 [运行检查清单](operations-checklist.md#重启维护与交接)。不要用客户端查询结果的 `processing` 单独判断任务是否仍在上游运行。
