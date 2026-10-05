/** What a task is right now, whether it shows, and in which order. Pure. */
import type { Task } from '../types'

export type Phase = 'running' | 'stalled' | 'aborted' | 'done' | 'error'

/** Timings, all in seconds. */
export type Timing = {
  /** no update for this long while running → stalled */
  stalledAfter: number
  /** a done task shows this long */
  doneVisible: number
  /** an error or aborted task shows this long */
  errorVisible: number
}

export const DEFAULT_TIMING: Timing = { stalledAfter: 60, doneVisible: 10, errorVisible: 3600 }

/**
 * @param alive whether the task's pid is alive; undefined = not known (no pid,
 *   or the liveness check is not available on this surface)
 */
export function phaseOf(task: Task, now: number, timing: Timing, alive: boolean | undefined): Phase {
  if (task.status === 'done') return 'done'
  if (task.status === 'error') return 'error'
  if (task.pid !== undefined && alive === false) return 'aborted'
  if (now - task.updatedAt > (task.stalledAfter ?? timing.stalledAfter) * 1000) return 'stalled'
  return 'running'
}

/** Whether a task in this phase still shows. Running and stalled always do. */
export function isVisible(task: Task, phase: Phase, now: number, timing: Timing): boolean {
  const since = (now - task.updatedAt) / 1000
  if (phase === 'done') return since < timing.doneVisible
  if (phase === 'error' || phase === 'aborted') return since < timing.errorVisible
  return true
}

const RANK: Record<Phase, number> = { error: 0, aborted: 1, stalled: 2, running: 3, done: 4 }

/**
 * Problems first (they need you), then what runs, then what just finished.
 * Within a phase, the oldest start first, so a row does not jump around.
 */
export function compareTasks(a: { task: Task; phase: Phase }, b: { task: Task; phase: Phase }): number {
  const rank = RANK[a.phase] - RANK[b.phase]
  if (rank !== 0) return rank
  const start = (a.task.startedAt ?? a.task.updatedAt) - (b.task.startedAt ?? b.task.updatedAt)
  if (start !== 0) return start
  return a.task.id < b.task.id ? -1 : a.task.id > b.task.id ? 1 : 0
}

/** Pids worth a liveness check: running tasks that named one. */
export function pidsToCheck(tasks: readonly Task[]): number[] {
  return [...new Set(tasks.filter(t => t.status === 'running' && t.pid !== undefined).map(t => t.pid!))]
}
