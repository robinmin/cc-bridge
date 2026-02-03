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
LOG_FILE="$HOME/.claude/bridge/logs/server.log"

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
}

check_launchd_services() {
    log_section "System Daemons (/Library/LaunchDaemons)"
    SERVICES=(
        "com.cc-bridge.daemon:cc-bridge server"
        "com.cloudflare.cloudflared.daemon:cloudflared" 
        "dev.orbstack.OrbStack.privhelper:OrbStack"
    )

    for entry in "${SERVICES[@]}"; do
        service="${entry%%:*}"
        pattern="${entry#*:}"
        
        printf "  %-35s " "${service}:"
        # Try launchctl first (works if user has enough perms or running as sudo)
        PID=$(launchctl list "$service" 2>/dev/null | grep -i "\"PID\" =" | awk '{print $3}' | tr -d '";' || true)
        if [ -z "$PID" ]; then
            PID=$(launchctl list | grep "$service" | awk '{print $1}' | grep -v "-" || true)
        fi
        
        # Fallback to pgrep on the specific process pattern
        if [ -z "$PID" ]; then
            PID=$(pgrep -f "$pattern" 2>/dev/null | head -1 || true)
        fi
        
        if [ -n "$PID" ]; then
            log_ok "Running (PID: $PID)"
        else
            # Final check - strictly for the plist label
            PID=$(sudo launchctl list | grep "$service" | awk '{print $1}' | grep -v "-" || true)
            if [ -n "$PID" ]; then
                log_ok "Running (PID: $PID)"
            else
                log_error "NOT RUNNING"
            fi
        fi
    done

    # Verify tunnel connectivity if cloudflared is running
    CLOUDFLARED_PROC_PID=$(pgrep -f "cloudflared" 2>/dev/null | head -1 || true)
    if [ -n "$CLOUDFLARED_PROC_PID" ] && [ -n "${WEBHOOK_URL:-}" ] && [ "$WEBHOOK_URL" != "Not set" ]; then
        echo -n "Tunnel connectivity: "
        TUNNEL_BASE_URL=$(echo "$WEBHOOK_URL" | sed 's|/webhook$||')
        if curl -s -f --connect-timeout 5 "$TUNNEL_BASE_URL/health" >/dev/null 2>&1; then
            log_ok "Reachable ($TUNNEL_BASE_URL)"
        else
            log_warn "Not reachable externally ($TUNNEL_BASE_URL)"
        fi
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
    echo -e "${MAGENTA}Docker Instances:${NC}"
    if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
        # Show all cc-bridge related containers (running and stopped)
        CONTAINERS=$(docker ps -a --filter "name=claude-" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || true)

        # Also check for cc-bridge labeled containers
        if [ -z "$(echo "$CONTAINERS" | tail -n +2)" ]; then
            CONTAINERS=$(docker ps -a --filter "label=cc-bridge.instance" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || true)
        fi

        if [ -n "$(echo "$CONTAINERS" | tail -n +2)" ]; then
            echo "$CONTAINERS" | sed 's/^/  /'
        else
            echo "  (No cc-bridge containers found)"
        fi
    else
        echo "  (Docker not available or not running)"
    fi

    echo ""
    # Named Pipes - check multiple locations
    PIPE_DIR="${PIPE_DIR_HOST:-/tmp/cc-bridge/${PROJECT_NAME:-cc-bridge}/pipes}"
    ALT_PIPE_DIRS="/tmp/cc-bridge-pipes /tmp/cc-bridge"
    FOUND_PIPE_DIR=""

    # Find the first existing pipe directory
    if [ -d "$PIPE_DIR" ]; then
        FOUND_PIPE_DIR="$PIPE_DIR"
    else
        for dir in $ALT_PIPE_DIRS; do
            if [ -d "$dir" ] && [ -n "$(find "$dir" -name "*.fifo" 2>/dev/null)" ]; then
                FOUND_PIPE_DIR="$dir"
                break
            fi
        done
    fi

    if [ -n "$FOUND_PIPE_DIR" ]; then
        echo -e "${MAGENTA}Named Pipes (${FOUND_PIPE_DIR}):${NC}"
        PIPES=$(find "$FOUND_PIPE_DIR" -name "*.fifo" 2>/dev/null || true)
        if [ -n "$PIPES" ]; then
            echo "$PIPES" | while read -r pipe; do
                PIPE_NAME=$(basename "$pipe")
                if [ -p "$pipe" ]; then
                    echo -e "  ${GREEN}✓${NC} $PIPE_NAME"
                else
                    echo -e "  ${YELLOW}⚠${NC} $PIPE_NAME (not a pipe)"
                fi
            done
        else
            echo "  (No pipes found)"
        fi
    else
        echo -e "${MAGENTA}Named Pipes:${NC}"
        echo "  (No pipe directory found)"
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
        DEAD_COUNT=$(python3 -c "import json; instances = json.load(open('$INSTANCES_FILE'))['instances']; [print(f'{n}:{i.get(\"instance_type\", \"\")}:{i.get(\"pid\", \"\")}:{i.get(\"status\", \"\")}') for n, i in instances.items()]" 2>/dev/null | while read -r entry; do
            name=$(echo "$entry" | cut -d: -f1)
            type=$(echo "$entry" | cut -d: -f2)
            pid=$(echo "$entry" | cut -d: -f3)
            status=$(echo "$entry" | cut -d: -f4)
            
            # For tmux instances, check if PID is alive IF it's supposed to be running
            if [ "$type" = "tmux" ] && [ "$status" = "running" ] && [ -n "$pid" ] && ! ps -p "$pid" >/dev/null 2>&1; then
                echo "DEAD"
            fi
            # Docker instances don't have a host PID, their health is checked in the Docker section
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
    check_launchd_services
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
