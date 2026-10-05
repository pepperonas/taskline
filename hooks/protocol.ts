/**
 * Reading progress files (PROTOCOL.md, v1). Pure: text in, Task or null out.
 * Anything that is not a valid task is null — a broken file never breaks the band.
 */
import type { Task } from '../types'

export const PROTOCOL_VERSION = 1
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** Files larger than this are not progress files. */
export const MAX_FILE_BYTES = 64 * 1024

const STATUSES = ['running', 'done', 'error'] as const

/** The task id of a directory entry, or null if the entry is not a progress file. */
export function idOfFile(name: string): string | null {
  if (!name.endsWith('.json')) return null
  const id = name.slice(0, -'.json'.length)
  return ID_RE.test(id) ? id : null
}

/**
 * Strip everything a terminal could interpret: C0/C1 controls, which covers
 * ESC and therefore every ANSI/OSC sequence a file might smuggle in.
 */
export function sanitize(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  // eslint-disable-next-line no-control-regex
  const text = String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()
  if (!text) return undefined
  const chars = [...text]
  return chars.length > limit ? chars.slice(0, limit).join('') : text
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const nonNeg = (v: unknown): number | undefined => (finite(v) && v >= 0 ? v : undefined)
/** Protocol times are Unix seconds; internally everything is epoch ms. */
const secondsToMs = (v: unknown): number | undefined => (finite(v) && v > 0 ? Math.round(v * 1000) : undefined)

/**
 * Parse one progress file.
 * @param id the id from the file name — it wins over any `id` inside
 * @param mtimeMs the file's mtime, used when `updated_at` is missing
 */
export function parseTask(text: string, id: string, mtimeMs: number, path?: string): Task | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.v !== undefined && !(finite(o.v) && o.v >= 1)) return null
  const done = nonNeg(o.done)
  if (done === undefined) return null

  const total = finite(o.total) && o.total > 0 ? o.total : null
  const status = STATUSES.includes(o.status as never) ? (o.status as Task['status']) : 'running'
  const updatedAt = secondsToMs(o.updated_at) ?? mtimeMs
  const task: Task = {
    id,
    label: sanitize(o.label, 40) ?? id,
    done,
    total,
    unit: sanitize(o.unit, 16) ?? 'items',
    status,
    updatedAt,
    source: 'file',
  }
  const icon = sanitize(o.icon, 2)
  if (icon) task.icon = icon
  const bytes = nonNeg(o.bytes)
  if (bytes !== undefined) task.bytes = bytes
  const bytesTotal = nonNeg(o.bytes_total)
  if (bytesTotal) task.bytesTotal = bytesTotal
  const message = sanitize(o.message, 200)
  if (message) task.message = message
  const startedAt = secondsToMs(o.started_at)
  if (startedAt) task.startedAt = startedAt
  if (Number.isInteger(o.pid) && (o.pid as number) > 0) task.pid = o.pid as number
  if (finite(o.stalled_after) && o.stalled_after > 0) task.stalledAfter = o.stalled_after
  if (path) task.path = path
  return task
}
