/**
 * Shared helpers for the /api/dsh-videogen route family.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { SettingsConflictError, type SettingsDescriptor } from '@deepseek-ai/dsh-settings'

const MAX_JSON_BODY_BYTES = 16 * 1024 * 1024

export function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

export function ensureLoopback(request: IncomingMessage): void {
  if (!isLoopbackRequest(request)) throw new Error('settings bridge is loopback-only')
}

/** Reject a request with a 405 unless it carries the expected HTTP method. */
export function methodGuard(req: IncomingMessage, res: ServerResponse, method: 'GET' | 'POST' | 'PUT' | 'DELETE'): boolean {
  if (req.method === method) return true
  writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: `expected ${method}` })
  return false
}

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

export async function readJsonBody(req: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > maxBytes) return undefined
    chunks.push(buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function toView(descriptor: SettingsDescriptor): Record<string, unknown> {
  return {
    ns: String(descriptor.ns),
    schema: descriptor.schema,
    value: descriptor.value,
    ...(descriptor.base === undefined ? {} : { base: descriptor.base }),
    ...(descriptor.user === undefined ? {} : { user: descriptor.user }),
    ...(descriptor.secrets === undefined ? {} : {
      secrets: descriptor.secrets.map(secret => ({ path: [...secret.path], set: secret.set })),
    }),
    revision: descriptor.revision,
  }
}

export function failureOf(error: unknown): { ok: false; code: string; message: string } {
  if (error instanceof SettingsConflictError) {
    return { ok: false, code: 'settings-conflict', message: error.message }
  }
  return { ok: false, code: 'video-error', message: messageOf(error) }
}
