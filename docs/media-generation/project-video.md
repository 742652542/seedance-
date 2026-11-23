# 项目分镜视频

需要在 Dramart 项目里新建任务专用的集和分镜，使用分镜网页流程生成时，调用 [任务 API](../task-api.md) 的 `POST /api/ask`，显式传 `action: "generate_video_project"`。前置条件是本机 Chrome、当前团队项目权限、有效的风格和该流程支持的模型。

## 提交与验收

1. 传非空提示词。模型可用 `Doubao-Seedance-2.5`、`Doubao-Seedance-2-0`、`Doubao-Seedance-2.0-fast`、`Doubao-Seedance-2.0-mini`，使用这些页面名称。准备需要的比例、时长、清晰度、格式及参考图。
2. 图片角色使用 `reference_image`、`first_frame`、`last_frame`。包含首帧或尾帧角色时选择分镜的图生视频流程。需要参考视频时使用 [Canvas 视频](canvas-video.md)，项目分镜脚本消费的是参考图。
3. 提交后保留任务 ID。处于准备或等待准备时可从结果接口看到队列位置。进入处理后利用结果中的 `EpisodeId`、`ShotId` 或调试字段定位对应上游分镜。收到 `completed` 后检查内层状态和视频链接。
4. 真实验收核对选中的项目、专属集和默认分镜，确认提示词、时长、清晰度、格式和参考图已经保存，最后核对实际生成媒体。离线回归入口见 [本地运行与验证](../development/local-verification.md#自动化验证)。

下面的请求可作为项目分镜流程的最小验收模板。若要验证参考图上传，增加 `images`，使用 [项目视频图片角色](../task-api.md#351-旧项目视频图片角色) 和真实可访问的测试素材。HTTP 提交会执行真实生成。

```json
{
  "action": "generate_video_project",
  "model": "Doubao-Seedance-2.0-fast",
  "prompt": "固定镜头，拍摄桌面上的蓝色陶瓷杯",
  "ratio": "16:9",
  "resolution": "720p",
  "duration": 5,
  "output_format": "mp4",
  "wait_for_completion": false
}
```

## 准备、生成和恢复

1. [项目脚本](../../nodejs/prepare-video-workflow.js) 分页查找同团队、符合项目名称和配置的项目。默认风格项目名为 `日期-比例`，自定义风格增加稳定后缀。日期可由 `PROJECT_DATE` 覆盖，默认用子进程本地日期。项目不存在时创建并确认资源。
2. 脚本读取集列表，以最近的集为锚点新建一个集，再等待系统分配该集默认分镜。父服务为当前任务创建带标记的独立页面，子进程复用该页面执行。
3. 子进程输出 `TASK_STARTED`。父进程收到有效项目、集和分镜信息后更新运行记录并释放准备队列。参考图准备、表单填写和生成可与下一项并行。正在准备的任务位置为 0，等待任务从 1 起。
4. 子进程设置分镜参考模式和模型，修改视频参数，等待参考图写回分镜，填写提示词并核对保存结果。生成后按 `ShotId` 查询并通过 `RESULT_JSON` 传回父进程。
5. 准备超时或准备标记有问题时，[子进程监视器](../../nodejs/video-child-runner.js) 尝试结束子进程。准备上下文尚未持久化、且父服务无法确认子进程退出时，[调度器](../../nodejs/video-preparation-scheduler.js) 会阻塞，防止后续任务进入同一个准备区。已持久化后退出不明不会重新占住队列。需要重启时按 [恢复与交接](../operations/operations-checklist.md#重启维护与交接) 核对现场。

## 单独排查子进程

通常从服务发起任务。需要单独定位分镜页面、上传或填写时，可在可写的测试工作副本用已有认证 Chrome 调试地址运行子进程。先将上面的 JSON 保存为 UTF-8 的 `request.json`，确认登录团队和日期，再在 PowerShell 设置 `BROWSER_URL` 为该 Chrome 的实际地址并执行：

```powershell
node nodejs/prepare-video-workflow.js --json=./request.json
```

请求输入优先级为 `--data=JSON`、`SEEDANCE_REQUEST_JSON`、`--json=文件`。允许脚本按指定团队和风格访问项目。默认会创建或复用项目、新建集、填写分镜并核对保存结果。追加 `--submit` 后点击生成并等待结果。执行结束看 `RESULT_JSON` 及页面中的分镜数据。直接执行子进程通过标准输出报告结果，服务的任务目录和准备队列不会参与。
