#!/bin/bash
set -e

echo "🚀 Starting container initialization..."

# Check if claude CLI is available before running plugin sync
if command -v claude &> /dev/null; then
    echo "✅ Claude CLI found, running plugin sync..."
    SYNC_SCRIPT="/app/sync-plugins.sh"

    if [ -f "$SYNC_SCRIPT" ]; then
        bash "$SYNC_SCRIPT"
    else
        echo "⚠️ Warning: $SYNC_SCRIPT not found, skipping plugin sync."
    fi
else
    echo "⚠️ Claude CLI not available in container - skipping plugin sync"
    echo "   Plugins will be used from mounted host directory: ~/.claude/plugins"
fi

# Refresh discovery cache after plugins are synced
REFRESH_CACHE_SCRIPT="/app/refresh-discovery-cache.sh"

if [ -f "$REFRESH_CACHE_SCRIPT" ]; then
    bash "$REFRESH_CACHE_SCRIPT"
else
    echo "⚠️ Warning: $REFRESH_CACHE_SCRIPT not found, skipping cache refresh."
fi

# Execute the CMD (the agent server)
echo "👾 Starting agent server..."
exec "$@"
