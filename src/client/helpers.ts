/**
 * Shared panel helpers.
 */

import { en, zh, type VideoGenKey } from './locales.ts'

export type TranslateValues = Record<string, string | number>

export function dictionary(): Record<string, string> {
  const lang = typeof document !== 'undefined' ? document.documentElement.lang : 'zh'
  return lang.toLowerCase().startsWith('en') ? { ...en } : { ...zh }
}

export function tt(key: VideoGenKey, values?: TranslateValues): string {
  const text = dictionary()[key] ?? key
  if (values === undefined) return text
  let rendered = text
  for (const [name, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(`{${name}}`, String(value))
  }
  return rendered
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
