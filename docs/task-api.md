# Seedance 自动化任务 API

本文档描述 `nodejs/task-server.js` 提供的生图与视频创作接口。

生图和视频共用同一套任务协议：

```text
POST /api/ask
GET  /api/result/{task_id}
GET  /api/files/{task_id}
```

服务默认仅监听 `127.0.0.1:9091`：

```text
http://127.0.0.1:9091
```

如通过 `PORT` 环境变量部署在其他端口，请替换本文示例中的端口。
如确需监听其他网卡，可通过 `HOST` 环境变量显式覆盖，例如 `HOST=0.0.0.0`。由于接口支持服务端本地文件路径和远程 URL，除非已有可靠的访问控制，不应将服务直接暴露到公网。

## 1. 工作流程

推荐使用异步任务模式：

1. 调用 `POST /api/ask` 提交生图或视频任务。
2. 保存响应中的顶层 `task_id`。
3. 每隔 3 至 5 秒调用 `GET /api/result/{task_id}`。
4. 顶层 `status` 为 `processing` 时继续轮询。
5. 顶层 `status` 为 `completed` 时停止轮询。
6. 检查 `result.status`，值为 `success` 表示成功，值为 `error` 表示失败。

任务成功后，也可以调用 `GET /api/files/{task_id}` 获取统一格式的媒体地址。

## 2. 任务类型

生图和视频没有两个独立的提交 URL。服务根据请求内容决定任务类型。

判断顺序如下：

1. `action`、`task_type` 或 `type` 包含 `image` 时，判定为生图。
2. `model` 是已知 Seedream 图片模型时，判定为生图。
3. 其他情况判定为视频。

建议调用方始终显式传入 `action`：

```json
{
  "action": "generate_image"
}
```

或：

```json
{
  "action": "generate_video"
}
```

## 3. 提交任务

### 3.1 接口

```http
POST /api/ask
Content-Type: application/json
```

默认采用异步模式，接口创建本地任务后立即返回 `task_id`，浏览器自动化流程在后台继续执行。

生图任务由服务进程内的常驻会话执行。服务每次启动都会新建一个名为 `image` 的 manual 项目，以固定项目比例 `9:16` 完成资源确认并长期保留其 Canvas 页面。项目比例只是创建项目所需参数；每个生图请求仍按自身 `ratio` 提交。并发生图请求共享项目和认证页面，但分别上传参考图、创建生成资源并按各自的 `resourceId` 独立轮询，不经过本地串行队列。单个任务失败不会关闭共享页面或中止其他任务；页面关闭或浏览器断连后，后续请求共享一次会话重建。

视频任务使用 FIFO preparation queue 和独立子进程。队列只串行化共享项目确认以及为当前任务创建专属 episode/shot 的准备阶段；子进程输出有效 `TASK_STARTED`，且服务持久化其中的 `EpisodeId`、`ShotId` 等上下文后，下一项立即进入准备阶段。已经 prepared 的任务继续在各自独立页面中并发上传图片、填写参数、提交生成和轮询结果，不必等待前一个视频任务完成。

只有在有效 `TASK_STARTED` 上下文持久化前无法确认子进程退出，才会阻塞视频 preparation queue；持久化成功后该任务已经离开共享准备区，后续失败或退出状态不明不会追溯阻塞下一项。

视频任务的 `queue_position` 是动态值：`0` 表示任务已占用视频 preparation 调度槽，此时可能仍在等待认证，或正在执行项目确认和专属 episode/shot 创建；正数表示仍在等待该调度槽的 FIFO 位置。服务持久化有效 `TASK_STARTED` 后，任务进入 `processing` 并释放调度槽，后续查询不再包含 `queue_position`。服务重启时，持久化为 `queued` 的视频任务按原顺序恢复排队；持久化为 `processing` 的视频任务会以“服务重启导致任务中断”失败结束，不会自动重放，以免重复创建 episode/shot 或重复提交。视频请求中需要物化的临时图片存放在按 `task_id` 隔离的目录中，任务结束后只清理该任务自己的目录。

### 3.2 视频请求示例

```json
{
  "action": "generate_video",
  "model": "doubao-seedance-2-0-fast-260128",
  "prompt": "一只小猫在阳光下看向镜头，电影感，柔和光线",
  "images": [
    {
      "type": "reference_image",
      "url": "https://example.com/cat.jpg"
    }
  ],
  "resolution": "720p",
  "ratio": "16:9",
  "duration": 5,
  "output_format": "mp4",
  "wait_for_completion": false
}
```

### 3.3 视频请求字段

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---:|---|---|
| `action` | string | 建议 | 自动判断 | 建议固定传 `generate_video` |
| `model` | string | 否 | `doubao-seedance-2-0-fast-260128` | Seedance 模型 |
| `prompt` | string | 是 | 无 | 视频提示词，不能为空 |
| `images` | array/string | 否 | `[]` | 一张或多张参考图片 |
| `image` | object/string | 否 | 无 | 单张图片，是 `images` 的简写 |
| `image_type` | string | 否 | `reference_image` | 字符串图片使用的默认角色 |
| `resolution` | string | 否 | `720p` | 视频清晰度，支持 `480p`、`720p`、`1080p`、`4k`；大小写输入会规范化为小写 |
| `ratio` | string | 否 | `16:9` | 视频比例 |
| `duration` | integer | 否 | `5` | 视频时长，必须是正整数 |
| `output_format` | string | 否 | `mp4` | 输出格式 |
| `seed` | integer | 否 | `-1` | 会写入任务载荷，当前网页工作流未实际使用 |
| `framespersecond` | integer | 否 | `24` | 会写入任务载荷，当前网页工作流未实际使用 |
| `generate_audio` | boolean | 否 | `false` | 会写入任务载荷，当前网页工作流未实际使用 |
| `watermark` | boolean | 否 | `false` | 会写入任务载荷，当前网页工作流未实际使用 |
| `camera_fixed` | boolean | 否 | `false` | 会写入任务载荷，当前网页工作流未实际使用 |
| `wait_for_completion` | boolean | 否 | `false` | 是否让 `/api/ask` 等待任务执行完毕 |
| `advancedJson` | string | 否 | 无 | JSON 字符串，解析后覆盖同名字段 |
| `advanced_json` | string | 否 | 无 | `advancedJson` 的别名 |

### 3.4 支持的视频模型

```text
doubao-seedance-2-5-260628
doubao-seedance-2-0-260128
doubao-seedance-2-0-fast-260128
doubao-seedance-2-0-mini-260615
```

### 3.5 视频图片角色

支持以下图片角色：

```text
reference_image
first_frame
last_frame
```

使用 `first_frame` 或 `last_frame` 时，视频工作流会采用图生视频模式。

图片可以使用字符串：

```json
{
  "images": [
    "https://example.com/reference.jpg"
  ]
}
```

也可以使用对象：

```json
{
  "images": [
    {
      "type": "reference_image",
      "url": "https://example.com/reference.jpg"
    },
    {
      "role": "first_frame",
      "image_url": {
        "url": "https://example.com/first-frame.jpg"
      }
    }
  ]
}
```

图片值支持：

- HTTP 或 HTTPS URL
- Data URL
- Base64 字符串
- 服务所在机器上的本地文件路径

Data URL 和 Base64 字符串使用标准 Base64 alphabet，padding 只能位于末尾且最多两个；允许换行等 ASCII 空白，移除空白后的总长度必须是 4 的倍数。本地图片路径不存在时会明确报错，不会再按 Base64 尝试解析。

### 3.6 生图请求示例

```json
{
  "action": "generate_image",
  "model": "ep-20260318144532-28ssz",
  "model_name": "Doubao-Seedream-5.0-lite",
  "prompt": "将参考商品制作成极简摄影棚广告图，柔和侧光，白色背景",
  "images": [
    {
      "url": "https://example.com/product.jpg",
      "title": "商品参考图"
    }
  ],
  "ratio": "1:1",
  "resolution": "1k",
  "count": 1,
  "wait_for_completion": false
}
```

### 3.7 生图请求字段

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---:|---|---|
| `action` | string | 建议 | 自动判断 | 建议固定传 `generate_image` |
| `model` | string | 否 | 见下方注意事项 | 图片模型 Code 或名称 |
| `model_name` | string | 建议 | 根据 `model` 推导；未传模型时为 `Doubao-Seedream-5.0-Pro` | 图片模型显示名称 |
| `modelName` | string | 否 | 无 | `model_name` 的别名 |
| `prompt` | string | 是 | 无 | 生图提示词，不能为空 |
| `images` | array/string | 是 | 无 | 至少一张参考图片 |
| `image` | object/string | 否 | 无 | 单张参考图片简写 |
| `ratio` | string | 否 | `16:9` | 图片生成比例 |
| `aspect_ratio` | string | 否 | 无 | `ratio` 的别名 |
| `ratios` | string | 否 | 无 | `ratio` 的兼容别名 |
| `resolution` | string | 否 | `720p` | 图片生成分辨率 |
| `count` | number | 否 | `1` | 生成数量，最小为 1 |
| `n` | number | 否 | 无 | `count` 的别名 |
| `style_id` | string | 否 | 内置风格 ID | 风格 ID |
| `styleId` | string | 否 | 无 | `style_id` 的别名 |
| `wait_for_completion` | boolean | 否 | `false` | 是否让 `/api/ask` 等待任务执行完毕 |

生图任务必须包含至少一张参考图片。当前实现不支持纯文本无参考图生图。上述 `ratio: 16:9` 和 `resolution: 720p` 是 `task-server` 对请求的默认标准化值；共享 `image` 项目创建时仍使用固定项目比例 `9:16`，该项目级参数不会覆盖请求的图片生成比例。

### 3.8 支持的生图模型

Seedream 5.0 Pro：

```json
{
  "model": "ep-20260709194802-qsvc2",
  "model_name": "Doubao-Seedream-5.0-Pro"
}
```

Seedream 5.0 Lite：

```json
{
  "model": "ep-20260318144532-28ssz",
  "model_name": "Doubao-Seedream-5.0-lite"
}
```

Seedream 4.5：

```json
{
  "model": "ep-20260318141930-4mnvw",
  "model_name": "Doubao-Seedream-4.5"
}
```

`model` 也接受以下名称别名：

```text
Doubao-Seedream-5.0-Pro
doubao-seedream-5-0-pro
Doubao-Seedream-5.0-lite
doubao-seedream-5-0-lite
Doubao-Seedream-4.5
doubao-seedream-4-5
```

建议同时显式传入匹配的 `model` 和 `model_name`，避免模型 Code 与显示名称不一致。

## 4. `/api/ask` 响应

### 4.1 异步受理成功

默认 `wait_for_completion` 为 `false`，接口立即返回：

```json
{
  "status": "processing",
  "message": "任务已发送给客户端",
  "task_id": "dramart-20260909153000-abc12",
  "debug_task_id": "dramart-20260909153000-abc12",
  "queue_position": 1,
  "completion_response": {
    "task_id": "dramart-20260909153000-abc12",
    "debug_task_id": "dramart-20260909153000-abc12",
    "status": "queued"
  }
}
```

调用方必须保存顶层 `task_id`。上例表示视频任务提交时前面已有一项占用 preparation 调度槽；`queue_position` 并非固定值。`0` 表示当前任务已占用该槽，可能正在等待认证或执行项目确认、专属 episode/shot 创建；正数表示等待该槽。生图响应当前也包含兼容字段 `queue_position: 0`，但生图不使用该视频 preparation queue，调用方不应据此推断生图调度状态。

### 4.2 请求校验失败

请求格式错误或缺少必要字段时，当前服务通常仍返回 HTTP 200，通过 JSON 业务状态表达错误：

```json
{
  "status": "error",
  "message": "prompt 不能为空",
  "result": null,
  "completion_response": {
    "payload": {}
  }
}
```

可能的校验错误包括：

- `prompt 不能为空`
- `图片生成至少需要 1 张参考图`
- `不支持的模型`
- `duration 必须是正整数秒`
- `resolution 不支持，可选值为 480p、720p、1080p、4k`
- `advancedJson 不是合法 JSON`

### 4.3 同步等待模式

设置以下字段：

```json
{
  "wait_for_completion": true
}
```

`POST /api/ask` 会等待浏览器自动化任务结束，然后返回与 `/api/result/{task_id}` 相同的完成结构。

同步请求的总耗时没有固定上限，包含 FIFO 队列等待、认证等待、视频准备以及生成结果轮询。`VIDEO_PREPARATION_TIMEOUT_MS` 的单位是毫秒，默认值为 `300000`；任务占用 preparation 调度槽后会先等待认证和 standby browser 准备，子进程启动后该超时约束等待有效 `TASK_STARTED` 的阶段。超时会终止视频子进程、形成失败结果并放行下一项。认证等待和队列等待本身没有固定超时上限。

`GENERATION_TIMEOUT_MS` 默认约 15 分钟，同时约束生图和视频各自提交后的生成结果轮询，不包含队列等待、认证等待或视频 preparation，也不是同步请求总超时。经过反向代理、网关或负载均衡器调用时，建议使用默认异步模式，避免 HTTP 请求超时。

## 5. 查询结果

### 5.1 接口

```http
GET /api/result/{task_id}
```

此接口没有请求体，也不需要再次传递模型、提示词或图片。

### 5.2 处理中

视频任务仍在 preparation queue 中时，顶层兼容状态保持为 `processing`，实际排队状态及动态位置如下：

```json
{
  "status": "processing",
  "message": "任务排队中",
  "queue_position": 2,
  "completion_response": {
    "task_id": "dramart-20260909153000-abc12",
    "debug_task_id": "dramart-20260909153000-abc12",
    "status": "queued"
  }
}
```

`queue_position: 0` 表示任务已占用视频 preparation 调度槽，可能正在等待认证或执行项目确认、专属 episode/shot 创建；正数表示等待该槽的位置，并会随着前序任务放行而变化。有效 `TASK_STARTED` 上下文持久化后，任务释放该槽并进入 `processing`，响应不再包含 `queue_position`。

视频任务收到 `TASK_STARTED` 并转为 `processing` 后，或生图任务处于处理中时，响应不提供队列位置：

```json
{
  "status": "processing",
  "message": "任务处理中",
  "completion_response": {
    "task_id": "dramart-20260909153000-abc12",
    "debug_task_id": "dramart-20260909153000-abc12",
    "status": "processing"
  }
}
```

自动化进入项目后，`completion_response` 可能包含项目、剧集和调试上下文。视频进入 `processing` 只表示 preparation 已完成；上传、参数填写、提交及结果轮询仍可能在独立页面中继续。

### 5.3 任务不存在

```json
{
  "status": "processing",
  "message": "任务处理中或不存在",
  "completion_response": null
}
```

当前实现不会对不存在的任务返回 HTTP 404，因此客户端无法严格区分“任务尚未落盘”和“任务 ID 不存在”。调用方应设置自己的最大轮询次数或总超时时间。

### 5.4 视频成功

```json
{
  "status": "completed",
  "result": {
    "status": "success",
    "task_id": "dramart-20260909153000-abc12",
    "debug_task_id": "2026-09-09-16:9-1",
    "project_name": "2026-09-09-16:9",
    "episode_index": 1,
    "action": "generate_video",
    "data": {
      "status": "succeeded",
      "debug_task_id": "2026-09-09-16:9-1",
      "content": {
        "video_url": "https://cdn.example.com/video.mp4"
      }
    },
    "error": "",
    "message": "",
    "url_id": "",
    "client_id": "seedance_api",
    "updated_at": 1788967800,
    "video_url": "https://cdn.example.com/video.mp4",
    "completion_response": {}
  },
  "completion_response": {}
}
```

获取媒体地址时依次读取视频地址、兼容图片地址和规范化图片数组的第一项：

```js
result.video_url || result.image_url || (Array.isArray(result.data) ? result.data[0] : '')
```

兼容读取：

```text
result.data.content.video_url
```

### 5.5 生图成功

```json
{
  "status": "completed",
  "result": {
    "status": "success",
    "task_id": "dramart-20260909154000-def34",
    "action": "generate_image",
    "data": [
      "https://cdn.example.com/image-1.png"
    ],
    "error": "",
    "url_id": "",
    "client_id": "seedance_api"
  }
}
```

获取第一张图片地址：

```text
result.data[0]
```

当 `count > 1` 时，全部图片 URL 都包含在 `result.data` 中。

### 5.6 生图失败

```json
{
  "status": "completed",
  "result": {
    "status": "error",
    "task_id": "dramart-20260909154000-def34",
    "action": "generate_image",
    "data": "",
    "error": "具体错误信息",
    "url_id": "",
    "client_id": "seedance_api"
  }
}
```

### 5.7 视频任务执行失败

视频和生图执行失败时，顶层 `status` 仍然是 `completed`，表示任务已经结束；具体成功或失败由 `result.status` 表达：

```json
{
  "status": "completed",
  "result": {
    "status": "error",
    "task_id": "dramart-20260909153000-abc12",
    "action": "generate_video",
    "data": "",
    "error": "具体错误信息",
    "message": "",
    "url_id": "",
    "client_id": "seedance_api",
    "updated_at": 1788967800,
    "completion_response": {
      "exception": "具体错误信息"
    }
  },
  "completion_response": {
    "exception": "具体错误信息"
  }
}
```

客户端必须检查两层状态：

```js
if (response.status === 'completed') {
  if (response.result?.status === 'success') {
    // 任务成功
  } else {
    // 任务已结束，但执行失败
    console.error(response.result?.error);
  }
}
```

不要只检查顶层 `status === "completed"`。

## 6. 获取媒体文件

### 6.1 接口

```http
GET /api/files/{task_id}
```

该接口将视频或图片地址统一为 `cdn_url`。

### 6.2 成功响应

```json
{
  "status": "completed",
  "result": {
    "type": "download_complete",
    "task_id": "dramart-20260909153000-abc12",
    "cdn_url": "https://cdn.example.com/media.mp4",
    "file_type": "cdn_url",
    "updated_at": 1788967800
  },
  "completion_response": {}
}
```

生图任务的 `cdn_url` 是第一张图片地址；视频任务的 `cdn_url` 是视频地址。

### 6.3 文件未生成

```json
{
  "status": "processing",
  "message": "文件生成中或不存在",
  "completion_response": null
}
```

### 6.4 任务失败

```json
{
  "status": "failed",
  "result": {
    "status": "error",
    "error": "具体错误信息"
  },
  "completion_response": {}
}
```

## 7. 状态判断

| 顶层 `status` | `result.status` | 含义 |
|---|---|---|
| `processing` | 无 | 任务仍在处理，继续轮询 |
| `error` | 无 | 请求校验或任务创建阶段失败 |
| `completed` | `success` | 任务执行成功 |
| `completed` | `error` | 任务执行结束，但生成失败 |

建议客户端设置：

- 轮询间隔：3 至 5 秒
- 最大等待时间：根据业务 SLA 自行设置；应覆盖队列、认证、准备和生成轮询，不能直接等同于 `GENERATION_TIMEOUT_MS`
- 连续网络失败重试次数：3 至 5 次

## 8. cURL 示例

以下命令适用于 Windows `cmd.exe`。

### 8.1 提交视频任务

```bat
curl -X POST "http://127.0.0.1:9091/api/ask" ^
  -H "Content-Type: application/json" ^
  -d "{\"action\":\"generate_video\",\"model\":\"doubao-seedance-2-0-fast-260128\",\"prompt\":\"商品旋转展示，摄影棚光线\",\"images\":[{\"type\":\"reference_image\",\"url\":\"https://example.com/product.jpg\"}],\"resolution\":\"720p\",\"ratio\":\"16:9\",\"duration\":5,\"output_format\":\"mp4\",\"wait_for_completion\":false}"
```

### 8.2 提交生图任务

```bat
curl -X POST "http://127.0.0.1:9091/api/ask" ^
  -H "Content-Type: application/json" ^
  -d "{\"action\":\"generate_image\",\"model\":\"ep-20260318144532-28ssz\",\"model_name\":\"Doubao-Seedream-5.0-lite\",\"prompt\":\"白色摄影棚商品广告图\",\"images\":[{\"url\":\"https://example.com/product.jpg\"}],\"ratio\":\"1:1\",\"resolution\":\"1k\",\"count\":1,\"wait_for_completion\":false}"
```

### 8.3 查询任务

```bat
curl "http://127.0.0.1:9091/api/result/dramart-20260909153000-abc12"
```

### 8.4 获取媒体地址

```bat
curl "http://127.0.0.1:9091/api/files/dramart-20260909153000-abc12"
```

## 9. JavaScript 调用示例

```js
const baseUrl = 'http://127.0.0.1:9091';

const askResponse = await fetch(`${baseUrl}/api/ask`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    action: 'generate_video',
    model: 'doubao-seedance-2-0-fast-260128',
    prompt: '商品旋转展示，摄影棚光线',
    images: [
      {
        type: 'reference_image',
        url: 'https://example.com/product.jpg',
      },
    ],
    resolution: '720p',
    ratio: '16:9',
    duration: 5,
    output_format: 'mp4',
  }),
});

const accepted = await askResponse.json();
if (accepted.status !== 'processing') {
  throw new Error(accepted.message || '任务提交失败');
}

const taskId = accepted.task_id;

while (true) {
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const resultResponse = await fetch(`${baseUrl}/api/result/${encodeURIComponent(taskId)}`);
  const response = await resultResponse.json();

  if (response.status === 'processing') continue;
  if (response.status !== 'completed') {
    throw new Error(response.message || '任务查询失败');
  }
  if (response.result?.status !== 'success') {
    throw new Error(response.result?.error || '生成失败');
  }

  const mediaUrl = response.result.video_url || response.result.image_url || (Array.isArray(response.result.data) ? response.result.data[0] : '');
  console.log({ taskId, mediaUrl, result: response.result });
  break;
}
```

## 10. 相关实现

- 服务入口：`nodejs/task-server.js`
- 任务类型判断：`nodejs/task-server.js` 中的 `taskAction`
- 请求标准化：`nodejs/task-server.js` 中的 `bodyToPayload`
- 视频自动化：`nodejs/prepare-video-workflow.js`
- 常驻生图会话：`nodejs/image-session.js`
- 旧生图命令行工作流（任务服务不再调用）：`nodejs/prepare-image-workflow.js`
- 本地任务请求：`seedance_tasks/requests/`
- 运行中任务：`seedance_tasks/running/`
- 已完成任务：`seedance_tasks/results/`
