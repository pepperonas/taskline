/** From what the poller saw to what the band draws, and what may be cleaned up. Pure. */
import type { Snapshot, Task } from '../types'
import { etaSeconds, measured, rateKeys, speed } from './eta'
import type { TaskView } from './layout'
import { compareTasks, isVisible, phaseOf } from './state'
import type { Timing } from './state'

const aliveOf = (s: Snapshot, t: Task) => (t.pid === undefined ? undefined : s.alive[String(t.pid)])

/** The visible tasks, sorted, with phase, speed and ETA. */
export function buildViews(s: Snapshot, now: number, timing: Timing): TaskView[] {
  const views: TaskView[] = []
  for (const task of s.tasks) {
    const phase = phaseOf(task, now, timing, aliveOf(s, task))
    if (!isVisible(task, phase, now, timing)) continue
    const keys = rateKeys(task)
    const m = measured(task)
    const sp = speed(s.rates[keys.main], m.value, task.startedAt, task.updatedAt)
    const bytesSpeed = keys.bytes ? speed(s.rates[keys.bytes], task.bytes ?? 0, task.startedAt, task.updatedAt) : null
    const eta = phase === 'running' && m.total !== null ? etaSeconds(m.total - m.value, sp, task.updatedAt, now) : null
    views.push({ task, phase, speed: sp, bytesSpeed, eta })
  }
  return views.sort(compareTasks)
}

/**
 * Progress files that are finished and past their display time: done after
 * `doneVisible`, error and aborted after `errorVisible`. Watchers own no file
 * and are never cleaned up.
 */
export function expiredFiles(s: Snapshot, now: number, timing: Timing): Task[] {
  return s.tasks.filter(task => {
    if (task.source !== 'file' || !task.path) return false
    const phase = phaseOf(task, now, timing, aliveOf(s, task))
    if (phase === 'running' || phase === 'stalled') return false
    return !isVisible(task, phase, now, timing)
  })
}

/** Whether anything visible moves on its own (spinner, countdown, ages). */
export function isAnimated(views: readonly TaskView[]): boolean {
  return views.some(v => v.phase === 'running' || v.phase === 'stalled')
}
