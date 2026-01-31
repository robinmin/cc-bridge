#!/bin/bash
# Comprehensive health check for cc-bridge system
# Shows detailed info only for components with issues

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration
CC_BRIDGE_CMD="${CC_BRIDGE_CMD:-./.venv/bin/cc-bridge}"
PROJECT_ROOT="/Users/robin/xprojects/cc-bridge"
CONFIG_FILE="$HOME/.claude/bridge/config.toml"
INSTANCES_FILE="$HOME/.claude/bridge/instances.json"
TMUX_SOCKET="$HOME/.claude/bridge/tmux.sock"
SERVER_URL="${CC_BRIDGE_SERVER_URL:-http://localhost:8080}"
LOG_FILE="$HOME/.claude/bridge/logs/bridge.log"

# Load .env if it exists
if [ -f "$PROJECT_ROOT/.env" ]; then
    export $(grep -v '^#' "$PROJECT_ROOT/.env" | xargs) >/dev/null 2>&1 || true
fi

# Activate Python virtual environment (for tomllib support)
if [ -f "$PROJECT_ROOT/.venv/bin/activate" ]; then
    source "$PROJECT_ROOT/.venv/bin/activate"
fi

# Counters
OK_COUNT=0
WARN_COUNT=0
ERROR_COUNT=0

# Helper functions
log_ok() {
    echo -e "${GREEN}✓${NC} $1"
    ((OK_COUNT++)) || true
}

log_warn() {
    echo -e "${YELLOW}⚠${NC} $1"
    ((WARN_COUNT++)) || true
}

log_error() {
    echo -e "${RED}✗${NC} $1"
    ((ERROR_COUNT++)) || true
}

log_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

log_section() {
    echo ""
    echo -e "${CYAN}━━━ $1 ━━━${NC}"
}

# Check functions
check_env_vars() {
    log_section "Environment Variables"
    
    # Required
    echo -n "TELEGRAM_BOT_TOKEN: "
    if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
        log_ok "Set"
    else
        log_error "MISSING (Required for gateway server)"
    fi

    echo -n "Anthropic Auth: "
    if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
        log_ok "ANTHROPIC_API_KEY set"
    elif [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ]; then
        log_ok "ANTHROPIC_AUTH_TOKEN set"
    else
        log_warn "MISSING (Set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN for docker instances)"
    fi

    echo -n "ANTHROPIC_BASE_URL: "
    if [ -n "${ANTHROPIC_BASE_URL:-}" ]; then
        log_info "Set to ${ANTHROPIC_BASE_URL}"
    else
        log_info "Not set (default: https://api.anthropic.com)"
    fi

    # Optional
    echo -n "PROJECT_NAME: "
    if [ -n "${PROJECT_NAME:-}" ]; then
        log_info "Set to ${PROJECT_NAME}"
    else
        log_info "Not set (default: cc-bridge)"
    fi
}

check_config_files() {
    log_section "Configuration Files"
    
    echo -n ".env file: "
    if [ -f "$PROJECT_ROOT/.env" ]; then
        log_ok "Found"
    else
        log_warn "Not found (using system env vars)"
    fi

    echo -n "Config file (TOML): "
    if [ -f "$CONFIG_FILE" ]; then
        if python3 -c "import tomllib; tomllib.load(open('$CONFIG_FILE', 'rb'))" 2>/dev/null; then
            log_ok "Valid ($CONFIG_FILE)"
        else
            log_error "Invalid TOML syntax ($CONFIG_FILE)"
        fi
    else
        log_error "Not found ($CONFIG_FILE)"
    fi

    echo -n "Instances database: "
    if [ -f "$INSTANCES_FILE" ]; then
        if python3 -c "import json; json.load(open('$INSTANCES_FILE'))" 2>/dev/null; then
            INSTANCE_COUNT=$(python3 -c "import json; print(len(json.load(open('$INSTANCES_FILE')).get('instances', {})))")
            log_ok "Found $INSTANCE_COUNT instance(s)"
        else
            log_error "Invalid JSON ($INSTANCES_FILE)"
        fi
    else
        log_warn "Not found (will be created on first instance)"
    fi
}

check_connectivity() {
    log_section "External Services Connectivity"
    
    echo -n "Telegram API: "
    if curl -s --connect-timeout 5 https://api.telegram.org >/dev/null 2>&1; then
        log_ok "Reachable"
    else
        log_error "Unreachable (Check internet/proxy)"
    fi

    echo -n "Anthropic API: "
    ANTHROPIC_URL="${ANTHROPIC_BASE_URL:-https://api.anthropic.com}"
    if curl -s --connect-timeout 5 "${ANTHROPIC_URL}/v1/messages/count" -H "x-api-key: test" >/dev/null 2>&1 || [ $? -eq 22 ]; then
        # HTTP 401/403 is fine, it means we reached the server
        log_ok "Reachable (${ANTHROPIC_URL})"
    else
        log_error "Unreachable (${ANTHROPIC_URL})"
    fi
}

check_server() {
    log_section "Gateway Server Status"

    echo -n "Server endpoint: "
    if curl -s -f --connect-timeout 3 "$SERVER_URL/health" >/dev/null 2>&1; then
        RESPONSE=$(curl -s "$SERVER_URL/health")
        if echo "$RESPONSE" | grep -q '"status":"healthy"'; then
            log_ok "Running ($SERVER_URL)"

            # Parse and display detailed health info
            VERSION=$(echo "$RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin).get('version', 'unknown'))" 2>/dev/null)
            UPTIME=$(echo "$RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin).get('uptime_seconds', 0))" 2>/dev/null)
            PENDING=$(echo "$RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin).get('pending_requests', 0))" 2>/dev/null)
            INST_TOTAL=$(echo "$RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin).get('instances', {}).get('total', 0))" 2>/dev/null)
            INST_RUNNING=$(echo "$RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin).get('instances', {}).get('running', 0))" 2>/dev/null)
            INST_TMUX=$(echo "$RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin).get('instances', {}).get('tmux', 0))" 2>/dev/null)
            INST_DOCKER=$(echo "$RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin).get('instances', {}).get('docker', 0))" 2>/dev/null)

            # Format uptime
            if [ -n "$UPTIME" ] && [ "$UPTIME" != "0" ]; then
                UPTIME_INT=${UPTIME%.*}
                HOURS=$((UPTIME_INT / 3600))
                MINUTES=$(((UPTIME_INT % 3600) / 60))
                SECONDS=$((UPTIME_INT % 60))
                if [ "$HOURS" -gt 0 ]; then
                    UPTIME_FMT="${HOURS}h ${MINUTES}m ${SECONDS}s"
                elif [ "$MINUTES" -gt 0 ]; then
                    UPTIME_FMT="${MINUTES}m ${SECONDS}s"
                else
                    UPTIME_FMT="${SECONDS}s"
                fi
                log_info "Version: ${VERSION}, Uptime: ${UPTIME_FMT}"
            fi

            # Show instance summary
            if [ "$INST_TOTAL" -gt 0 ]; then
                log_info "Instances: ${INST_RUNNING}/${INST_TOTAL} running (tmux: ${INST_TMUX}, docker: ${INST_DOCKER})"
            fi

            # Warn if there are pending requests
            if [ "$PENDING" -gt 0 ]; then
                log_warn "Pending requests: $PENDING"
            fi
        else
            log_warn "Unhealthy response"
        fi
    else
        log_error "Not responding ($SERVER_URL)"
    fi

    echo -n "Telegram webhook: "
    if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
        WEBHOOK_INFO=$(curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo" 2>/dev/null)
        if echo "$WEBHOOK_INFO" | grep -q '"ok":true'; then
            WEBHOOK_URL=$(echo "$WEBHOOK_INFO" | python3 -c "import sys, json; print(json.load(sys.stdin)['result'].get('url', 'Not set'))" 2>/dev/null)
            PENDING_UPDATES=$(echo "$WEBHOOK_INFO" | python3 -c "import sys, json; print(json.load(sys.stdin)['result'].get('pending_update_count', 0))" 2>/dev/null)
            
            if [ "$WEBHOOK_URL" == "Not set" ] || [ "$WEBHOOK_URL" == "" ]; then
                log_warn "Webhook is NOT SET"
            else
                log_ok "Registered ($WEBHOOK_URL)"
                if [ "$PENDING_UPDATES" -gt 0 ]; then
                    log_warn "Pending updates: $PENDING_UPDATES"
                fi
            fi
        else
            log_error "Failed to get webhook info"
        fi
    else
        log_info "Skipped (Token missing)"
    fi

    # Cloudflared tunnel status
    echo -n "Cloudflared: "
    if command -v cloudflared >/dev/null 2>&1; then
        CLOUDFLARED_PID=$(pgrep -f "cloudflared" 2>/dev/null | head -1)
        if [ -n "$CLOUDFLARED_PID" ]; then
            # Get tunnel info if possible
            CLOUDFLARED_CMD=$(ps -p "$CLOUDFLARED_PID" -o args= 2>/dev/null | head -1)
            if echo "$CLOUDFLARED_CMD" | grep -q "tunnel"; then
                log_ok "Running (PID: $CLOUDFLARED_PID)"

                # Verify webhook URL is reachable through tunnel
                if [ -n "$WEBHOOK_URL" ] && [ "$WEBHOOK_URL" != "Not set" ]; then
                    echo -n "Tunnel connectivity: "
                    # Extract base URL from webhook URL (remove /webhook path)
                    TUNNEL_BASE_URL=$(echo "$WEBHOOK_URL" | sed 's|/webhook$||')
                    if curl -s -f --connect-timeout 5 "$TUNNEL_BASE_URL/health" >/dev/null 2>&1; then
                        log_ok "Reachable ($TUNNEL_BASE_URL)"
                    else
                        log_warn "Not reachable externally ($TUNNEL_BASE_URL)"
                    fi
                fi
            else
                log_ok "Running (PID: $CLOUDFLARED_PID)"
            fi
        else
            log_error "Not running (webhook will not receive updates)"
        fi
    else
        log_error "Not installed (https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/)"
    fi
}

check_resource_lists() {
    log_section "Active Resource Lists"
    
    # Tmux Sessions
    echo -e "${MAGENTA}Tmux Sessions:${NC}"
    if [ -S "$TMUX_SOCKET" ]; then
        SESSIONS=$(tmux -S "$TMUX_SOCKET" ls 2>/dev/null | grep -v "failed to connect" || true)
        if [ -n "$SESSIONS" ]; then
            printf "  %-20s %-10s %-20s\n" "SESSION NAME" "WINDOWS" "CREATED"
            printf "  %-20s %-10s %-20s\n" "------------" "-------" "-------"
            echo "$SESSIONS" | while read -r line; do
                SESSION_NAME=$(echo "$line" | cut -d: -f1)
                WINDOWS=$(echo "$line" | grep -o '[0-9]* windows' | cut -d' ' -f1)
                CREATED=$(echo "$line" | sed 's/.*(\(.*\))/\1/')
                printf "  %-20s %-10s %-20s\n" "$SESSION_NAME" "$WINDOWS" "$CREATED"
            done
        else
            echo "  (No sessions running)"
        fi
    else
        echo "  (Socket not found at $TMUX_SOCKET)"
    fi

    echo ""
    # Docker Containers
    echo -e "${MAGENTA}Docker Instances (for ${PROJECT_NAME:-cc-bridge}):${NC}"
    if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
        # Try docker compose first
        CONTAINERS=$(docker ps --filter "name=claude-${PROJECT_NAME:-cc-bridge}" --filter "label=cc-bridge.instance" --format "table {{.Names}}\t{{.Status}}\t{{.Image}}" 2>/dev/null || true)
        
        # Fallback to broader label filter if nothing found with name
        if [ -z "$(echo "$CONTAINERS" | tail -n +2)" ]; then
            CONTAINERS=$(docker ps --filter "label=cc-bridge.instance" --format "table {{.Names}}\t{{.Status}}\t{{.Image}}" 2>/dev/null || true)
        fi

        if [ -n "$(echo "$CONTAINERS" | tail -n +2)" ]; then
            echo "$CONTAINERS" | sed 's/^/  /'
        else
            echo "  (No relevant containers running)"
        fi
    else
        echo "  (Docker not available or not running)"
    fi
}

check_consistency() {
    log_section "System Consistency"

    echo -n "Instance consistency: "
    if [ -f "$INSTANCES_FILE" ] && [ -S "$TMUX_SOCKET" ]; then
        REGISTERED=$(python3 -c "import json; print(list(json.load(open('$INSTANCES_FILE')).get('instances', {}).keys()))" 2>/dev/null | tr -d '[],')
        # Handle case where tmux server isn't running (no sessions)
        ACTUAL=$(tmux -S "$TMUX_SOCKET" ls 2>&1 | grep -v "failed to connect\|no server running" | cut -d: -f1 | tr '\n' ' ' || true)

        ORPHANED=""
        for session in $ACTUAL; do
            if [ -n "$session" ] && ! echo "$REGISTERED" | grep -qw "$session"; then
                # Extract instance name from session name (claude-{name} -> {name})
                INSTANCE_NAME=$(echo "$session" | sed 's/claude-//')
                if ! echo "$REGISTERED" | grep -qw "$INSTANCE_NAME"; then
                    ORPHANED="$ORPHANED $session"
                fi
            fi
        done

        if [ -n "$ORPHANED" ]; then
            log_warn "Orphaned tmux sessions found: $ORPHANED"
        else
            log_ok "Consistent"
        fi
    elif [ ! -f "$INSTANCES_FILE" ]; then
        log_warn "No instances database"
    else
        log_info "Cannot verify (tmux socket missing)"
    fi
    
    # Process status
    echo -n "Watchdog processes: "
    if [ -f "$INSTANCES_FILE" ]; then
        DEAD_COUNT=$(python3 -c "import json; instances = json.load(open('$INSTANCES_FILE'))['instances']; [print(f'{n}:{i.get(\"pid\", \"\")}') for n, i in instances.items()]" 2>/dev/null | while read -r entry; do
            name=$(echo "$entry" | cut -d: -f1)
            pid=$(echo "$entry" | cut -d: -f2)
            if [ -n "$pid" ] && ! ps -p "$pid" >/dev/null 2>&1; then
                echo "DEAD"
            fi
        done | wc -l | tr -d ' ')
        
        if [ "$DEAD_COUNT" -eq 0 ]; then
            log_ok "All active"
        else
            log_warn "$DEAD_COUNT process(es) dead"
        fi
    else
        log_info "No registered instances"
    fi
}

# Main health check
main() {
    echo -e "${CYAN}╔══════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║             CC-BRIDGE SYSTEM HEALTH CHECK            ║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════════════════════╝${NC}"
    echo -e "Time: $(date)"
    echo -e "User: $(whoami)"

    check_env_vars
    check_config_files
    check_connectivity
    check_server
    check_resource_lists
    check_consistency

    # Summary
    echo ""
    echo -e "${CYAN}━━━ Summary ━━━${NC}"
    echo -e "  ${GREEN}OK${NC}: $OK_COUNT"
    echo -e "  ${YELLOW}WARNING${NC}: $WARN_COUNT"
    echo -e "  ${RED}ERROR${NC}: $ERROR_COUNT"

    echo ""
    if [ $ERROR_COUNT -gt 0 ]; then
        echo -e "${RED}严重警告: 系统存在严重错误!${NC}"
        exit 1
    elif [ $WARN_COUNT -gt 0 ]; then
        echo -e "${YELLOW}注意: 系统运行正常，但存在一些警告。${NC}"
        exit 0
    else
        echo -e "${GREEN}一切正常: 系统状态良好!${NC}"
        exit 0
    fi
}

# Run main function
main "$@"
