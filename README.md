# Seedance 视频生成任务

本地 Node 程序，用于接入火山方舟视频生成任务接口：创建任务、查询单个任务、查询任务列表。

## 启动

```bash
npm install
npm start
```

启动后会自动打开：

```text
http://localhost:3000
```

## 支持模型

```text
doubao-seedance-2-5-260628
doubao-seedance-2-0-260128
doubao-seedance-2-0-fast-260128
doubao-seedance-2-0-mini-260615
```

## 图片输入

页面支持直接上传多张参考图片。创建任务时会在浏览器本地压缩并转成 Base64，然后作为 `content[].image_url.url` 传给火山方舟接口。

默认图片角色是 `reference_image`，也可以在页面切换为 `first_frame` 或 `last_frame`。

## API Key 配置

可以直接在页面填写并保存到浏览器本地存储。

也可以复制 `api-keys.example.json` 为 `api-keys.json`，按模型填写不同 Key：

```json
{
  "doubao-seedance-2-5-260628": "你的 API Key",
  "doubao-seedance-2-0-260128": "你的 API Key",
  "doubao-seedance-2-0-fast-260128": "你的 API Key",
  "doubao-seedance-2-0-mini-260615": "你的 API Key"
}
```

`api-keys.json` 已加入 `.gitignore`，不会被提交。

## 环境变量

可选：

```text
PORT=3000
NO_OPEN=1
ARK_API_KEY=通用 API Key
```

也支持按模型配置环境变量，例如：

```text
ARK_API_KEY_DOUBAO_SEEDANCE_2_5_260628=你的 API Key
```
