# Mutation tests

A test that has never been seen red is not an assurance. Each guarded behaviour below had its bug put back by hand; the named suite had to fail. The probe applies a one-line replacement that must match **exactly once** (a mutation that matches nothing proves nothing), checks that the file really changed, runs the suite, and restores the file.

| File | Mutation | Suite | Result |
|---|---|---|---|
| `hooks/state.ts` | stall threshold ×10⁶ (never stalls) | node | killed |
| `hooks/state.ts` | dead pid no longer aborts | engine | killed |
| `hooks/protocol.ts` | sanitize keeps ESC and the C1 range | node | killed |
| `hooks/eta.ts` | EMA weight fixed at 0.5 instead of time-based | node | killed |
| `hooks/eta.ts` | ETA no longer counts down between writes | node | killed |
| `hooks/layout.ts` | `fitTask` ignores the width | node | killed |
| `hooks/views.ts` | expired tasks stay visible | node, engine | killed (engine only after adding the `cleanup: false` test) |
| `hooks/register.tsx` | a file caught mid-write drops its task | engine | killed (after adding the mid-write test) |
| `hooks/register.tsx` | `NO_COLOR` ignored | engine | killed |
| `hooks/register.tsx` | the band ignores a survey | engine | killed (after adding the survey test) |
| `hooks/watchers.ts` | logtail takes the first match, not the last | node | killed |
| `python/taskline.py` | rename to the wrong target (not atomic) | python | killed |
| `python/taskline.py` | Ctrl+C counted as done | python | killed |
| `python/taskline.py` | no throttling | python | killed |
| `hooks/state.ts` | a task's own `stalled_after` ignored | node | killed |
| `hooks/watchers.ts` | a watcher's `stalled_after` not passed to its task | node | killed |
| `python/taskline.py` | `Progress` drops `stalled_after` | python | killed |
| `hooks/watchers.ts` | `newestMatch` picks the oldest file | node, engine | killed |
| `hooks/watchers.ts` | `newestMatch` accepts folders | node | killed |
| `hooks/watchers.ts` | `splitGlob` accepts a glob in the folder | node | killed (after fixing the test, whose path had no glob in the file name) |
| `hooks/register.tsx` | globbed paths not resolved | engine | killed |
| `hooks/register.tsx` | a new file keeps the old run's start | engine | killed |

Three survivors in the first round were real gaps: hiding expired tasks was only covered in the node suite (the engine test passed because cleanup removed the file anyway), and neither the mid-write fallback nor the survey rule had any test. All three got one.
