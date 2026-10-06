/** A progress source as read from disk: a progress file or a watcher. */
export type Task = {
  id: string
  label: string
  icon?: string
  done: number
  /** null = unknown total → spinner */
  total: number | null
  unit: string
  bytes?: number
  bytesTotal?: number
  status: 'running' | 'done' | 'error'
  message?: string
  /** epoch ms */
  startedAt?: number
  /** epoch ms of the last real progress */
  updatedAt: number
  pid?: number
  /** seconds without an update before this task counts as stalled (overrides the setting) */
  stalledAfter?: number
  /** where it came from: a progress file or a watcher */
  source: 'file' | 'watcher'
  /** the file behind it (progress file, or the watched path) */
  path?: string
}

/** Smoothed speed of one task, for the ETA. */
export type RateState = {
  /** epoch ms of the last sample */
  t: number
  /** last value of the measured quantity */
  v: number
  /** EMA of units per second; null until two samples */
  ema: number | null
  /** epoch ms of the first sample */
  t0: number
  /** value at the first sample */
  v0: number
}

export type Layout = 'auto' | 'single' | 'stacked'

export type Prefs = {
  layout: Layout
  hidden: boolean
}

/** What the poller last saw. */
export type Snapshot = {
  tasks: Task[]
  /** pid → alive, from the last liveness check */
  alive: Record<string, boolean>
  /** task id → rate state */
  rates: Record<string, RateState>
}

/** The finish playing above the band: a task that just completed. */
export type Celebration = {
  /** the task's id, its label */
  id: string
  label: string
  /** epoch ms the show started */
  startedAt: number
  /** where its bar was in its row, [from, to) columns */
  bar: [number, number]
}

declare module 'claude-code' {
  interface PluginState {
    taskline: { snapshot: Snapshot; prefs: Prefs; celebration: Celebration | null }
  }
}
