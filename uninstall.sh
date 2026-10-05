#!/usr/bin/env bash
# taskline uninstaller — undoes exactly what install.sh recorded.
#
#   ./uninstall.sh            remove mod, CLI link and Python path; keep your data
#   ./uninstall.sh --purge    also delete ~/.claude/progress and ~/.claude/taskline
#   ./uninstall.sh --dry-run  show what would happen
set -euo pipefail

CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
STATE_DIR="$CLAUDE_DIR/taskline"
RECORD="$STATE_DIR/install-record.json"
MARKET="pepperonas-taskline"
PURGE=0 DRY=0
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) echo "uninstall.sh: unknown option $arg" >&2; exit 2 ;;
  esac
done
say() { printf '  %s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then say "would: $*"; else "$@"; fi }
field() { python3 -c 'import json,sys; v=json.load(open(sys.argv[1])).get(sys.argv[2]); print("" if v in (None, False) else v)' "$RECORD" "$1" 2>/dev/null || true; }

if [ ! -f "$RECORD" ]; then
  echo "uninstall.sh: no install record at $RECORD — nothing that install.sh did to undo" >&2
  [ "$PURGE" = 1 ] || exit 1
fi

echo "taskline — uninstalling"
if [ -f "$RECORD" ]; then
  REPO="$(field repo)"
  if [ "$(field plugin_added)" = "True" ] && command -v claude >/dev/null 2>&1; then
    run claude plugin uninstall "taskline@$MARKET" || say "plugin already gone"
  fi
  if [ "$(field marketplace_added)" = "True" ] && command -v claude >/dev/null 2>&1; then
    run claude plugin marketplace remove "$MARKET" || say "marketplace already gone"
  fi
  LINK="$(field cli_link)"
  if [ -n "$LINK" ] && [ -L "$LINK" ] && [ "$(readlink "$LINK")" = "$REPO/bin/taskline" ]; then
    run rm -f "$LINK"; say "removed $LINK"
  fi
  PTH="$(field pth)"
  if [ -n "$PTH" ] && [ -f "$PTH" ] && [ "$(cat "$PTH")" = "$REPO/python" ]; then
    run rm -f "$PTH"; say "removed $PTH"
  fi
  run rm -f "$RECORD"
fi

if [ "$PURGE" = 1 ]; then
  run rm -rf "$CLAUDE_DIR/progress" "$STATE_DIR"
  say "purged $CLAUDE_DIR/progress and $STATE_DIR"
else
  say "kept your data: $CLAUDE_DIR/progress, $STATE_DIR (--purge removes them)"
fi
echo "done."
