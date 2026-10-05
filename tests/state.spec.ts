import { test } from 'node:test'
import assert from 'node:assert/strict'

import { compareTasks, DEFAULT_TIMING, isVisible, phaseOf, pidsToCheck } from '../hooks/state.ts'
import { buildViews, expiredFiles, isAnimated } from '../hooks/views.ts'
import type { Snapshot, Task } from '../types/index.d.ts'

const NOW = 1_000_000_000
const task = (over: Partial<Task> = {}): Task => ({
  id: 't', label: 't', done: 1, total: 10, unit: 'files', status: 'running', updatedAt: NOW, source: 'file', path: '/p/t.json', ...over,
})

test('phases: running, stalled after the threshold, aborted when the pid is dead', () => {
  assert.equal(phaseOf(task(), NOW, DEFAULT_TIMING, undefined), 'running')
  assert.equal(phaseOf(task({ updatedAt: NOW - 60_000 }), NOW, DEFAULT_TIMING, undefined), 'running')
  assert.equal(phaseOf(task({ updatedAt: NOW - 60_001 }), NOW, DEFAULT_TIMING, undefined), 'stalled')
  assert.equal(phaseOf(task({ pid: 9 }), NOW, DEFAULT_TIMING, false), 'aborted')
  assert.equal(phaseOf(task({ pid: 9 }), NOW, DEFAULT_TIMING, undefined), 'running') // liveness unknown
  assert.equal(phaseOf(task({ pid: 9, updatedAt: NOW - 120_000 }), NOW, DEFAULT_TIMING, true), 'stalled')
})

test('done and error beat everything, a dead pid included', () => {
  assert.equal(phaseOf(task({ status: 'done', pid: 9 }), NOW, DEFAULT_TIMING, false), 'done')
  assert.equal(phaseOf(task({ status: 'error', pid: 9 }), NOW, DEFAULT_TIMING, false), 'error')
})

test('the stall threshold is configurable', () => {
  assert.equal(phaseOf(task({ updatedAt: NOW - 11_000 }), NOW, { ...DEFAULT_TIMING, stalledAfter: 10 }, undefined), 'stalled')
})

test('visibility: done for doneVisible, error and aborted for errorVisible, running always', () => {
  assert.ok(isVisible(task({ updatedAt: NOW - 9_000 }), 'done', NOW, DEFAULT_TIMING))
  assert.ok(!isVisible(task({ updatedAt: NOW - 10_000 }), 'done', NOW, DEFAULT_TIMING))
  assert.ok(isVisible(task({ updatedAt: NOW - 3_599_000 }), 'error', NOW, DEFAULT_TIMING))
  assert.ok(!isVisible(task({ updatedAt: NOW - 3_600_000 }), 'aborted', NOW, DEFAULT_TIMING))
  assert.ok(isVisible(task({ updatedAt: 0 }), 'stalled', NOW, DEFAULT_TIMING))
})

test('order: problems first, then running by start, done last', () => {
  const v = (id: string, phase: any, startedAt: number) => ({ task: task({ id, startedAt }), phase })
  const sorted = [v('d', 'done', 1), v('r2', 'running', 5), v('s', 'stalled', 9), v('r1', 'running', 2), v('e', 'error', 9), v('a', 'aborted', 9)]
    .sort(compareTasks)
    .map(x => x.task.id)
  assert.deepEqual(sorted, ['e', 'a', 's', 'r1', 'r2', 'd'])
})

test('only running tasks with a pid are liveness-checked, each pid once', () => {
  assert.deepEqual(pidsToCheck([task({ pid: 1 }), task({ pid: 1 }), task({ pid: 2, status: 'done' }), task()]), [1])
})

const snap = (tasks: Task[], alive: Record<string, boolean> = {}): Snapshot => ({ tasks, alive, rates: {} })

test('buildViews hides expired tasks and computes the ETA only while running', () => {
  const views = buildViews(
    snap([
      task({ id: 'run', done: 50, total: 100, startedAt: NOW - 10_000 }),
      task({ id: 'old', status: 'done', updatedAt: NOW - 20_000 }),
      task({ id: 'stuck', updatedAt: NOW - 120_000, startedAt: NOW - 200_000 }),
    ]),
    NOW,
    DEFAULT_TIMING,
  )
  assert.deepEqual(views.map(v => v.task.id), ['stuck', 'run'])
  const run = views.find(v => v.task.id === 'run')!
  assert.equal(run.speed, 5)
  assert.equal(run.eta, 10)
  assert.equal(views.find(v => v.task.id === 'stuck')!.eta, null)
})

test('expiredFiles: past their display time, files only, never running', () => {
  const tasks = [
    task({ id: 'done-old', status: 'done', updatedAt: NOW - 11_000 }),
    task({ id: 'done-new', status: 'done', updatedAt: NOW - 1_000 }),
    task({ id: 'err-old', status: 'error', updatedAt: NOW - 4_000_000 }),
    task({ id: 'dead-old', pid: 7, updatedAt: NOW - 4_000_000 }),
    task({ id: 'stalled', updatedAt: NOW - 9_000_000 }),
    task({ id: 'watch', status: 'done', updatedAt: NOW - 11_000, source: 'watcher' }),
  ]
  assert.deepEqual(expiredFiles(snap(tasks, { 7: false }), NOW, DEFAULT_TIMING).map(t => t.id), ['done-old', 'err-old', 'dead-old'])
})

test('isAnimated only while something runs or stalls', () => {
  assert.equal(isAnimated(buildViews(snap([task()]), NOW, DEFAULT_TIMING)), true)
  assert.equal(isAnimated(buildViews(snap([task({ status: 'done' })]), NOW, DEFAULT_TIMING)), false)
})
