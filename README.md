# Seedance 自动化任务服务

项目只保留 `npm run start:node-task` 对应的 Dramart 自动化任务服务，支持生图、Canvas 视频和项目/分镜视频任务。

## 安装与启动

需要 Node.js 20 或更高版本，以及本机安装的 Google Chrome。

```sh
npm ci
npm run start:node-task
```

默认监听 `0.0.0.0:9091`，本机访问 `http://127.0.0.1:9091`。`GET /health` 用于检查服务状态。

服务自动查找并启动 Google Chrome，登录状态保存在 `.chrome-user-data/`。Chrome 运行满 24 小时后，服务会等待任务空闲再重启浏览器。

Chrome 查找顺序：

1. 环境变量 `CHROME_PATH`。
2. `C:\Program Files\Google\Chrome\Application\chrome.exe`。
3. `C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`。
4. `%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`。

## 账号配置

可以设置 `DRAMART_USERNAME`、`DRAMART_PASSWORD` 环境变量，或在项目根目录创建 `dramart-auth.json`：

```json
{
  "username": "你的账号",
  "password": "你的密码"
}
```

环境变量优先于配置文件。账号配置、浏览器缓存和任务数据均不提交到 Git。

## API

完整请求参数、模型和返回格式见 [任务 API 文档](docs/task-api.md)。

| 接口 | 用途 |
| --- | --- |
| `POST /api/ask` | 提交任务 |
| `GET /api/result/{task_id}` | 查询任务结果 |
| `GET /api/files/{task_id}` | 获取生成的媒体地址 |
| `GET /health` | 健康检查 |

任务类型：

- `generate_image`：常驻 Canvas 会话生图。
- `generate_video`：Canvas 视频流程。
- `generate_video_project`：项目/分镜视频流程，通过独立子进程执行。

## 常用环境变量

| 变量 | 默认值或用途 |
| --- | --- |
| `HOST` | `0.0.0.0` |
| `PORT` | `9091` |
| `CHROME_PATH` | 自定义 Chrome 可执行文件路径 |
| `BROWSER_URL` | 连接已有 Chrome 调试地址 |
| `TEAM_ID` | 指定团队；未设置时自动解析 |
| `SEEDANCE_DEBUG` | 默认开启，设为 `0` 关闭 |
| `DRAMART_VISUAL_PROMPT_ID` | 指定当前账号可用的风格 ID |
| `GENERATION_TIMEOUT_MS` | 图片及项目视频生成超时，默认 `900000` |
| `VIDEO_GENERATION_TIMEOUT_MS` | Canvas 视频生成超时，默认 `1800000` |
| `POLL_INTERVAL_MS` | 生成结果轮询间隔，默认 `3000` |
| `MEDIA_TRANSFER_CONCURRENCY` | Canvas 素材传输并发数，默认 `2` |
| `MEDIA_TRANSFER_TIMEOUT_MS` | 单个素材下载或上传阶段超时，默认 `900000` |
| `VIDEO_PREPARATION_TIMEOUT_MS` | 项目视频准备阶段超时，默认 `300000` |

未设置 `DRAMART_VISUAL_PROMPT_ID` 时，服务读取当前团队可见的自定义风格：只有一个时自动使用，没有时回退到 `realistic_modern_urban`，多个时要求显式指定。请求中的 `style_id` / `styleId` 可以覆盖单次任务的风格。

## 目录与测试

- `nodejs/task-server.js`：唯一服务入口，负责认证、任务 API 和任务恢复。
- `nodejs/`：该入口依赖的浏览器、图片、视频、调度和临时素材模块，以及对应回归测试。
- `docs/task-api.md`：接口文档。
- `seedance_tasks/`：运行时生成的请求、运行状态和结果。

```sh
npm test
```
