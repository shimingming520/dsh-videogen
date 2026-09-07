---
name: dsh-videogen-process
description: DSH AI 视频插件（dsh-videogen）的 FFmpeg 处理技能：video_process 对视频/图片执行 info（探测元数据）、frames（抽帧）、gif（转 GIF）、compress（图片压缩）、concat（多段合成）；输入支持同源视频 URL、http(s) URL、ws:<workspaceId>/<path> 与绝对路径。
whenToUse: 用户要求抽帧、截图、视频转 GIF、压缩图片、拼接视频、了解视频信息时使用；可配合 dsh-video-tools 的语义（video_info/video_frames/video_to_gif/image_compress 均对应 video_process 的 action）。
---
# 视频处理

## 触发
- 用户说“抽帧 / 截图 / 转 GIF / 压缩图片 / 拼接视频 / 看看这个视频的参数”
- 需要对已生成视频做二次处理时

## 参数（video_process）
- action: `info` | `frames` | `gif` | `compress` | `concat`
- input: info/frames/gif/compress 的输入（URL / ws: 引用 / 绝对路径）
- inputs: concat 的片段列表（按顺序）
- count（frames 抽帧数 1-20 默认 1）/ at（单帧时间秒）
- width（输出宽度）/ quality（JPEG 质 1-31，低更清晰）
- start（gif 开始秒）/ duration（gif 时长 / concat 每段裁切）/ fps（gif 默认 10）
- transition（concat 交叉淡化秒数，0=硬切）/ audio_url（concat 背景音乐 URL）

## 流程
1. 确定输入：生成结果给出的是同源 URL，直接可用；工作区文件用 `ws:<workspaceId>/<path>`。
2. 调用 `video_process`。
3. 把返回的同源 URL（帧为多张图片 URL，concat/gif/compress 为单个文件 URL）提供给用户。

## 与 dsh-video-tools 映射
| dsh-video-tools | videogen |
| --- | --- |
| video_info | video_process action=info |
| video_frames | video_process action=frames（count/at） |
| image_compress | video_process action=compress |
| video_to_gif | video_process action=gif |
| —（新增） | video_process action=concat（+转场/背景音乐） |
