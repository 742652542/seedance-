# Seedance 自动化任务 API

本文档描述 `nodejs/task-server.js` 提供的生图与视频创作接口。

首次接入可按 [媒体生成索引](media-generation/index.md) 选择流程。服务还提供 `GET /health`，用于确认 HTTP 响应。它返回 `success`、`service`、`port` 和 `ark_base_url`，其中历史服务名保留为 `seedance-python-task-server`。登录和真实生成需要单独验收，见 [HTTP 路由清单](development/http-route-reference.md) 与 [运行检查清单](operations/operations-checklist.md)。

生图和视频共用同一套任务协议：

```text
POST /api/ask
GET  /api/result/{task_id}
GET  /api/files/{task_id}
```

服务默认监听 `0.0.0.0:9091`，本机可通过以下地址访问：

```text
http://127.0.0.1:9091
```

如通过 `PORT` 环境变量部署在其他端口，请替换本文示例中的端口。
可通过 `HOST` 环境变量覆盖默认监听地址，例如设置 `HOST=127.0.0.1` 后仅允许本机访问。由于接口支持服务端本地文件路径和远程 URL，除非已有可靠的访问控制，不应将服务直接暴露到公网。

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

生图和两种视频流程共用一个提交 URL。服务根据请求内容决定任务类型。

判断顺序如下：

1. `action`、`task_type` 或 `type` 包含 `image` 时，判定为生图。
2. `model` 是已知 Seedream 图片模型时，判定为生图。
3. 显式传 `generate_video_project` 时，使用旧的项目/分镜网页流程。
4. 其他情况判定为新的 Canvas 视频 API 流程 `generate_video`。

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

旧项目流程使用：

```json
{
  "action": "generate_video_project"
}
```

## 3. 提交任务

### 3.1 接口

```http
POST /api/ask
Content-Type: application/json
```

默认采用异步模式，接口创建本地任务后立即返回 `task_id`，浏览器自动化流程在后台继续执行。JSON 请求体上限为 200 MB。如果提供非空的 `content` 数组，则使用其中的 `text`、`image_url`、`video_url` 项作为任务输入，优先于简写字段。

生图任务由服务进程内的常驻会话执行。服务初始化时使用上海时区的当天日期（`YYYY-MM-DD`）作为项目名称，不附加风格或其他后缀；分页查找当前团队的同名项目，存在则复用，不存在才新建 manual 项目，以固定项目比例 `9:16` 完成资源确认并长期保留其 Canvas 页面。项目比例只是创建项目所需参数；每个生图请求仍按自身 `ratio` 提交。并发生图请求共享项目和认证页面，但分别上传参考图、创建生成资源并按各自的 `resourceId` 独立轮询，不经过本地串行队列。单个任务失败不会关闭共享页面或中止其他任务；页面关闭或浏览器断连后，后续请求共享一次会话重建。

`generate_video` 与生图共用已认证的常驻 Canvas 预加载会话，直接调用 Canvas 的资源上传、`/tasks/video_gen/create` 和查询接口，不创建 episode/shot，也不进入旧视频队列。多个 Canvas 视频任务可以并发执行：它们共享认证页面，但分别上传素材、创建 `ResourceId`，并按各自的 `TaskIds` 独立轮询。它支持纯文字、仅图片、仅视频、图片和视频混合参考。

远程参考素材采用磁盘流式下载和流式上传，不会把完整视频载入内存。`MEDIA_TRANSFER_CONCURRENCY` 控制整个 Canvas 会话同时传输的素材数，默认 `2`；`MEDIA_TRANSFER_TIMEOUT_MS` 分别控制单个素材下载阶段和上传阶段的总超时，默认 `900000` 毫秒。

`generate_video_project` 保留原来的 FIFO preparation queue 和独立子进程。队列只串行化共享项目确认以及为当前任务创建专属 episode/shot 的准备阶段；子进程输出有效 `TASK_STARTED`，且服务持久化其中的 `EpisodeId`、`ShotId` 等上下文后，下一项立即进入准备阶段。已经 prepared 的任务继续在各自独立页面中并发执行。

只有在有效 `TASK_STARTED` 上下文持久化前无法确认子进程退出，才会阻塞视频 preparation queue；持久化成功后该任务已经离开共享准备区，后续失败或退出状态不明不会追溯阻塞下一项。

只有 `generate_video_project` 使用动态 `queue_position`。`generate_video` 与生图一样直接返回 `queue_position: 0`，该字段只是兼容字段。服务重启时，排队的项目视频可以恢复，已经处于处理中的两种视频会写入中断结果，遗留生图记录不会自动重跑，详见 [启动恢复规则](operations/runtime-and-data.md#服务重启如何处理未完成任务)。

### 3.2 视频请求示例

```json
{
  "action": "generate_video",
  "model": "Doubao-Seedance-2.0-fast",
  "prompt": "一只小猫在阳光下看向镜头，电影感，柔和光线",
  "images": [
    {
      "type": "reference_image",
      "url": "https://example.com/cat.jpg"
    }
  ],
  "videos": [
    {
      "url": "https://example.com/motion.mp4",
      "title": "运动参考"
    }
  ],
  "gen_type": "reference_frame",
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
| `action` | string | 建议 | 自动判断 | 新 Canvas 流程固定传 `generate_video`；旧项目流程传 `generate_video_project` |
| `model` | string | 否 | Canvas：`Doubao-Seedance-2-0`；旧项目：`Doubao-Seedance-2.0-fast` | Canvas 支持下表的名称或 Code，旧项目只接受下文列出的页面名称 |
| `prompt` | string | 是 | 无 | 视频提示词，不能为空 |
| `images` | array/string | 否 | `[]` | 一张或多张参考图片 |
| `image` | object/string | 否 | 无 | 单张图片，是 `images` 的简写 |
| `videos` | array/object/string | 否 | `[]` | 一段或多段参考视频，仅 Canvas 的 `reference_frame` 可用 |
| `video` | object/string | 否 | 无 | 单段视频，是 `videos` 的简写 |
| `gen_type` / `genType` | string | 否 | `reference_frame` | Canvas 的 `reference_frame`（全能参考）或 `head_tail_frame`（首尾帧）。旧项目按图片角色选择模式 |
| `image_type` | string | 否 | `reference_image` | 字符串图片使用的默认角色 |
| `resolution` | string | 否 | `720p` | 视频清晰度，支持 `480p`、`720p`、`1080p`、`4k`；大小写输入会规范化为小写 |
| `ratio` | string | 否 | `16:9` | 视频比例 |
| `duration` | integer | 否 | `5` | 视频时长，必须是正整数 |
| `count` / `n` | number | 否 | `1` | Canvas 视频提交的生成数量，最小为 1 |
| `output_format` | string | 否 | `mp4` | 输出格式 |
| `seed` | integer | 否 | `-1` | 会写入任务载荷，当前网页工作流未实际使用 |
| `framespersecond` | integer | 否 | `24` | 会写入任务载荷，当前网页工作流未实际使用 |
| `generate_audio` | boolean | 否 | `false` | 会写入任务载荷，当前网页工作流未实际使用 |
| `watermark` | boolean | 否 | `false` | 会写入任务载荷，当前网页工作流未实际使用 |
| `camera_fixed` | boolean | 否 | `false` | 会写入任务载荷，当前网页工作流未实际使用 |
| `style_id` | string | 否 | 见[风格选择规则](operations/runtime-and-data.md#登录团队与风格) | Canvas 作为当次生成风格；旧项目使用该风格匹配或创建项目 |
| `styleId` | string | 否 | 无 | `style_id` 的别名 |
| `wait_for_completion` | boolean | 否 | `false` | 是否让 `/api/ask` 等待任务执行完毕 |
| `advancedJson` | string | 否 | 无 | JSON 字符串，解析后覆盖同名字段 |
| `advanced_json` | string | 否 | 无 | `advancedJson` 的别名 |

### 3.4 支持的视频模型

| 页面名称 | `VideoMeta.ModelName` 实际值 |
|---|---|
| `Seedance-2.5-Flash` | `ep-20261112160431-rl4w7` |
| `Wan-3.0` | `ali-wan3.0-video` |
| `Doubao-Seedance-2.5` | `ep-20260729173114-qjxc2` |
| `Doubao-Seedance-2-0` | `ep-20260322113401-vj4bf` |
| `Doubao-Seedance-2.0-fast` | `ep-20260320142658-hscwv` |
| `Doubao-Seedance-2.0-mini` | `doubao-seedance-2-0-mini-260615` |

这些是当前源码中的 Canvas 模型映射。项目分镜视频只接受 `Doubao-Seedance-2.5`、`Doubao-Seedance-2-0`、`Doubao-Seedance-2.0-fast`、`Doubao-Seedance-2.0-mini` 四个名称。账号实际可用模型和参数以 Dramart 为准。

Wan-3.0 用于 Canvas 视频流程（`action: generate_video`），`model` 可传 `Wan-3.0`、`wan-3.0` 或实际 Code `ali-wan3.0-video`。支持全能参考与首尾帧两种现有生成模式，页面提供 `480p`、`720p`、`1080p`。例如：

```json
{
  "action": "generate_video",
  "model": "Wan-3.0",
  "prompt": "云层穿过山谷",
  "duration": 10,
  "resolution": "720p"
}
```

Canvas 视频流程（`action: generate_video`）支持新增的 Flash 模型，`model` 可传 `doubao-seedance-2.5-flash`、`Doubao-Seedance-2.5-Flash`、页面名称 `Seedance-2.5-Flash` 或实际 Code `ep-20261112160431-rl4w7`。例如：

```json
{
  "action": "generate_video",
  "model": "doubao-seedance-2.5-flash",
  "prompt": "云层穿过山谷",
  "duration": 5,
  "resolution": "720p"
}
```

Flash 映射来自当前已登录 Canvas 页面的实际模型配置。本次未扩展旧项目/分镜流程 `generate_video_project` 的模型列表。

### 3.5 Canvas 视频参考素材与生成模式

`reference_frame` 对应页面的“全能参考”，可不传素材，也可传图片、视频或两者混合。上传后的图片引用为 `Key`、`Url` 和可选 `ArkAssetId`；视频引用另含 `ResourceId` 和可选 `Duration`。

`head_tail_frame` 对应“首尾帧”，必须传 1–2 张图片，第一张是首帧、第二张是尾帧，不能传视频。提交时提示词写入 `KeyFramePrompt`，图片写入 `KeyFrameImages.HeadImage/TailImage`。

`ArkAssetId` 是页面素材审核/资产系统返回的可选标识，不是本地生成值。已有素材可直接传；普通上传未返回时会省略，页面自身的请求构造也允许该字段为空。

图片和视频值均支持 HTTP/HTTPS URL、Data URL、Base64 字符串和服务所在机器上的本地文件路径。也可以直接传已经上传完成的对象：

```json
{
  "images": [{ "Key": "path/image.png", "Url": "https://...", "ArkAssetId": "asset-..." }],
  "videos": [{ "Key": "path/video.mp4", "Url": "https://...", "ResourceId": "media_...", "Duration": 4.096 }]
}
```

### 3.5.1 旧项目视频图片角色

支持以下图片角色：

```text
reference_image
first_frame
last_frame
```

这些角色用于 `generate_video_project` 的分镜流程。使用 `first_frame` 或 `last_frame` 时会采用图生视频模式。Canvas 首尾帧使用 `gen_type` 和图片顺序。

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
| `images` | array/object/string | 是 | 无 | 至少一张参考图片 |
| `image` | object/string | 否 | 无 | 单张参考图片简写 |
| `ratio` | string | 否 | `16:9` | 图片生成比例；支持 `1:1`、`3:2`、`2:3`、`3:4`、`4:3`、`4:5`、`5:4`、`16:9`、`9:16`、`21:9`，其他值按页面“智能”（`auto`）提交 |
| `aspect_ratio` | string | 否 | 无 | `ratio` 的别名 |
| `ratios` | string | 否 | 无 | `ratio` 的兼容别名 |
| `resolution` | string | 否 | 5.5 为 `1.5k`，其他模型为 `720p` | 图片生成分辨率；Seedream 5.5 支持 `1.5k`、`2k` |
| `count` | number | 否 | `1` | 生成数量，最小为 1 |
| `n` | number | 否 | 无 | `count` 的别名 |
| `style_id` | string | 否 | 共享生图项目自动识别的风格 | 本次生成的风格 ID；未传时与共享生图项目的风格一致 |
| `styleId` | string | 否 | 无 | `style_id` 的别名 |
| `wait_for_completion` | boolean | 否 | `false` | 是否让 `/api/ask` 等待任务执行完毕 |

生图任务必须包含至少一张参考图片。当前实现不支持纯文本无参考图生图。上述 `ratio: 16:9` 和 `resolution: 720p` 是 `task-server` 对请求的默认标准化值；共享 `image` 项目创建时仍使用固定项目比例 `9:16`，该项目级参数不会覆盖请求的图片生成比例。创建会话会在已登录且解析到 TeamId 后读取当前团队可见 `custom` 风格：一个则自动采用，零个才回退到 `realistic_modern_urban`，多个或接口异常会在创建项目前失败。`DRAMART_VISUAL_PROMPT_ID` 非空时始终跳过读取并强制采用；单个请求显式提供 `style_id` 时只覆盖该次生成的 `ParsedPrompt.StyleId`，不会重建共享会话。

切换账号或团队时，核对已有的 `DRAMART_VISUAL_PROMPT_ID`，将其换成新团队可用的 ID，或清除该配置并按团队自动解析。配置变化在重启后生效。

### 3.8 支持的生图模型

Seedream 5.5：

```json
{
  "model": "doubao-seedream-5.5",
  "resolution": "1.5k"
}
```

自动转换为 Code `ep-20261112220042-6vzbt` 和 Name `Seedream-5.5`，也可直接传入该 Code 或 `Seedream-5.5`。该模型未传分辨率或传入 `1k` 时使用 `1.5k`，传入 `2k` 时保持原样；页面提供 `1.5k`、`2k` 两种选项。不传模型时仍默认使用 5.0 Pro。

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
doubao-seedream-5.0-pro
doubao-seedream-5-0-pro
Doubao-Seedream-5.0-lite
doubao-seedream-5-0-lite
Doubao-Seedream-4.5
doubao-seedream-4-5
```

建议同时显式传入匹配的 `model` 和 `model_name`，避免模型 Code 与显示名称不一致。

比例按模型适配：5.0 Pro 的 `auto`（包括不支持的比例归一化后的 `auto`）会转换为 `1:1`；5.5 的 `auto` 保持原样。其他有效比例保持原样。

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

调用方必须保存顶层 `task_id`。上例是项目分镜视频排在第一个等待位置。`0` 表示该任务已占用准备槽，可能正在等待认证或执行项目确认、专属集和分镜创建。正数表示等待位置。生图和 Canvas 视频在受理时返回固定的兼容值 `queue_position: 0`。

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

同步请求的总耗时没有固定上限，包含认证、会话或素材准备和生成结果轮询。项目分镜视频还会等待准备队列。任务占用准备槽后先等待认证和浏览器准备，子进程启动后由 `VIDEO_PREPARATION_TIMEOUT_MS`（默认 `300000` 毫秒）约束等待有效 `TASK_STARTED` 的阶段。超时会尝试终止子进程。准备上下文尚未持久化且退出无法确认时，准备队列进入阻塞。

`GENERATION_TIMEOUT_MS` 默认 15 分钟，约束生图与项目分镜视频的生成轮询。`VIDEO_GENERATION_TIMEOUT_MS` 默认 30 分钟，约束 Canvas 视频生成轮询。队列、认证、准备、上传的耗时需另计。经过反向代理、网关或负载均衡器调用时，建议使用默认异步模式。

## 5. 查询结果

### 5.1 接口

```http
GET /api/result/{task_id}
```

此接口没有请求体，也不需要再次传递模型、提示词或图片。

### 5.2 处理中

项目分镜视频仍在等待或执行准备时，顶层兼容状态保持为 `processing`，实际排队状态及动态位置如下：

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

项目分镜视频收到 `TASK_STARTED` 并转为 `processing` 后，以及生图、Canvas 视频处于处理中时，查询响应不提供队列位置：

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

项目分镜视频的 `completion_response` 可能包含项目、集和调试上下文。该流程进入 `processing` 表示串行准备已完成，上传、参数填写、提交和轮询仍可能在独立页面继续。

### 5.3 任务不存在

```json
{
  "status": "processing",
  "message": "任务处理中或不存在",
  "completion_response": null
}
```

合法 ID 在结果和运行目录都查不到时返回上述结构。ID 需匹配 `^dramart-\d{14}-[a-z0-9]{5}$`，格式不合法会返回 `status: "error"`。调用方应使用受理返回的任务 ID，并设置最大轮询次数或总超时时间。

### 5.4 视频成功

以下为 Canvas 视频的简化响应。项目分镜视频的 `action` 为 `generate_video_project`，有准备上下文时，`debug_task_id` 由项目名和集序号组成。

```json
{
  "status": "completed",
  "result": {
    "status": "success",
    "task_id": "dramart-20260909153000-abc12",
    "debug_task_id": "dramart-20260909153000-abc12",
    "project_name": "2026-09-09",
    "episode_index": null,
    "action": "generate_video",
    "data": {
      "Status": "done",
      "debug_task_id": "dramart-20260909153000-abc12",
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

已存在终态记录，但任务失败或没有可提取的媒体地址时，此接口返回 `failed`。

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

以下命令适用于 Windows `cmd.exe`。提交前将 `https://example.com/product.jpg` 换成服务可访问的素材，查询时换成受理返回的任务 ID。

### 8.1 提交视频任务

```bat
curl -X POST "http://127.0.0.1:9091/api/ask" ^
  -H "Content-Type: application/json" ^
  -d "{\"action\":\"generate_video\",\"model\":\"Doubao-Seedance-2.0-fast\",\"prompt\":\"商品旋转展示，摄影棚光线\",\"images\":[{\"type\":\"reference_image\",\"url\":\"https://example.com/product.jpg\"}],\"resolution\":\"720p\",\"ratio\":\"16:9\",\"duration\":5,\"output_format\":\"mp4\",\"wait_for_completion\":false}"
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

示例使用 Node.js 20 或更新版本。运行前替换示例素材 URL，按业务允许的时间设置轮询截止点。

```js
const baseUrl = 'http://127.0.0.1:9091';

const askResponse = await fetch(`${baseUrl}/api/ask`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    action: 'generate_video',
    model: 'Doubao-Seedance-2.0-fast',
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
const deadline = Date.now() + 35 * 60 * 1000;

while (true) {
  if (Date.now() >= deadline) {
    throw new Error(`达到客户端轮询时限，任务 ID：${taskId}`);
  }
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

- [服务入口和请求处理](../nodejs/task-server.js) — `taskAction` 选择任务类型，`bodyToPayload` 规范化请求。
- [Canvas 视频会话](../nodejs/canvas-video-session.js)、[项目分镜视频脚本](../nodejs/prepare-video-workflow.js)和[常驻生图会话](../nodejs/image-session.js) — 对应三条生成路径。
- [本地任务数据](operations/runtime-and-data.md#数据日志与清理) — 请求、运行中记录、结果和临时素材。
