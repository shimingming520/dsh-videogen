---
name: dsh-videogen-storyboard
description: DSH AI 视频插件（dsh-videogen）的分镜工作室技能：manage_storyboard 基于内置分镜模板（品牌炫酷开场/产品发布/数据故事/竖版社媒/特性巡礼/版本发布高光）创建项目、编辑镜头提示词、逐一生成镜头视频并按转场合成整片；模板变量（product/features 等）用 {{var}} 填充。
whenToUse: 用户想要“一个完整的视频/宣传片/短视频”且需要多镜头、模板化、节奏编排，或提到分镜/脚本/多个镜头合成时使用。
---
# 分镜工作室

## 触发
- 用户说“做个品牌宣传片 / 产品发布视频 / 数据故事 / 竖版短视频”
- 需要把一段内容拆成多个镜头分别生成再拼接

## 流程
1. `manage_storyboard action=list_templates` 查看模板（brand-sizzle、product-launch、data-story、vertical-social、feature-orbit、release-spotlight）。
2. `action=new` 传 template_id + vars（如 `{"product":"NEON X1","style":"赛博朋克"}`）创建项目，返回项目与镜头列表。
3. 如需微调：`action=update_shot` 修改某镜头 prompt/时长/参考图。
4. `action=generate_all` 逐镜头生成（每镜头最多等 120s，未完成返回 task_id；也可只用 `generate_video` 生成后用 `attach_video` 挂到镜头）。
5. `action=compose` 把所有 ready 镜头合成一个视频（可传 transition 覆盖转场、audio_url 加背景音乐）。
6. 把合成后的同源 URL 提供给用户。

## 注意
- 逐镜生成消耗上游额度且耗时（每镜 2-10 分钟），一次 generate_all 可能超时——超时镜头保留 task_id，可用 generate_video(task_id) 查询。
- 9:16 模板适合社媒；16:9 适合演示/宣传。
