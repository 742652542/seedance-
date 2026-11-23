# HTTP 路由清单

路由全部注册在 [task-server.js](../../nodejs/task-server.js) 的 `createTaskApp()` 内。Express 应用直接挂在根路径，`/api` 是各任务路径的一部分。此清单按路由声明列出，参数、模型及示例见 [任务 API](../task-api.md)。

| 方法 | 路径 | 处理入口和源码位置 | 作用 |
| --- | --- | --- | --- |
| POST | `/api/ask` | `asyncRoute` 包装的处理函数，[task-server.js:1304](../../nodejs/task-server.js#L1304) | 转换和校验请求，保存任务，派发后台执行。可同步等待。 |
| GET | `/api/result/:task_id` | `asyncRoute` 包装的处理函数，[task-server.js:1407](../../nodejs/task-server.js#L1407) | 优先读终态结果，再查运行记录。合法 ID 无记录时同样返回 `processing`。 |
| GET | `/api/files/:task_id` | `asyncRoute` 包装的处理函数，[task-server.js:1443](../../nodejs/task-server.js#L1443) | 读取终态记录并返回媒体地址，客户端自行访问 `cdn_url`。 |
| GET | `/health` | 内联处理函数，[task-server.js:1472](../../nodejs/task-server.js#L1472) | 返回固定健康标记、服务名、配置端口及 `ark_base_url`。用于检查 HTTP 响应。 |

## 请求经过的公共处理

1. [全局 JSON 解析](../../nodejs/task-server.js#L1298) 使用 `express.json({ limit: '200mb' })`。提交时使用 `Content-Type: application/json`。
2. [任务路径就绪检查](../../nodejs/task-server.js#L1299) 等待 `app.locals.ready`，覆盖三条任务路径。正常启动本身也会等待恢复完成后才开始监听。健康路由绕过这层任务路径处理。
3. [任务 ID 校验](../../nodejs/task-server.js#L1398) 应用于结果和媒体路径，`task_id` 必须匹配 `^dramart-\d{14}-[a-z0-9]{5}$`。格式错误返回 JSON `status: "error"`。
4. [统一异常处理](../../nodejs/task-server.js#L1476) 记录错误并返回 `status: "error"` 的 JSON。调用方须检查响应体状态。Express 对未匹配路径使用默认 404。

清单列的是显式注册的方法。Express 的 GET 处理也覆盖相应 HEAD，请求只有响应头。Express 可以自动回答匹配路径的 OPTIONS，所用 HTTP 方法来自路由声明。服务没有 CORS 或 HTTP 调用方鉴权中间件。Dramart 认证发生在任务后台派发阶段。网络边界与接入验收见 [运行检查清单](../operations/operations-checklist.md)。
