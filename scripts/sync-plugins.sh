#!/bin/bash
set -e

# Marketplaces to ensure are added
MARKETPLACES=(
    "anthropic-ai/claude-plugins-official"
    "cc-agents/cc-agents"
)

# Plugins to ensure are installed
PLUGINS=(
    "superpowers@claude-plugins-official"
    "rd2@cc-agents"
    "wt@cc-agents"
    "typescript-lsp@claude-plugins-official"
)

echo "🔄 Syncing Claude Code plugins..."

# 1. Add Marketplaces
for source in "${MARKETPLACES[@]}"; do
    echo "🌐 Adding marketplace $source..."
    claude plugin marketplace add "$source" || echo "   (Skipped/Already exists)"
done

# 2. Sync Plugins
for plugin in "${PLUGINS[@]}"; do
    echo "📦 Syncing $plugin..."
    # Always try to enable first (fast)
    if claude plugin enable "$plugin" 2>/dev/null; then
        echo "   ✅ Enabled $plugin"
    else
        echo "   📥 Installing $plugin..."
        claude plugin install "$plugin" || echo "   ❌ Failed to install $plugin"
    fi
done

echo "✅ Plugin sync complete!"

# 3. Sync MCP Servers
echo "🔌 Syncing MCP Servers..."

# Function to safely add an MCP server (removes stale config first)
add_mcp() {
    local name=$1
    shift
    echo "   🔌 Syncing MCP $name..."
    # Force remove if exists to update command/registry
    claude mcp remove "$name" 2>/dev/null || true
    # Use yes | to skip interactive confirmation if it exists
    yes | claude mcp add "$name" "$@"
}

# Register requested MCPs
add_mcp "shadcn" -- bunx shadcn@latest mcp
add_mcp "ref" -- bunx ref-tools-mcp@latest
add_mcp "grep" --transport http https://mcp.grep.app
add_mcp "brave-search" -- bunx @modelcontextprotocol/server-brave-search
add_mcp "huggingface" --transport http https://huggingface.co/mcp

# Optional MCP: auggie-mcp (can fail to connect when not configured)
if [[ "${AUGGIE_MCP_ENABLED:-false}" == "true" ]]; then
    add_mcp "auggie-mcp" -- bunx @aj47/auggie-mcp --mcp
else
    echo "   ⏭️ Skipping MCP auggie-mcp (set AUGGIE_MCP_ENABLED=true to enable)"
    # Remove stale config to avoid failed health checks
    claude mcp remove "auggie-mcp" 2>/dev/null || true
fi

echo "✅ MCP sync complete!"
claude mcp list
claude plugin list
