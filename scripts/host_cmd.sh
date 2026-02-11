#!/usr/bin/env bash
# Comprehensive commands for HostBot

###############################################################################
# Configuration
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

WORKSPACE_ROOT="${WORKSPACE_ROOT:-${HOME}/xprojects}"

## command : uptime
function cmd_host_uptime() {
    local out
    out=$(uptime)
    echo "🏠 **Host Uptime**"
    echo ""
    echo "$out"
}

## command : ps
function cmd_host_ps() {
    local out
    out=$(ps -A -o pcpu,pmem,comm | sort -k 1 -r | head -5)
    echo "📊 **Host CPU/MEM**"
    echo ""
    echo "\`\`\`"
    echo "$out"
    echo "\`\`\`"
}

## command : help
function cmd_host_help() {
    echo "Usage: host <command>"
    echo "Commands:"
    echo "  uptime - Show host uptime"
    echo "  ps     - Show top 5 processes by CPU"
    echo "  help   - Show this help message"
}

## Entry point
function host_main() {
    case "${1:-help}" in
        "uptime")
            cmd_host_uptime
            ;;
        "ps")
            cmd_host_ps
            ;;
        "help"|"--help"|"-h")
            cmd_host_help
            ;;
        *)
            echo "❌ Unknown command: $1"
            cmd_host_help
            exit 1
            ;;
    esac
}

###############################################################################

# Main
host_main "$@"
