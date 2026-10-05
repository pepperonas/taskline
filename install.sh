#!/usr/bin/env bash
# taskline installer — idempotent; run it again after moving the repo.
#
#   ./install.sh              mod + Python helper + CLI
#   ./install.sh --no-mod     only the Python helper and the CLI (for jobs)
#   ./install.sh --dry-run    show what would happen
#
# What it does (and uninstall.sh undoes, from the record it leaves):
#   1. ~/.claude/progress/ and ~/.claude/taskline/ (with an empty watchers.json)
#   2. the `taskline` CLI as a symlink in ~/.local/bin
#   3. `import taskline` for python3: a .pth file in the user site-packages
#      (venvs: `pip install -e <this repo>` inside the venv)
#   4. the mod: this folder as a local marketplace + `claude plugin install`
# It never edits settings.json by hand; the plugin CLI does that.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
STATE_DIR="$CLAUDE_DIR/taskline"
RECORD="$STATE_DIR/install-record.json"
BIN_DIR="${TASKLINE_BIN_DIR:-$HOME/.local/bin}"
PY="${PYTHON:-python3}"
MARKET="pepperonas-taskline"
DO_MOD=1 DO_PY=1 DRY=0

for arg in "$@"; do
  case "$arg" in
    --no-mod) DO_MOD=0 ;;
    --no-python) DO_PY=0 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "install.sh: unknown option $arg" >&2; exit 2 ;;
  esac
done

say() { printf '  %s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then say "would: $*"; else "$@"; fi }

echo "taskline — installing from $REPO"

# 1. directories
run mkdir -p "$CLAUDE_DIR/progress" "$STATE_DIR"
if [ ! -e "$STATE_DIR/watchers.json" ]; then
  if [ "$DRY" = 1 ]; then say "would: create $STATE_DIR/watchers.json"; else printf '{\n  "watchers": []\n}\n' > "$STATE_DIR/watchers.json"; fi
fi
say "progress files: $CLAUDE_DIR/progress"
say "watchers:       $STATE_DIR/watchers.json (examples: $REPO/examples/watchers.json)"

LINK="" PTH=""
if [ "$DO_PY" = 1 ]; then
  # 2. CLI
  run mkdir -p "$BIN_DIR"
  if [ -e "$BIN_DIR/taskline" ] && [ "$(readlink "$BIN_DIR/taskline" || true)" != "$REPO/bin/taskline" ]; then
    echo "install.sh: $BIN_DIR/taskline exists and is not ours — leaving it alone" >&2
  else
    run ln -sfn "$REPO/bin/taskline" "$BIN_DIR/taskline"
    LINK="$BIN_DIR/taskline"
    say "CLI:            $LINK"
    case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "note: $BIN_DIR is not on your PATH" ;; esac
  fi

  # 3. Python module
  if command -v "$PY" >/dev/null 2>&1; then
    SITE="$("$PY" -c 'import site; print(site.getusersitepackages() if site.ENABLE_USER_SITE else "")')"
    if [ -n "$SITE" ]; then
      run mkdir -p "$SITE"
      if [ "$DRY" = 1 ]; then say "would: write $SITE/taskline.pth"; else printf '%s\n' "$REPO/python" > "$SITE/taskline.pth"; fi
      PTH="$SITE/taskline.pth"
      say "Python:         import taskline  ($("$PY" --version 2>&1), via $PTH)"
    else
      say "Python: user site-packages disabled for $PY — use: pip install -e $REPO"
    fi
  fi
fi

# 4. the mod
MARKET_ADDED=0 PLUGIN_ADDED=0
if [ "$DO_MOD" = 1 ]; then
  if ! command -v claude >/dev/null 2>&1; then
    say "mod: the claude CLI is not on PATH — skipped (run: claude plugin marketplace add $REPO)"
  else
    if claude plugin marketplace list 2>/dev/null | grep -q "$MARKET"; then
      say "mod: marketplace $MARKET already known"
    else
      run claude plugin marketplace add "$REPO" && MARKET_ADDED=1
    fi
    if claude plugin list 2>/dev/null | grep -q "taskline@$MARKET"; then
      say "mod: taskline@$MARKET already installed"
    else
      run claude plugin install "taskline@$MARKET" && PLUGIN_ADDED=1
    fi
    say "mod: active in new sessions (or /reload-plugins in a running one)"
  fi
fi

# the record uninstall.sh reads; earlier records are merged so a re-run never forgets
if [ "$DRY" = 0 ]; then
  "$PY" - "$RECORD" "$REPO" "$LINK" "$PTH" "$MARKET_ADDED" "$PLUGIN_ADDED" <<'PYEOF'
import json, os, sys, time
path, repo, link, pth, market, plugin = sys.argv[1:]
try:
    rec = json.load(open(path))
except Exception:
    rec = {}
rec.update({"repo": repo, "installed_at": time.time()})
if link: rec["cli_link"] = link
if pth: rec["pth"] = pth
rec["marketplace_added"] = bool(rec.get("marketplace_added")) or market == "1"
rec["plugin_added"] = bool(rec.get("plugin_added")) or plugin == "1"
tmp = path + ".tmp"
json.dump(rec, open(tmp, "w"), indent=2)
os.replace(tmp, path)
PYEOF
fi

echo "done. Try: taskline set hello 3 10 --label Hello   (then: taskline done hello)"
