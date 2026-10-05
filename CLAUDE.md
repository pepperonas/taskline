# CLAUDE.md — taskline

Claude Code mod (function-hook plugin) that draws live progress of long-running jobs above the prompt. Repo `pepperonas/taskline`, local folder `~/claude/_mods/taskline` (it started as a statusLine script and was renamed — see docs/DESIGN.md). English code and docs.

## Layout
- `hooks/register.tsx` — the only file with I/O (`$.fs`, `$.process`, `$.clock`); everything else in `hooks/` is pure and unit-tested.
- `python/taskline.py` — reporting helper + CLI (stdlib only, Python ≥ 3.8); `bin/taskline` is the entry point.
- `PROTOCOL.md` — progress file format v1. Adding an optional field does not bump `v`.

## Commands
```bash
npm test                  # node suite incl. drift guards (README ↔ code)
claude plugin test .      # engine suite
python3 -m pytest tests   # python suite
claude plugin validate .
npm run screenshots       # re-render docs/*.png from hooks/layout.ts
```

## Rules
- The README's version and test-count badges, config table, command lists and protocol fields are checked by `tests/docs.spec.ts`; change them together.
- Mutate every new test once (docs/MUTATIONS.md). Run a mutant against the suite that is supposed to catch it.
- No lockfile in the repo root (`.npmrc package-lock=false`): Claude Code would install the dev tools for every user.
- Never put `options` on a `userConfig` field (the plugin directory refuses it); list choices in the description.
- Dev loading: symlink the repo into the session's `~/.claude/dev-mods/<session>/taskline` (hot reload), or `claude --plugin-dir .`.
