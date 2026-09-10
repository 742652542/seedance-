# Seedance 视频生成任务

本地 Node 程序，用于接入火山方舟视频生成任务接口：创建任务、查询单个任务、查询任务列表。

## 安装 Node.js 环境

项目要求 Node.js 20 或更高版本，推荐使用 Node.js 20。

### 方法一：使用仓库内置的 Windows 便携版

仓库的 `vendor/node-v20.20.2-win-x64.zip` 适用于 64 位 Windows，无需安装：

1. 解压 `vendor/node-v20.20.2-win-x64.zip`。
2. 将解压后的目录加入系统 `Path`，或者直接在该目录中运行 `node.exe` 和 `npm.cmd`。
3. 重新打开命令提示符并检查版本：

```cmd
node -v
npm -v
```

`node -v` 应输出 `v20.20.2`。如果不想修改系统 `Path`，可在项目根目录中直接执行：

```cmd
vendor\node-v20.20.2-win-x64\npm.cmd ci
vendor\node-v20.20.2-win-x64\npm.cmd run start:node-task
```

注意：需要先将 ZIP 解压到 `vendor\node-v20.20.2-win-x64\`，不能直接从压缩包中运行。

### 方法二：从 Node.js 官网安装

从 [Node.js 官网](https://nodejs.org/) 下载并安装 Node.js 20 的 Windows x64 版本。安装完成后重新打开命令提示符并检查：

```cmd
node -v
npm -v
```

## 安装项目依赖

进入项目根目录后执行：

```cmd
npm ci
```

`npm ci` 会根据 `package-lock.json` 安装项目锁定的依赖版本，主要包括：

- `express`：提供 HTTP API 服务。
- `open`：自动打开本地网页。
- `puppeteer-core`：连接并控制已有的 Chromium 浏览器。

如果删除了 `package-lock.json`，才使用：

```cmd
npm install
```

安装完成后会生成 `node_modules/`。该目录已被 Git 忽略，不需要提交到仓库。

## 启动

### 启动火山方舟网页服务

```bash
npm start
```

启动后会自动打开：

```text
http://localhost:3000
```

### 启动 Dramart 自动化任务服务

```cmd
npm run start:node-task
```

默认服务地址：

```text
http://127.0.0.1:9093
```

Dramart 自动化服务还需要本地浏览器配置管理程序和可登录的 Dramart 账号，详细接口及配置说明参见 `docs/task-api.md`。

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
