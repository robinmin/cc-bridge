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
    echo "  agents - List available agents"
    echo "  commands - List available slash commands"
    echo "  skills - List available skills"
    echo "  schedulers - List scheduled tasks"
    echo "  ws_list - List workspaces"
    echo "  ws_current - Show current workspace"
    echo "  ws_switch <name> - Switch workspace"
    echo "  ws_add <name> - Create workspace"
    echo "  ws_del <name> - Delete workspace"
    echo "  app-new <app-id> - Create mini-app markdown from template"
    echo "  app-list - List available mini-apps"
    echo "  app-run <app-id> [input] - Run mini-app by id (env: MINI_APP_CHAT_ID, MINI_APP_TIMEOUT_MS, MINI_APP_CONCURRENCY)"
    echo "  app-schedule <app-id> [once|recurring|cron] [schedule] [input] [instance] - Upsert mini-app task"
    echo "  app-list-tasks [app-id] - List scheduled mini-app tasks"
    echo "  app-unschedule --task-id <task-id> | --app-id <app-id> - Remove mini-app schedule(s)"
    echo "  clear - Clear current workspace session context"
    echo "  help   - Show this help message"
}

## command : app-new
function cmd_host_app_new() {
    local app_id="${1:-}"
    if [[ -z "$app_id" ]]; then
        echo "❌ Usage: app-new <app-id>"
        exit 1
    fi

    if [[ ! "$app_id" =~ ^[a-zA-Z0-9_-]+$ ]]; then
        echo "❌ Invalid app id: '$app_id' (allowed: letters, numbers, '-' and '_')"
        exit 1
    fi

    local template_path="src/gateway/apps/new_app_template.md"
    local target_path="src/apps/${app_id}.md"

    if [[ ! -f "$template_path" ]]; then
        echo "❌ Template not found: $template_path"
        exit 1
    fi

    if [[ -f "$target_path" ]]; then
        echo "❌ App already exists: $target_path"
        exit 1
    fi

    cp "$template_path" "$target_path"

    # Keep generated file aligned with target app id.
    sed -i '' "s/^id: new-app$/id: ${app_id}/" "$target_path"
    sed -i '' "s/^name: New Mini-App$/name: ${app_id}/" "$target_path"

    echo "✅ Created mini-app: $target_path"
}

## command : app-run
function cmd_host_app_list() {
    bun run src/gateway/apps/driver.ts list
}

## command : app-run
function cmd_host_app_run() {
    local app_id="${1:-}"
    shift || true
    local input="${*:-}"

    if [[ -z "$app_id" ]]; then
        echo "❌ Usage: app-run <app-id> [input]"
        exit 1
    fi

    if [[ -n "$input" ]]; then
        bun run src/gateway/apps/driver.ts run "$app_id" "$input"
    else
        bun run src/gateway/apps/driver.ts run "$app_id"
    fi
}

## command : app-schedule
function cmd_host_app_schedule() {
    local app_id="${1:-}"
    local schedule_type="${2:-}"
    local schedule_value="${3:-}"
    local input="${4:-}"
    local instance="${5:-}"

    if [[ -z "$app_id" ]]; then
        echo "❌ Usage: app-schedule <app-id> [once|recurring|cron] [schedule] [input] [instance]"
        exit 1
    fi

    bun run src/gateway/apps/lifecycle.ts schedule "$app_id" "$schedule_type" "$schedule_value" "$input" "$instance"
}

## command : app-list-tasks
function cmd_host_app_list_tasks() {
    local app_id="${1:-}"
    if [[ -n "$app_id" ]]; then
        bun run src/gateway/apps/lifecycle.ts list "$app_id"
    else
        bun run src/gateway/apps/lifecycle.ts list
    fi
}

## command : app-unschedule
function cmd_host_app_unschedule() {
    local flag="${1:-}"
    local value="${2:-}"

    if [[ -z "$flag" || -z "$value" ]]; then
        echo "❌ Usage: app-unschedule --task-id <task-id> | --app-id <app-id>"
        exit 1
    fi

    if [[ "$flag" != "--task-id" && "$flag" != "--app-id" ]]; then
        echo "❌ Invalid option: $flag"
        echo "   Use --task-id or --app-id"
        exit 1
    fi

    bun run src/gateway/apps/lifecycle.ts unschedule "$flag" "$value"
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
        "agents"|"commands"|"skills"|"schedulers"|"ws_list"|"ws_current"|"clear")
            bun run scripts/host_cmd.ts "$1"
            ;;
        "ws_switch"|"ws_add"|"ws_del")
            bun run scripts/host_cmd.ts "$1" "${2:-}"
            ;;
        "app-new")
            cmd_host_app_new "${2:-}"
            ;;
        "app-run")
            shift || true
            cmd_host_app_run "$@"
            ;;
        "app-list")
            cmd_host_app_list
            ;;
        "app-schedule")
            shift || true
            cmd_host_app_schedule "$@"
            ;;
        "app-list-tasks")
            cmd_host_app_list_tasks "${2:-}"
            ;;
        "app-unschedule")
            shift || true
            cmd_host_app_unschedule "$@"
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
