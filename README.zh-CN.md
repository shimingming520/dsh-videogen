# 🎬 dsh-videogen

**DeepSeek Harness（DSH）的 AI 视频生成与处理插件** —— 把 DSH Web GUI 变成视频工作室：多渠道文生/图生视频、FFmpeg 处理（抽帧 / GIF / 压缩 / 合成）与提示词驱动的分镜工作室，侧边栏面板与 Agent 均可使用。

[简体中文](README.zh-CN.md) | [English](README.md)

![license](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)
![DSH plugin](https://img.shields.io/badge/DSH-plugin-brightgreen?style=flat-square)
![Node](https://img.shields.io/badge/node-%3E%3D20-blue?style=flat-square)

## ✨ 功能

- **多渠道视频生成集中管理**：OpenAI 兼容 `/v1/videos`（Sora 规格、中转友好）、可灵 Kling（文生/图生视频，JWT 或 Bearer）、海螺 MiniMax（任务 + 文件检索）、即梦/火山 ARK（豆包 Seedance）与完全自定义的通用异步渠道（提交 URL、请求体模板 `{{prompt}} {{model}} {{image}} {{duration}}…`、轮询 URL 模板、状态/结果取值路径）—— 想配几个配几个
- **密钥只存本机**：API 密钥存于本地 DSH 设置文档；所有上游请求由本地宿主代理转发；浏览器与 Agent 永不接触明文凭据
- **FFmpeg 处理**（宿主侧，整合 dsh-video-tools 能力集）：`info` 探测、`frames` 抽帧（等间隔或指定时间）、`gif` 转 GIF（两遍调色板）、`compress` 图片压缩、`concat` 多段合成（转场 + 背景音乐）
- **分镜工作室**：6 个内置电影感分镜模板（品牌炫酷开场 / 产品发布 / 数据故事 / 竖版社媒 / 特性巡礼 / 版本发布高光），支持 `{{变量}}` 填充；逐镜头通过渠道生成，再用 FFmpeg 按转场合成整片
- **Agent 工具**：`generate_video`（文生/图生视频，等待或按 `task_id` 查询）、`video_process`、`search_video_library`、`manage_storyboard`；附随包技能（`/video:gen`、`/video:process`、`/video:storyboard`）
- **历史 + 资源库**：任务全部记录在 `~/.dsh/dsh-videogen/`；生成视频同源缓存；可选自动入库（含完整出处）
- **提示词增强**：用 Agent 默认模型把粗略想法改写成可直接生成的描述（无额外密钥）

## 📦 安装

DSH 宿主（Node ≥ 20）。

```sh
dsh plugin --profile web add dsh-videogen
```

本地开发安装：

```sh
dsh plugin --profile web add /path/to/dsh-videogen
```

重启 `dsh web` 后侧边栏出现 **AI 视频** 入口。

## 🚀 快速开始

1. 打开 **设置 → 插件 → AI 视频**
2. 添加渠道：选预设提供方（+ 添加提供方）或 + 添加自定义提供方
3. 填写 API 地址、API 密钥（可灵支持 `AccessKey:SecretKey` 自动 JWT 签名）与模型目录 —— 可点「获取可用模型」导入
4. 保存后打开 **AI 视频** 侧边栏面板：生成（文生/图生/✨ 增强）、处理、工作室（模板 → 镜头 → 合成）、资源库

## 🎛 渠道

| 预设 | 提交 | 轮询 | 鉴权 |
| --- | --- | --- | --- |
| OpenAI 兼容 | `POST {base}/videos` | `GET /videos/{id}` | Bearer |
| 可灵 Kling | `POST /v1/videos/text2video` / `image2video` | `GET …/{task_id}` | Bearer Token **或** `AccessKey:SecretKey` → HMAC-SHA256 JWT |
| 海螺 MiniMax | `POST /v1/video_generation/v1` / `image_to_video/v1` | 任务轮询 + `/v1/files/retrieve/{file_id}` | Bearer（GroupId 可在 apiUrl 带 `?GroupId=`） |
| 即梦/火山 ARK | `POST …/contents/generations/tasks` | `GET …/tasks/{id}` | Bearer |
| 自定义通用 | 自配 `submitUrl` + `bodyTemplate` | `pollUrlTemplate` | 可配请求头与方案 |

## 🤖 Agent 使用

| 工具 | 用途 |
| --- | --- |
| `generate_video` | 提交文生/图生视频任务（或按 `task_id` 查询）；默认等待完成并返回同源视频 URL |
| `video_process` | FFmpeg 处理：对 URL 或 `ws:<workspaceId>/<path>` 文件执行 `info` / `frames` / `gif` / `compress` / `concat` |
| `manage_storyboard` | `list_templates` / `new` / `get` / `update_shot` / `attach_video` / `compose` / `generate_all` |
| `search_video_library` | 检索并复用已生成/入库的视频 |

随包技能的会话命令示例：

```text
/video:gen        霓虹城市电影感画面，镜头推近，9:16
/video:process    从生成的视频中抽 4 帧
/video:storyboard 为 NEON X1 制作 15 秒产品发布视频
```

## 🔐 安全与数据说明

- API 密钥存于本地 DSH 设置文档；请求由本地宿主代理转发（`/api/dsh-videogen/*`，仅回环路由）
- 生成消耗上游 API 额度；视频内容由上游模型生成
- 历史、缓存视频、处理输出与分镜项目存于 `~/.dsh/dsh-videogen/`
- FFmpeg 解析顺序：`FFMPEG_PATH` → 随包 `@ffmpeg-installer/ffmpeg` → 系统 PATH 的 `ffmpeg` → `ffmpeg-static`；都没有时用 `brew install ffmpeg` 安装
- 提示词增强调用你选择的 LLM 模型（默认：Agent 默认模型），无额外 API key

## 🧪 开发

```sh
pnpm install
pnpm run typecheck   # tsc --noEmit
pnpm run test        # vitest run
pnpm run build       # tsdown → lib/index.js + lib/client.js
```
