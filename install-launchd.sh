#!/usr/bin/env bash
# install-launchd.sh
#
# Installs and starts the always-on Babylon MCP agent as a macOS LaunchAgent.
# Run once from the repo root:
#
#   bash install-launchd.sh
#
# To stop and uninstall:
#
#   launchctl unload ~/Library/LaunchAgents/com.dannywalter.babylon-always-on.plist
#   rm ~/Library/LaunchAgents/com.dannywalter.babylon-always-on.plist

set -euo pipefail

PLIST_SRC="$(cd "$(dirname "$0")" && pwd)/launchd/com.dannywalter.babylon-always-on.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/com.dannywalter.babylon-always-on.plist"
LOG_DIR="$(cd "$(dirname "$0")" && pwd)/logs"
LABEL="com.dannywalter.babylon-always-on"

echo "==> Creating log directory: $LOG_DIR"
mkdir -p "$LOG_DIR"

echo "==> Copying plist to $PLIST_DEST"
mkdir -p "$HOME/Library/LaunchAgents"
cp "$PLIST_SRC" "$PLIST_DEST"

# Unload first if an older version is already loaded, to avoid "already loaded" errors
if launchctl list | grep -q "$LABEL" 2>/dev/null; then
  echo "==> Unloading existing agent..."
  launchctl unload "$PLIST_DEST"
fi

echo "==> Loading agent..."
launchctl load "$PLIST_DEST"

echo ""
echo "Done. Agent is running."
echo ""
echo "Useful commands:"
echo "  Check status:  launchctl list | grep babylon-always-on"
echo "  Tail logs:     tail -f $LOG_DIR/always-on-agent.log"
echo "  Tail errors:   tail -f $LOG_DIR/always-on-agent.error.log"
echo "  Stop:          launchctl unload $PLIST_DEST"
echo "  Restart:       launchctl unload $PLIST_DEST && launchctl load $PLIST_DEST"
