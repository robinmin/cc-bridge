#!/bin/bash
# =============================================================================
# Claude Code Stop Hook Installation Script
# =============================================================================
# This script installs the Stop Hook into Claude's configuration.
# The hook runs after each Claude execution to notify the Gateway.
#
# Usage:
#   ./scripts/install-hooks.sh
# =============================================================================

set -euo pipefail

# Configuration
HOOK_DIR="${HOME}/.claude/hooks"
HOOK_CONFIG="${HOOK_DIR}/stop.json"
HOOK_SCRIPT="/app/scripts/stop-hook.sh"

echo "=== Installing Claude Code Stop Hook ==="
echo ""

# Create hooks directory if it doesn't exist
echo "Creating hooks directory: ${HOOK_DIR}"
mkdir -p "${HOOK_DIR}"

# Check if hook script exists
if [ ! -f "${HOOK_SCRIPT}" ]; then
    echo "ERROR: Hook script not found at ${HOOK_SCRIPT}"
    echo "Please ensure the stop-hook.sh script is installed."
    exit 1
fi

# Make hook script executable
echo "Making hook script executable..."
chmod +x "${HOOK_SCRIPT}"

# Write hook configuration
echo "Writing hook configuration to ${HOOK_CONFIG}"
cat > "${HOOK_CONFIG}" <<'EOF'
{
  "hooks": {
    "stop": [
      {
        "name": "gateway-callback",
        "command": "/app/scripts/stop-hook.sh",
        "enabled": true,
        "async": true
      }
    ]
  }
}
EOF

# Verify the configuration
echo ""
echo "Verifying hook configuration..."
if command -v jq &> /dev/null; then
    if jq empty "${HOOK_CONFIG}" 2>/dev/null; then
        echo "✓ Hook configuration is valid JSON"
    else
        echo "✗ Hook configuration is invalid JSON"
        cat "${HOOK_CONFIG}"
        exit 1
    fi
else
    echo "⚠ jq not found - skipping JSON validation"
fi

echo ""
echo "=== Stop Hook Installed Successfully ==="
echo ""
echo "Hook Configuration:"
echo "  - Location: ${HOOK_CONFIG}"
echo "  - Script: ${HOOK_SCRIPT}"
echo "  - Mode: async (non-blocking)"
echo ""
echo "The hook will automatically run after each Claude execution."
echo "To disable, set 'enabled': false in ${HOOK_CONFIG}"
