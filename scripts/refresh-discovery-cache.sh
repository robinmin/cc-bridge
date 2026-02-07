#!/bin/bash
set -e

echo "🔄 Refreshing discovery cache..."

# Run the discovery cache refresh via bun
# Scripts are mounted at /app/scripts and also available via relative path from workspace
bun run -e /app/scripts/refresh-discovery-cache.ts

echo "✅ Discovery cache refreshed"
