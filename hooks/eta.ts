/**
 * Speed and ETA from an exponentially smoothed rate. Pure.
 *
 * Samples are taken at the task's own `updatedAt`, not at poll time: polling a
 * file that did not change adds no sample, so an unchanged file never drags
 * the rate towards zero (a stall is shown as a stall, not as a slow ETA).
 */
import type { RateState, Task } from '../types'

/** Time constant of the EMA: a speed change is ~63 % in after 20 s. */
export const TAU_MS = 20_000

/** Feed one sample in. A counter that went backwards starts the measurement over. */
export function advance(prev: RateState | undefined, value: number, t: number): RateState {
  if (!prev || value < prev.v || t < prev.t) return { t, v: value, ema: null, t0: t, v0: value }
  const dt = t - prev.t
  if (dt <= 0) return prev
  const inst = ((value - prev.v) / dt) * 1000
  const alpha = 1 - Math.exp(-dt / TAU_MS)
  const ema = prev.ema === null ? inst : alpha * inst + (1 - alpha) * prev.ema
  return { ...prev, t, v: value, ema }
}

/** Units per second: the EMA, else the average since the first sample, else since `startedAt`. */
export function speed(state: RateState | undefined, value: number, startedAt?: number, updatedAt?: number): number | null {
  if (state?.ema !== null && state?.ema !== undefined && state.ema > 0) return state.ema
  if (state && state.t > state.t0 && state.v > state.v0) return ((state.v - state.v0) / (state.t - state.t0)) * 1000
  if (startedAt !== undefined && updatedAt !== undefined && updatedAt > startedAt && value > 0) return (value / (updatedAt - startedAt)) * 1000
  return null
}

/** The quantity an ETA is computed from: bytes when the byte total is known, else `done`. */
export function measured(task: Task): { value: number; total: number | null; unit: string } {
  if (task.bytesTotal && task.bytes !== undefined) return { value: task.bytes, total: task.bytesTotal, unit: 'bytes' }
  return { value: task.done, total: task.total, unit: task.unit }
}

/**
 * Seconds left, counting down smoothly between file updates (the time since
 * `updatedAt` is taken off). null when unknown or not meaningful.
 */
export function etaSeconds(remaining: number, perSecond: number | null, updatedAt: number, now: number): number | null {
  if (perSecond === null || !(perSecond > 0) || !(remaining > 0)) return null
  const eta = remaining / perSecond - Math.max(0, now - updatedAt) / 1000
  return Math.max(0, eta)
}

/** Rate-state keys for a task: the measured quantity, and bytes when counted alongside. */
export function rateKeys(task: Task): { main: string; bytes: string | null } {
  const m = measured(task)
  const bytesSeparate = task.bytes !== undefined && m.unit !== 'bytes' && task.unit !== 'bytes'
  return { main: task.id, bytes: bytesSeparate ? `${task.id}#bytes` : null }
}

/** Advance every task's rate state; drops states of tasks that are gone. */
export function advanceAll(prev: Readonly<Record<string, RateState>>, tasks: readonly Task[]): Record<string, RateState> {
  const next: Record<string, RateState> = {}
  for (const task of tasks) {
    const keys = rateKeys(task)
    next[keys.main] = advance(prev[keys.main], measured(task).value, task.updatedAt)
    if (keys.bytes) next[keys.bytes] = advance(prev[keys.bytes], task.bytes!, task.updatedAt)
  }
  return next
}
