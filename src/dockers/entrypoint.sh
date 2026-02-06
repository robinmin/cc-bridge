#!/bin/bash
set -e

echo "🚀 Starting container initialization..."

# Use a fixed path for the sync script to be robust against workspace renaming
SYNC_SCRIPT="/app/scripts/sync-plugins.sh"

if [ -f "$SYNC_SCRIPT" ]; then
    bash "$SYNC_SCRIPT"
else
    echo "⚠️ Warning: $SYNC_SCRIPT not found, skipping plugin sync."
fi

# Execute the CMD (the agent server)
echo "👾 Starting agent server..."
exec "$@"
