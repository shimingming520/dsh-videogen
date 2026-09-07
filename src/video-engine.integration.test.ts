import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { submitVideoTask, queryVideoTask, waitForTask } from './video-engine.ts'
import type { VideoChannel } from './video-engine.ts'
import type { GenerateVideoRequest } from './protocol.ts'

/**
 * Integration test for the OpenAI-compatible /v1/videos adapter: a local mock
 * upstream answers submit → id, poll → status, and a final video URL.
 */

let server: Server
let base = ''

const VIDEO_BYTES = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00, 0x00])

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', base)
    if (req.method === 'POST' && url.pathname === '/v1/videos') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        const parsed = JSON.parse(body) as { model?: string; prompt?: string; seconds?: number }
        if (parsed.model === 'fail-order') {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'bad model' }))
          return
        }
        expect(parsed.prompt).toBe('hello')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 'task-1' }))
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/videos/task-1') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'completed', data: [{ url: `${base}/v.mp4` }] }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4' })
      res.end(Buffer.from(VIDEO_BYTES))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    base = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : ''}`
    resolve()
  }))
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

function makeChannel(): VideoChannel {
  return {
    id: 'ch1',
    preset: 'openai-compatible',
    name: 'mock',
    apiUrl: `${base}/v1`,
    apiKey: 'key-1',
    models: [],
    authMode: 'bearer',
    custom: undefined,
  }
}

const request: GenerateVideoRequest = { mode: 'text2video', prompt: 'hello', model: 'sora-2' }

describe('OpenAI-compatible adapter end-to-end', () => {
  it('submits and polls to completion', async () => {
    const channel = makeChannel()
    const submitted = await submitVideoTask(channel, request)
    expect(submitted.ref).toBeDefined()
    expect(submitted.ref!.kind).toBe('openai')
    expect(submitted.ref!.taskId).toBe('task-1')
    const state = await queryVideoTask(channel, submitted.ref!)
    expect(state.status).toBe('completed')
    expect(state.videos).toEqual([`${base}/v.mp4`])
  })

  it('waits for completion and yields the video url', async () => {
    const channel = makeChannel()
    const submitted = await submitVideoTask(channel, request)
    const state = await waitForTask(channel, submitted.ref!, { timeoutMs: 10_000, intervalMs: 50 })
    expect(state.status).toBe('completed')
    expect(state.videos?.[0]).toBe(`${base}/v.mp4`)
  })

  it('surfaces an upstream HTTP error', async () => {
    const channel = makeChannel()
    await expect(submitVideoTask(channel, { ...request, model: 'fail-order' })).rejects.toThrow()
  })

  it('refuses to run with an empty apiUrl', async () => {
    const channel = makeChannel()
    await expect(submitVideoTask({ ...channel, apiUrl: '' }, request)).rejects.toThrow()
  })
})
