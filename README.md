# 🎬 dsh-videogen

**AI video generation + processing for DeepSeek Harness (DSH)** — turn your DSH web GUI into a video studio: multi-vendor text-to-video / image-to-video channels, FFmpeg processing (frames / GIF / compress / concat) and a prompt-driven storyboard studio, from the sidebar panel or straight from the Agent.

[简体中文](README.zh-CN.md) | [English](README.md)

![license](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)
![DSH plugin](https://img.shields.io/badge/DSH-plugin-brightgreen?style=flat-square)
![Node](https://img.shields.io/badge/node-%3E%3D20-blue?style=flat-square)

## ✨ Features

- **Multi-vendor video channels in one place**: OpenAI-compatible `/v1/videos` (Sora spec, gateway-friendly), Kling (`text2video` / `image2video`, JWT or Bearer), MiniMax Hailuo (task + file retrieve), Volcengine ARK (Doubao Seedance) and a fully custom generic async channel (submit URL, body template with `{{prompt}} {{model}} {{image}} {{duration}} …`, poll URL template, status/result paths) — add as many as you need
- **Keys stay local**: API keys live in the local DSH settings document and every upstream call is proxied by the local host; the browser and the Agent never touch plaintext credentials
- **FFmpeg processing** (host-side, reusing the dsh-video-tools feature set): `info` probe, `frames` extraction (evenly spaced or at a timestamp), `video_to_gif` (two-pass palette), `image_compress`, and `concat` with crossfade + background music
- **Storyboard studio**: six bundled cinematic shot templates (brand sizzle, product launch, data story, vertical social, feature orbit, release spotlight) with `{{variable}}` slots; generate every shot through the configured channel, then compose the whole board into one video with FFmpeg
- **Agent tools**: `generate_video` (text2video / image2video, wait or query by `task_id`), `video_process`, `search_video_library`, `manage_storyboard` — plus bundled session skills (`/video:gen`, `/video:process`, `/video:storyboard`)
- **History + resource library**: every task recorded under `~/.dsh/dsh-videogen/`, generated videos cached same-origin, optional auto-save to the library with full provenance
- **Prompt enhancement**: rewrite a rough idea into a ready-to-generate description with the agent default model (no extra key)

## 📦 Installation

DSH host (Node ≥ 20) required.

```sh
dsh plugin --profile web add dsh-videogen
```

Local development install:

```sh
dsh plugin --profile web add /path/to/dsh-videogen
```

Restart `dsh web` — the sidebar shows the **AI Video** entry.

## 🚀 Quick start

1. Open **Settings → Plugins → AI Video**
2. Add a channel: pick a preset provider (`+ Add provider`) or `+ Add custom provider`
3. Fill in the API URL, API key (Kling accepts `AccessKey:SecretKey` for JWT signing), and the model catalog — use *Fetch available models* to import them
4. Save, then open the **AI Video** sidebar panel: Generate tab (text2video / image2video, ✨ enhance), Process tab, Studio tab (templates → shots → compose) and Library tab

## 🎛 Channels

| Preset | Submit | Poll | Auth |
| --- | --- | --- | --- |
| OpenAI-compatible | `POST {base}/videos` | `GET /videos/{id}` | Bearer |
| Kling | `POST /v1/videos/text2video` / `image2video` | `GET …/{task_id}` | Bearer token **or** `AccessKey:SecretKey` → HMAC-SHA256 JWT |
| MiniMax Hailuo | `POST /v1/video_generation/v1` / `image_to_video/v1` | task poll + `/v1/files/retrieve/{file_id}` | Bearer (+ `?GroupId=` on apiUrl) |
| Volcengine ARK | `POST …/contents/generations/tasks` | `GET …/tasks/{id}` | Bearer |
| Custom generic | your `submitUrl` + `bodyTemplate` | `pollUrlTemplate` | configurable header/scheme |

## 🤖 Agent usage

| Tool | Purpose |
| --- | --- |
| `generate_video` | Submit a text2video/image2video task (or query by `task_id`); waits by default and returns same-origin video URLs |
| `video_process` | FFmpeg processing: `info` / `frames` / `gif` / `compress` / `concat` on URLs or `ws:<workspaceId>/<path>` files |
| `manage_storyboard` | `list_templates` / `new` / `get` / `update_shot` / `attach_video` / `compose` / `generate_all` |
| `search_video_library` | Find and reuse previously generated/saved videos |

Typical session commands (skills bundled with the plugin):

```text
/video:gen        Cinematic shot of a neon-lit city, camera dolly-in, 9:16
/video:process    Extract 4 frames from the generated video
/video:storyboard Make a 15s product launch video for NEON X1
```

## 🔐 Security & data notes

- API keys are stored in the local DSH settings document; requests are proxied by the local host (`/api/dsh-videogen/*`, loopback-only routes)
- Generation consumes your upstream provider quota; video content is produced by the upstream model
- History, cached videos, processing outputs and storyboard projects persist under `~/.dsh/dsh-videogen/`
- FFmpeg is resolved in order: `FFMPEG_PATH` → bundled `@ffmpeg-installer/ffmpeg` → system `ffmpeg` on PATH → `ffmpeg-static`; install via `brew install ffmpeg` if none exist
- Prompt enhancement calls the LLM model you chose (default: agent default model) — no extra API key

## 🧪 Development

```sh
pnpm install
pnpm run typecheck   # tsc --noEmit
pnpm run test        # vitest run
pnpm run build       # tsdown → lib/index.js + lib/client.js
```
