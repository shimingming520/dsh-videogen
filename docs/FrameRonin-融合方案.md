# dsh-videogen × FrameRonin 能力融合方案（V1 · 评审稿）

> 状态：**评审稿，未实施**（本文件仅为方案存档，尚未改动任何源码）。
> 参考对象：<https://github.com/systemchester/FrameRonin>（README / `DEV_DOC_video2timesheet.md` / `DEV_PLAN_extensions.md` / 源码目录树）
> 本地对象：dsh-videogen（`src/index.ts`、`process-engine.ts`、`agent-video-tools.ts`、`protocol.ts`、`routes-process.ts`、`video-store.ts`、`client/VideoGenPanel.tsx`）

---

## 一、FrameRonin 是什么

FrameRonin（内部名 PixelWork）是一个**面向像素美术 / 2D 游戏 Sprite 的「视频与序列帧处理工具集」**，V3 形态为「React+Vite 纯前端 SPA + 可选 Python FastAPI / Redis Worker 后端」。

| 模块 | 能力 | 实现方式 |
| --- | --- | --- |
| 视频转序列帧 | 上传视频 → 抽帧 → 抠图 → 合成 **Sprite Sheet** + 索引 JSON | 前端色度键（Canvas）或后端 rembg/U2Net（约 176MB 模型）+ FFmpeg + Pillow |
| GIF ↔ 序列帧 | GIF 拆帧、序列帧转 GIF、多图合一、单图按行/列网格拆分 | 纯前端 gifuct-js / gifenc |
| Sprite Sheet / 调整 | Sheet 拆帧、勾选、动画预览、按偏移重排后重组合导出 | 纯前端 Canvas |
| 像素图片处理 | 缩放 / 内描边 / 裁切 / 色度键抠图（绿幕蓝幕）/ 连通域抠图（容差+羽化）/ 像素化 / 扩缩图 | 纯前端 Canvas + OpenCV.js（连通域）+ FFT 插帧 |
| 其他 | Gemini 水印去除、Seedance 视频水印去除、RPGMAKER 布局一键处理、nanobanana 生成、RoninPro（NFT 门槛） | 外链 / 本地后端 / 需登录 |

**核心产品闭环**：视频 → PNG 帧（RGBA）→ 抠图透明化 → Sprite Sheet（PNG + `index.json`），
其中 `index.json` 契约：

```json
{
  "version": "1.0",
  "frame_size": {"w": 256, "h": 256},
  "sheet_size": {"w": 3072, "h": 2048},
  "frames": [
    {"i": 0, "x": 0, "y": 0, "w": 256, "h": 256, "t": 0.000},
    {"i": 1, "x": 256, "y": 0, "w": 256, "h": 256, "t": 0.083}
  ]
}
```

关键参数（DEV_DOC 定义，建议直接沿用）：`fps`、`frame_range`(起止秒/帧号)、`max_frames`(≤2000)、`target_size`、`bg_color`、`transparent`、`padding`、`spacing`、`layout_mode`(fixed_columns|auto_square)、`columns`、`matte_strength`、`crop_mode`(none|tight_bbox|safe_bbox)。

**定位差异**：FrameRonin 是「消费已有素材做像素级后处理」的工具集；dsh-videogen 是「AI 生成 + FFmpeg 通用处理 + 分镜」的生成工作台。两者不重叠，**融合点是 FrameRonin 的「视频转序列帧、抠图、Sprite Sheet」闭环能力**。

---

## 二、dsh-videogen 现状与差距

现状（已核对源码）：

- `process-engine.ts` 仅 `info / frames / gif / compress / concat` 五个 FFmpeg action；
- `frames` 抽帧为 **JPEG 缩略图**（1–20 张、上限 20、`count` 钳制 1..20），无 PNG 序列、无帧时间戳索引；
- 无抠图（色度键 / 连通域 / AI）、无 Sprite Sheet 合成与拆分、无 GIF↔帧、无像素化 / 批量图像处理；
- Agent 工具：`generate_video` / `video_process` / `manage_storyboard` / `search_video_library`；
- 面板：Generate / Process / Studio / Library 四个 Tab；
- 资源与持久化：`~/.dsh/dsh-videogen/`（videos / output / library / projects）、同源路由 `/api/dsh-videogen/assets/{videos|output|library}`、历史任务、资源库、prompt 增强，全部可复用。

**结论：底子好，能力面缺 FrameRonin 的核心闭环**。

---

## 三、融合定位与总体原则

不做 Page 式复刻（不引入 Python / Redis / 静态站），把 FrameRonin 的「视频 / 序列帧 / 像素预处理」能力吸收为 dsh-videogen 的 **host 侧本地图像管线 + 面板新 Tab + Agent 新工具**，并与现有生成、分镜、资源库打通：

1. **全部本地执行**：FFmpeg（已有）+ **sharp**（libvips）做图像底层；抠图算法（连通域 / 色度键 / 调色板量化）在 Node 内自写；无新增在线 API、无密钥。
2. **AI 抠图为可选增强**：`@imgly/background-removal`（ONNX + U2Net/ISNet，等价 FrameRonin 后端 rembg 路径），首次运行下载模型（约 176MB），不安装不影响色度键 / 连通域通道。
3. **输出同源 URL 约定**：产物（PNG 帧 / ZIP / Sheet / GIF）写 `~/.dsh/dsh-videogen/output`，经 `/api/dsh-videogen/assets/` 播放 / 下载，可入库（library）与历史。
4. **复用 FrameRonin 接口契约**：`index.json` 字段与 DEV_DOC 参数名直接沿用，未来可对接其生态与教程。

---

## 四、功能模块清单（分层）

### P0 核心闭环：视频转序列帧 + 抠图 + Sheet（1–2 周）

| 模块 | 说明 | 关键参数 |
| --- | --- | --- |
| `extract` 视频→PNG 序列 | FFmpeg 输出无损 PNG 帧（可带 rgba 通道）；按 fps / frame_range / max_frames 采样；输出 ZIP（PNG + index.json） | fps(0.2–60)、start / end、max_frames(≤2000)、format、width |
| `matte` 抠图 | 三通道：① 色度键（ffmpeg `chromakey`/`colorkey` + `despill` + alpha `gblur` 羽化）；② 连通域去背（边缘 BFS + 容差 + 羽化，对齐「容差 80 / 羽化 5」）；③ 可选 AI（imgly） | mode=chroma\|component\|ai、color、tolerance、feather |
| `sheet` 序列帧合成 | 固定列数 / 自适应方形布局，间距 / 边距、背景透明或 #RRGGBB；输出 Sheet PNG + index.json；预留「镜像帧 / 偏移重排」参数 | columns、spacing、padding、bg、layout_mode |
| `sheet_split` Sheet 拆分 | 按列×行或单帧尺寸拆成单帧 PNG + ZIP（对应 FrameRonin F1） | cols / rows 或 frame_w / frame_h |
| `gif_frames` GIF→帧 · `frames_gif` 帧→GIF | GIF 拆帧保留帧序（ffmpeg 解码）；帧→GIF 复用现有 palette 两遍法，支持逐帧 delay | fps、width、delay |

### P1 像素工具（1 周）——对应 FrameRonin 图片处理区

| 模块 | 说明 |
| --- | --- |
| `pixelate` 像素化 | 就近缩图 + 调色板量化（16 / 32 / 256 色，Median Cut）+ 可选 Floyd–Steinberg 抖动；输出像素风 PNG |
| `trim` / `resize` / `crop` 标准化 | 按 alpha bbox 裁边（tight / safe）、统一尺寸、pad 透明 / 背景色（对齐 crop_mode / target_size） |
| `batch` 批量图像处理 | 多图统一执行缩放 / 裁切 / 抠图 / 描边（对齐 F4）；分帧或 ZIP 输出 |
| `info` / `compress` | 复用现有；`compress` 升级支持 PNG / 保留 alpha |

### P2 体验与工程（1 周）

- 长任务进度：进程内任务队列 + `GET /jobs/{id}` 轮询（对齐 FrameRonin B4 体验，不引入 Redis）；
- 参数预设（256×256 像素风、RPGMAKER 4 行 5 列等，作为 `sheet`/`pixelate` 的 preset 模板）；
- i18n（zh / en）、vitest 管线测试（`ffmpeg -f lavfi testsrc` 生成小样本）、文档与版本 0.1.0 → 0.2.0。

### 明确不入列（及理由）

| 项 | 理由 |
| --- | --- |
| Gemini / Seedance 水印去除 | 需内容修复类算法（修补 / 生成模型），涉版权与合规；与「上游生成无痕」定位冲突。仅 P2 后单独评估 |
| RPGMAKER 布局一键处理 | 垂直预设，以 `sheet` 的 preset 模板低成本实现，不作独立模块 |
| RoninPro / NFT / nanobanana 生成 | 依赖外部登录与业务系统，与 DSH 插件无关 |
| Redis 队列 / WebSocket 全量重写 | 进程内队列足够；WS 仅在确有需要时升级 |
| 大图分块合成（B5） | 作为 P1 `sheet` 的实现细节（128 帧分批 + 流式写盘），不单独立项 |

---

## 五、落地方案（改哪些文件、怎么改）

### 5.1 新增 host 引擎 `src/frame-engine.ts`

- 纯 Node + sharp + ffmpeg；自写像素算法（连通域去背、8 邻域 BFS、Median Cut 量化）。
- 复用 `process-engine.ts` 的 `run()` / `probeInfo()` 与 `video-store.ts` 的 `PROCESS_OUTPUT_DIR` / `safeName`。

### 5.2 协议扩展 `src/protocol.ts`

```ts
type FrameAction =
  | 'extract' | 'matte' | 'sheet' | 'sheet_split'
  | 'gif_frames' | 'frames_gif' | 'pixelate' | 'trim' | 'batch'

interface FrameResult {
  frames?: Array<{ file: string; name: string; index: number; time?: number }>
  sheet?: { file: string; url?: string; indexJson?: string }
  zip?: { file: string; url?: string; bytes: number }
  output?: { file: string; url?: string; bytes: number; mime: string }
  error?: string
}

export const FRAME_API = '/api/dsh-videogen/frame/run' as const
```

- 校验：action 白名单、参数范围钳制（同 DEV_DOC 限制：帧数 ≤ 2000、Sheet 边 ≤ 16384、上传 ≤ 768MB）。
- `index.json` 字段与 FrameRonin 一致（version / frame_size / sheet_size / frames[{i,x,y,w,h,t}]）。

### 5.3 新增路由 `src/routes-frame.ts`

- `POST FRAME_API`：`readJsonBody` → action 分发 → `runFrameAction` → 输出映射为同源 URL。
- 复用 `routes-process.ts` 的 `resolveInput`（支持 `/api/dsh-videogen/assets/`、http(s) URL、`ws:<workspaceId>/<path>`、绝对路径、cwd 相对路径）与 `methodGuard` / `writeJson`。
- 在 `index.ts` 的 `makeRoutes` 列表追加（或 `sctx.effect` 内 `ctx.webServer.register`）。

### 5.4 Agent 工具 `src/agent-video-tools.ts`

- **新增 `frame_process` 工具**（独立工具而非塞进 `video_process`：语义、参数、超时差异大；`video_process` 保持完全向后兼容）。
  - 参数：action、input / inputs、fps、start、end、max_frames、matte_mode、color、tolerance、feather、columns、spacing、bg、pixel_size、palette、dither、width、format、preset。
  - 输出：同源 URL（frames / sheet / zip / output）。
  - `timeoutMs`：放开至 900s（对齐 `generate_video` 的 660s 档位）。
- `search_video_library` 增加 `type: 'frames' | 'sheet'` 过滤（protocol 的 `LIBRARY_TYPES` 同步扩展）。
- `manage_storyboard` / 生成流程：分镜 `generate_all` 完成后可提供「镜头视频 → 帧 → Sheet」一键链（可选，P1）。

### 5.5 设置与权限（`src/index.ts`）

- Config 增加 `allowFrameProcessing: boolean`（默认 true）；`announceToAgent` 门控内新增 tool 注册；`VIDEOGEN_GUIDANCE` 补一句能力描述（序列帧 / 抠图 / Sprite Sheet）。

### 5.6 Client（`src/client/`）

- `src/protocol.ts` 的 `LIBRARY_TYPES` 增加 `'frames' | 'sheet'`；面板「序列帧」Tab：
  - 来源：视频 / GIF / Sheet / 单图 / 资源库 / 工作区上传；
  - 参数三步流：抽帧（fps / 范围 / 最大帧数）→ 抠图（模式 / 容差 / 羽化 / 颜色）→ 合成（列数 / 布局 / 间距 / 背景）；
  - 预览：网格缩略图、勾选帧、A/D 切帧、播放预览（对齐 FrameThumbnails / FrameAnimationPreview）；
  - 导出：PNG 帧（ZIP）/ Sheet / GIF。
- `locales.ts` 补齐 zh / en 文案；AI 抠图开关（首次提示模型下载约 176MB）。

### 5.7 技能与文档

- 新增 `skills/frame-process/SKILL.md`：说明 `frame_process` 各 action、index.json、示例命令
  （如「将视频第 2–6 秒以 12fps 抽帧并抠绿幕，合成 256×256 的 12 列 Sprite Sheet」）。
- 更新 `README.md` / `README.zh-CN.md`、`package.json` 描述关键字与版本。

### 5.8 依赖

| 依赖 | 类型 | 说明 |
| --- | --- | --- |
| `sharp` | 新增（常规） | libvips 图像底层（缩放 / 合成 / raw 像素读取 / alpha 分离），macOS / Linux 有 prebuilt |
| `fflate` | 新增（常规） | ZIP 打包，零依赖 |
| `@imgly/background-removal` | 可选 | AI 抠图（ONNX），动态加载 + 失败降级色度键 |
| `@ffmpeg-installer/ffmpeg` 等 | 已有 | 不动 |

---

## 六、里程碑

| 阶段 | 内容 | 预计 |
| --- | --- | --- |
| M1 | `extract`（PNG 序列 + ZIP + index）+ `gif_frames` + `sheet` + `sheet_split` + 面板「序列帧」Tab 骨架 | 3–5 天 |
| M2 | 抠图三通道（色度键 / 连通域 / 可选 AI）+ `trim/padding` + 网格预览与 A/D 切帧 | 3–5 天 |
| M3 | `pixelate` + `frames_gif` + `batch` + 预设 + 库 / 历史打通（frames / sheet 入库） | 3–5 天 |
| M4 | 长任务进度 + i18n + vitest 管线测试 + 文档 + 发布 0.2.0 | 2–3 天 |

最小闭环（M1 + M2 的「色度键 + 连通域」通道）：**视频 → PNG 序列 → 抠图 → Sheet + index.json**，约 1–2 周。

---

## 七、风险与注意

1. **依赖体积**：sharp 原生包约 30MB（常规）；AI 抠图模型 176MB 首跑下载，必须显式可选项并提示。
2. **内存 / 大任务**：按 DEV_DOC 限制（≤2000 帧、Sheet 边 ≤ 16384），合成按 128 帧分批、流式写盘；超限报错并建议降参。
3. **FFmpeg 滤镜兼容**：`chromakey` / `despill` / `alphamerge` 依赖 libavfilter 版本，失败自动降级为连通域通道。
4. **合规**：FrameRonin 仓库**未发现 LICENSE 文件**——仅将其视作行为与接口规格参考（DEV_DOC），**不直接移植其代码**，算法独立实现，避免版权风险。
5. **向后兼容**：`video_process` / `generate_video` / `manage_storyboard` 的既有参数与输出约定一律不动；新能力全部走 `frame_process`；`LIBRARY_TYPES` 扩展只增不减。
6. **测试**：管线函数的单测（参数解析、布局坐标、index 正确性）+ 集成测试（合成小样本视频跑全链路），对齐现有 `process-engine.test.ts` 的写法。

---

## 八、结论

**推荐方案：在 dsh-videogen 内新增独立的「帧工坊（Frame Workshop）」能力面**——

- host 侧：`src/frame-engine.ts`（FFmpeg + sharp + 自写像素算法）+ `src/routes-frame.ts`；
- Agent 侧：新增 `frame_process` 工具 + `skills/frame-process` 技能 + guidance 更新；
- Client 侧：面板新增「序列帧」Tab（来源 → 参数 → 预览 → 导出），库类型扩展 `frames` / `sheet`；
- 交付节奏：P0（抽帧 / 抠图 / Sheet 闭环）→ P1（像素化 / 批处理）→ P2（体验 / 工程）；
- 明确不纳入：水印去除（合规与算法成本）、RoninPro / NFT / nanobanana（外部生态）。

该方案吸收 FrameRonin 的核心产品闭环（视频转序列帧、抠图、Sprite Sheet、GIF↔帧），不引入 Python / Redis / 静态站运维负担，且与现有生成、分镜、资源库无缝衔接——**投入产出比最高、风险最低**。

---

*文档版本：V1（评审稿）· 生成日期：2026-09-07 · 未实施任何代码改动*
