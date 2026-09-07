---
name: dsh-videogen-generate
description: DSH AI 视频插件（dsh-videogen）的视频生成技能：确认渠道/模型后用 generate_video 提交文生/图生视频任务（mode=text2video/image2video），默认等待完成并返回同源视频 URL；支持多厂商渠道（OpenAI 兼容 /v1/videos、可灵 Kling、海螺 MiniMax、即梦/火山 ARK、自定义通用异步渠道）；传 task_id 可查询已提交任务。
whenToUse: 用户提出生成视频、短视频、文生/图生视频、TTV/I2V，或触发 /video:gen 时使用；先确认配置的视频渠道与模型。
---
# 视频生成

## 触发
- `/video:gen <描述>`
- 用户说“生成一段视频 / 做个短片 / 文生视频 / 图生视频”

## 参数
- prompt: 必填，视频描述（场景、主体、镜头运动、风格）
- mode: `text2video`（默认）/ `image2video`
- channel: 渠道名/id；多个渠道时先问用户或显式传
- model: 渠道目录中的模型别名
- image: 图生视频参考图（http(s) URL / data URL / `ws:<workspaceId>/<path>`）
- negative_prompt / aspect_ratio（16:9、9:16、1:1…）/ duration / resolution / seed
- enhance_prompt: 用 Agent 默认模型增强提示词（无额外密钥）
- wait / wait_seconds: 默认等待完成（240s 上限 900s）；超时后返回 task_id
- task_id: 传它则查询已提交任务，不再新提交

## 流程
1. 确认已配置视频渠道（设置 → 插件 → AI 视频）。
2. 多个渠道/模型时先询问用户，或让用户给 channel/model。
3. 调用 `generate_video`（默认等待，返回同源视频 URL）。
4. 若返回 `status: processing`，告知用户稍候，可再用 task_id 查询；把完成的视频 URL 提供给用户播放/下载。

## 渠道说明
| 预设 | 协议 | 密钥 |
| --- | --- | --- |
| OpenAI 兼容 | POST /v1/videos + GET /v1/videos/{id} 轮询 | Bearer |
| 可灵 Kling | POST /v1/videos/text2video|image2video + 轮询 | Bearer Token 或 `AccessKey:SecretKey`（自动 JWT 签名） |
| 海螺 MiniMax | POST /v1/video_generation/v1（/v1/image_to_video/v1）+ 轮询 + /v1/files/retrieve | Bearer（GroupId 附在 apiUrl `?GroupId=`） |
| 即梦/火山 ARK | POST /contents/generations/tasks + GET 轮询 | Bearer |
| 自定义通用 | submitUrl/bodyTemplate/taskIdPath/pollUrlTemplate/statusPath/doneValues/resultUrlPath | 可配头与方案 |

## 提示
- 生成消耗上游额度；视频由上游模型生成；只能在配置目录中选择模型。
- 参考图是本地工作区文件时用 `ws:<workspaceId>/<path>` 引用（即梦/可灵等要求在请求中有公开 URL 的厂商可能拒 data URL，需用户提供图床 URL）。
