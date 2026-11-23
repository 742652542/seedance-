# 本地运行与验证

适用于首次接手代码、修改任务行为，或复现本地与交付环境的差异。以下命令从仓库根目录运行，以 Windows PowerShell 为例。

## 准备与启动

1. 运行 `node --version` 和 `npm.cmd --version`。Node.js 要求 20 或更高版本。Windows PowerShell 使用 `npm.cmd` 可以直接选择 npm 的命令文件。
2. 运行 `npm.cmd ci`，按锁文件安装依赖。执行前确认 npm 源可访问。该命令会重建 `node_modules`。
3. 准备本机 Google Chrome、能访问 Dramart 的网络，以及有对应团队、模型和素材权限的账号。无需真实账号和 Chrome 即可跑下面的离线回归测试。
4. 按 [运行依赖与任务数据](../operations/runtime-and-data.md) 设置登录方式。启动开发环境时可只监听回环地址。

```powershell
$env:HOST = '127.0.0.1'
$env:PORT = '9091'
npm.cmd run start:node-task
```

在另一个终端检查 HTTP：

```powershell
$baseUrl = 'http://127.0.0.1:9091'
Invoke-RestMethod "$baseUrl/health"
Invoke-RestMethod "$baseUrl/api/result/dramart-20261123000000-00000"
Invoke-RestMethod "$baseUrl/api/files/invalid-id"
```

预期 `/health` 的 `success` 为 `true`。示例合法 ID 无记录时返回 `processing` 且 `completion_response` 为 `null`。非法 ID 返回 `status: error`。选择一个当前数据目录没有的合法 ID，避免查到已有任务。

## 自动化验证

```powershell
npm.cmd test
node --test nodejs/task-server.test.js
node --test nodejs/prepare-video-workflow.test.js nodejs/video-child-runner.test.js nodejs/video-preparation-scheduler.test.js
```

| 改动区域 | 回归重点 |
| --- | --- |
| `task-server.test.js` | 路由、请求归类、字段标准化、状态和媒体响应、文件读写错误、启动恢复、认证和派发。 |
| `chrome-runtime.test.js`、`dramart-team.test.js`、`dramart-style.test.js` | Chrome 查找和空闲轮换、活动团队、风格优先级与分页异常。 |
| `image-session.test.js`、`image-task-status-panel.test.js` | 每日项目复用、模型、素材并发隔离、会话重建、面板顺序与终态保留。 |
| `canvas-video-session.test.js` | 模型映射、两个生成模式、素材上传或复用、并发限制及任务 ID 查询。 |
| `prepare-video-workflow.test.js`、`video-child-runner.test.js`、`video-preparation-scheduler.test.js`、`video-temp-images.test.js` | 项目分页、网页控件与素材持久化、任务准备标记、进程退出、队列恢复与临时文件清理。 |

这些测试使用替身、临时目录和本地 HTTP 监听。完整测试以 npm 退出码为 0、TAP 的 `fail` 为 0 为完成标准。若沙箱禁止写默认 npm 缓存，可将 `npm_config_cache` 指向当前用户可写的临时目录后重跑。

## 真实端到端验收

完成离线检查后，按 [运行检查清单](../operations/operations-checklist.md) 准备专用的 Dramart 测试团队和素材，再按 [媒体生成索引](../media-generation/index.md) 分别验证所改动的流程。真实执行可能创建项目、素材、集和分镜，也可能产生上游用量。验收应留存本地任务 ID、已核对的终态和实际可访问的媒体地址。测试返回成功与真实账号可用分别记录。

修改有副作用的重启场景时，先用对应回归测试验证，真实环境验收需使用隔离数据目录所属的独立工作副本，并确认没有其他任务。任务目录是由项目路径推导的，代码没有用于覆盖其位置的环境变量。

## 交付前同步文档

1. 改路由、验证、默认值或响应，检查 [任务 API](../task-api.md) 和 [HTTP 路由清单](http-route-reference.md)。
2. 改素材、模型、浏览器页面、状态或派发，检查 [媒体生成指南](../media-generation/index.md) 和 [项目结构](architecture.md)。
3. 改账户配置、端口、环境变量、目录、恢复、日志或清理，检查 [运行与交接](../operations/index.md) 和 README。
4. 在根目录运行以下命令重新定位路由和公共中间件，再核对文档中的行号。检查相对链接、章节锚点、命令所需文件和实际运行结果，记录待确认的线上事项。

```powershell
rg -n 'app\.(get|post|use)\(' nodejs/task-server.js
git diff --check
```
