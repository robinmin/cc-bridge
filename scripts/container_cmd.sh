#!/usr/bin/bash
# =============================================================================
# CC-Bridge Container Command Handler (runs inside Docker container)
# =============================================================================
# Usage:
#   container_cmd.sh request <message>   # Run Claude and send response
#   container_cmd.sh response           # Write IPC + HTTP callback (Stop hook)
#   container_cmd.sh help               # Show this help message
#   container_cmd.sh init               # Initialize environment (plugin sync, cache)
#   container_cmd.sh start              # Start the agent server
# =============================================================================

set -eo pipefail

# Configuration - rely on docker-compose.yml environment variables
# IPC_BASE_DIR is set via docker-compose.yml, fallback to /ipc if not set
export IPC_BASE_DIR="${IPC_BASE_DIR:-/ipc}"

# GATEWAY_URL - fallback to host.docker.internal if not set (for Stop hook context)
export GATEWAY_URL="${GATEWAY_URL:-http://host.docker.internal:8080}"

# Ensure PATH includes all required locations for claude, jq, curl, etc.
# Order matters: /app/node_modules/.bin first (claude-code CLI)
export PATH="/app/node_modules/.bin:/usr/local/bun/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

# =============================================================================
# Helper Functions
# =============================================================================

log_info() {
    echo "[$(date +"%Y-%m-%dT%H:%M:%S%z")] [container_cmd.sh] $1"
}

log_warn() {
    echo "[$(date +"%Y-%m-%dT%H:%M:%S%z")] [container_cmd.sh] ⚠️  Warning: $1" >&2
}

log_debug() {
    echo "[$(date +"%Y-%m-%dT%H:%M:%S%z")] [container_cmd.sh] DEBUG: $1" >&2
}

log_error() {
    echo "[$(date +"%Y-%m-%dT%H:%M:%S%z")] [container_cmd.sh] ERROR: $1" >&2
}

ensure_no_gateway_process() {
    # Guardrail: this container should run agent service only, never gateway.
    # A stray gateway process causes docker ENOENT discovery log spam.
    local pids=""

    if command -v pgrep &> /dev/null; then
        pids="$(pgrep -f "bun run src/gateway/index.ts" || true)"
    else
        pids="$(ps -eo pid,args | grep -F "bun run src/gateway/index.ts" | grep -v grep | awk '{print $1}' || true)"
    fi

    if [[ -n "${pids}" ]]; then
        log_warn "Detected unexpected gateway process in agent container. Terminating PIDs: ${pids//$'\n'/, }"
        while IFS= read -r pid; do
            [[ -n "$pid" ]] || continue
            kill -TERM "$pid" 2>/dev/null || true
        done <<< "$pids"
        sleep 1
    fi
}

resolve_llm_provider_env() {
    local resolver="/app/scripts/resolve-llm-provider.sh"
    if [[ ! -x "$resolver" ]]; then
        log_warn "LLM provider resolver not found at $resolver; using existing ANTHROPIC_* env"
        return 0
    fi

    local resolved_exports
    if ! resolved_exports="$("$resolver")"; then
        log_error "Failed to resolve LLM provider environment"
        return 1
    fi

    eval "$resolved_exports"
    return 0
}

strip_claude_hooks() {
    # Default: strip hooks only in hybrid mode (can override with STRIP_STOP_HOOK=0/1)
    local strip="${STRIP_STOP_HOOK:-}"
    if [[ -z "$strip" ]]; then
        if [[ "${IPC_MODE:-}" != "hybrid" && "${AGENT_MODE:-}" != "hybrid" ]]; then
            return 0
        fi
    else
        if [[ "$strip" == "0" || "$strip" == "false" ]]; then
            return 0
        fi
    fi

    local settings_path="${HOME:-/Users/${USER_NAME}}/.claude/settings.json"
    local tmp_path="${settings_path}.tmp"

    if [[ -f "$settings_path" ]] && command -v jq &> /dev/null; then
        if jq 'del(.hooks)' "$settings_path" > "$tmp_path" 2>/dev/null; then
            # Avoid mv over bind-mounted file; overwrite contents instead
            cat "$tmp_path" > "$settings_path" 2>/dev/null || true
        fi
        rm -f "$tmp_path" 2>/dev/null || true
    fi
}

now_epoch() {
    date +%s
}

file_mtime_epoch() {
    local path="$1"
    if stat -c %Y "$path" >/dev/null 2>&1; then
        stat -c %Y "$path"
    else
        stat -f %m "$path" 2>/dev/null || echo 0
    fi
}

callback_lock_path() {
    local base_dir="$1"
    local request_id="$2"
    echo "${base_dir}/${request_id}.callback_lock"
}

callback_marker_path() {
    local base_dir="$1"
    local request_id="$2"
    echo "${base_dir}/${request_id}.callback_sent"
}

callback_lock_acquire() {
    local lock_dir="$1"
    local ttl="${CALLBACK_LOCK_TTL_SEC:-60}"
    local now
    now=$(now_epoch)

    if mkdir "$lock_dir" 2>/dev/null; then
        echo -n "$$ $now" > "${lock_dir}/meta" 2>/dev/null || true
        return 0
    fi

    local meta="${lock_dir}/meta"
    local mtime
    mtime=$(file_mtime_epoch "$meta")
    if [[ "$mtime" -gt 0 && $((now - mtime)) -gt "$ttl" ]]; then
        rm -rf "$lock_dir" 2>/dev/null || true
        if mkdir "$lock_dir" 2>/dev/null; then
            echo -n "$$ $now" > "${lock_dir}/meta" 2>/dev/null || true
            return 0
        fi
    fi

    return 1
}

callback_lock_release() {
    local lock_dir="$1"
    rm -rf "$lock_dir" 2>/dev/null || true
}

callback_mark_sent() {
    local marker_file="$1"
    echo -n "sent $(date -u +"%Y-%m-%dT%H:%M:%SZ")" > "$marker_file" 2>/dev/null || true
}

xml_escape() {
    # Escape XML special characters to keep Claude message payload valid
    # Order matters: escape & first to avoid double-escaping
    printf '%s' "$1" | sed -e 's/&/&amp;/g' \
        -e 's/</&lt;/g' \
        -e 's/>/&gt;/g' \
        -e 's/\"/&quot;/g' \
        -e "s/'/&apos;/g"
}

# =============================================================================
# Command: help - Show usage information
# =============================================================================

cmd_help() {
    cat <<'EOF'
container_cmd.sh - CC-Bridge Container Command Handler

Usage:
  container_cmd.sh request <message>   Run Claude with prompt and send response
  container_cmd.sh response           Write IPC file + HTTP callback (for Stop hook)
  container_cmd.sh help               Show this help message
  container_cmd.sh init               Initialize environment (plugins, cache)
  container_cmd.sh start              Start the agent server (default CMD)

Environment Variables (set by docker-compose.yml):
  GATEWAY_URL          Gateway URL (default: http://host.docker.internal:8080)
  IPC_BASE_DIR         IPC base directory (default: /ipc)
  WORKSPACE_NAME       Workspace name (default: cc-bridge)
  LLM_PROVIDER         LLM provider selector (default: anthropic)
  CHAT_ID              Chat ID for the conversation
  IPC_MODE             IPC mode (callback_payload or hybrid)
  STRIP_STOP_HOOK      Force strip Stop hook (1/0). Default: auto in hybrid mode
  START_AGENT_ON_INIT  Start agent after init (1/0). Default: 1
  CALLBACK_LOCK_TTL_SEC         Stale lock TTL (default: 60)
  HYBRID_FALLBACK_DELAY_SEC     Wait before inline fallback (default: 1.5)
  HYBRID_FALLBACK_RETRY_SEC      Extra wait if lock exists (default: 1)

Examples:
  container_cmd.sh request "Hello Claude"
  container_cmd.sh response
  container_cmd.sh init
  container_cmd.sh start
EOF
}

# =============================================================================
# Command: init - Initialize environment
# =============================================================================

cmd_init() {
    log_info "Initializing container environment..."

    if ! resolve_llm_provider_env; then
        log_error "Container init aborted due to invalid LLM provider configuration"
        exit 1
    fi

    # Strip Stop hooks in inline mode to prevent duplicate callbacks
    strip_claude_hooks

    # Best-effort cleanup of old hybrid marker files
    if command -v find &> /dev/null; then
        find "${IPC_BASE_DIR:-/ipc}/data" -type f -name "*.callback_sent" -mmin +60 -delete 2>/dev/null || true
    fi

    # Ensure tmux server is running (required for persistent sessions)
    if command -v tmux &> /dev/null; then
        if ! tmux ls &> /dev/null; then
            log_info "Starting tmux server..."
            tmux start-server
        fi
    else
        log_warn "tmux not available - persistent sessions may not work"
    fi

    # Sync plugins if claude CLI is available
    if command -v claude &> /dev/null; then
        log_info "Claude CLI found, running plugin sync..."
        SYNC_SCRIPT="/app/sync-plugins.sh"
        if [ -f "$SYNC_SCRIPT" ]; then
            bash "$SYNC_SCRIPT"
            log_info "Plugin sync completed"
        else
            log_warn "$SYNC_SCRIPT not found, skipping plugin sync"
        fi
    else
        log_warn "Claude CLI not available - skipping plugin sync"
    fi

    # Refresh discovery cache
    REFRESH_CACHE_SCRIPT="/app/refresh-discovery-cache.sh"
    if [ -f "$REFRESH_CACHE_SCRIPT" ]; then
        log_info "Refreshing discovery cache..."
        bash "$REFRESH_CACHE_SCRIPT"
        log_info "Discovery cache refreshed"
    else
        log_warn "$REFRESH_CACHE_SCRIPT not found, skipping cache refresh"
    fi

    log_info "Initialization complete"

    # Start the agent server after init
    if [[ "${START_AGENT_ON_INIT:-1}" != "0" ]]; then
        cmd_start
    fi
}

# =============================================================================
# Command: start - Start the agent server
# =============================================================================

cmd_start() {
    ensure_no_gateway_process
    log_info "Starting agent server..."
    exec bun run src/agent/index.ts
}

# =============================================================================
# Command: status - Show running processes
# =============================================================================

cmd_status() {
    echo "Running processes in container:"
    ps aux
}

# =============================================================================
# Command: request - Run Claude and trigger response
# =============================================================================

cmd_request() {
    local message="$*"
    local request_id="${REQUEST_ID:-$(generate_uuid)}"
    local chat_id="${CHAT_ID:-default}"
    local workspace="${WORKSPACE_NAME:-cc-bridge}"

    [[ -n "$message" ]] || { echo "Error: Message required" >&2; exit 1; }

    if ! resolve_llm_provider_env; then
        log_error "Request aborted due to invalid LLM provider configuration"
        exit 1
    fi

    log_info "request_id=$request_id session=${SESSION_NAME:-default}"

    # Create temp file to share Claude output with response command
    local data_dir="${IPC_BASE_DIR}/data/${workspace}"
    mkdir -p "$data_dir"
    local data_file="${data_dir}/${request_id}.json"

    # Write request_id to well-known file for Stop hook to read
    # Stop hook runs in separate process without REQUEST_ID env var
    local latest_file="${IPC_BASE_DIR}/data/${workspace}/latest_request_id"
    echo -n "$request_id" > "$latest_file"

    # Debug: log the data file path
    log_debug "data_file=$data_file"

    # Run Claude and capture output with JSON format for structured data
    # Only set env vars if not already set (allows override from outside)
    export REQUEST_ID="${REQUEST_ID:-$request_id}"
    export CHAT_ID="${CHAT_ID:-$chat_id}"
    export WORKSPACE_NAME="${WORKSPACE_NAME:-$workspace}"

    local prompt=""
    # If the message already looks like a Claude XML messages payload, use as-is
    if [[ "$message" == "<messages>"* ]]; then
        prompt="$message"
    else
        local escaped
        escaped=$(xml_escape "$message")
        prompt="<messages><message sender=\"user\">${escaped}</message></messages>"
    fi

    # Use JSON output format for structured response
    # Claude's JSON format: {"type":"result","result":"...","is_error":false,...}
    local claude_result
    local claude_exit=0
    set +e
    claude_result=$(claude --dangerously-skip-permissions -p "$prompt" --output-format json 2>&1)
    claude_exit=$?
    set -e

    # Parse Claude's JSON output format
    # Extract 'result' field which contains the actual text output
    # Use is_error to determine exitCode
    if command -v jq &> /dev/null; then
        CLAUDE_OUTPUT=$(echo "$claude_result" | jq -r '.result // empty' 2>/dev/null || true)
        local is_error
        is_error=$(echo "$claude_result" | jq -r '.is_error // false' 2>/dev/null || true)

        if [[ -z "$CLAUDE_OUTPUT" ]]; then
            log_warn "JSON parsing failed, falling back to raw output"
            CLAUDE_OUTPUT="$claude_result"
            CLAUDE_EXIT=$claude_exit
        elif [[ "$is_error" == "true" ]]; then
            CLAUDE_EXIT=1
        else
            CLAUDE_EXIT=$claude_exit
        fi
    else
        log_warn "jq not available; using raw Claude output"
        CLAUDE_OUTPUT="$claude_result"
        CLAUDE_EXIT=$claude_exit
    fi

    if [[ -z "$CLAUDE_OUTPUT" ]]; then
        CLAUDE_OUTPUT="⚠️ Claude returned an empty response."
    fi

    # Write output to temp file for response command to read
    # Stop hook runs in separate process, can't inherit these vars
    # Using JSON format for structured data storage
    log_debug "Writing data_file=$data_file"
    cat > "$data_file" <<EOF
{
    "claude_output": $(printf '%s' "$CLAUDE_OUTPUT" | jq -Rs .),
    "exit_code": $CLAUDE_EXIT,
    "chat_id": $([[ "$chat_id" =~ ^-?[0-9]+$ ]] && echo "$chat_id" || echo "\"$chat_id\"")
}
EOF
    log_debug "data_file written, exists=$(test -f "$data_file" && echo yes || echo no)"

    log_info "Done: $request_id exit=$CLAUDE_EXIT"

    # Hybrid mode: rely on Stop hook first, fallback to inline response if needed
    if [[ "${IPC_MODE:-}" == "hybrid" ]] || [[ "${AGENT_MODE:-}" == "hybrid" ]]; then
        local marker_dir="${IPC_BASE_DIR}/data/${workspace}"
        local marker_file
        marker_file=$(callback_marker_path "$marker_dir" "$request_id")
        local lock_dir
        lock_dir=$(callback_lock_path "$marker_dir" "$request_id")

        # Give Stop hook a short window to fire
        sleep "${HYBRID_FALLBACK_DELAY_SEC:-1.5}"

        if [[ -f "$marker_file" ]]; then
            log_debug "Hybrid: callback already sent, skipping inline response"
            return 0
        fi

        # Attempt to acquire lock for fallback; if locked, Stop hook is running
        if ! callback_lock_acquire "$lock_dir"; then
            log_debug "Hybrid: callback lock exists, skipping inline response"
            return 0
        fi
        CALLBACK_LOCK_HELD=1
    fi

    # Default: call response inline
    cmd_response
}

# =============================================================================
# Response: Write IPC + HTTP callback
# =============================================================================

cmd_response() {
    local request_id="${REQUEST_ID:-unknown}"
    local chat_id="${CHAT_ID:-default}"
    local workspace="${WORKSPACE_NAME:-cc-bridge}"

    if [[ -z "$workspace" ]]; then
        echo "Error: WORKSPACE_NAME not set" >&2
        exit 1
    fi

    # Try to get request_id from latest file if not set (Stop hook scenario)
    if [[ "$request_id" == "unknown" ]] || [[ -z "$request_id" ]]; then
        local latest_file="${IPC_BASE_DIR}/data/${workspace}/latest_request_id"
        if [[ -f "$latest_file" ]]; then
            request_id=$(cat "$latest_file" 2>/dev/null || echo "unknown")
        fi
    fi

    local data_dir="${IPC_BASE_DIR}/data/${workspace}"
    local data_file="${data_dir}/${request_id}.json"
    local marker_file
    marker_file=$(callback_marker_path "$data_dir" "$request_id")
    local lock_dir
    lock_dir=$(callback_lock_path "$data_dir" "$request_id")

    mkdir -p "$data_dir" 2>/dev/null || true

    # Ensure only one callback attempt runs at a time for this request
    if [[ "${CALLBACK_LOCK_HELD:-0}" != "1" ]]; then
        if ! callback_lock_acquire "$lock_dir"; then
            log_debug "Callback lock exists, skipping duplicate response: $lock_dir"
            return 0
        fi
    fi
    # Always release lock on exit
    local release_lock
    release_lock() { callback_lock_release "$lock_dir"; }
    trap release_lock EXIT

    # Read Claude output from temp file (written by request command)
    # This is needed because Stop hook runs in separate process
    local output=""
    local exit_code=0
    local had_data_file=false

    if [[ -f "$data_file" ]]; then
        had_data_file=true
        # Read the data file and parse JSON format
        # The file contains: {"claude_output":"...","exit_code":0,"chat_id":12345}
        output=$(jq -r '.claude_output // ""' "$data_file")
        exit_code=$(jq -r '.exit_code // 0' "$data_file")

        # Use chat_id from data file if available, otherwise keep current value
        local chat_id_from_file
        chat_id_from_file=$(jq -r '.chat_id // empty' "$data_file")
        if [[ -n "$chat_id_from_file" ]]; then
            chat_id="$chat_id_from_file"
        fi

        # Clean up the data file
        rm -f "$data_file" 2>/dev/null || true
        log_debug "read output='${output:0:50}...' exit_code=$exit_code chat_id=$chat_id"
    else
        # Data file may have already been cleaned up by inline response call
        # This is normal in some execution scenarios
        log_debug "Data file not found (already cleaned up or never created): $data_file"
    fi

    [[ "$request_id" != "unknown" ]] || { echo "Error: REQUEST_ID not set" >&2; exit 1; }
    if [[ -z "$chat_id" || "$chat_id" == "default" ]]; then
        echo "Error: CHAT_ID not set" >&2
        exit 1
    fi

    if [[ -z "$output" ]]; then
        log_warn "Claude output is empty; using fallback message"
        output="⚠️ Claude returned an empty response."
    fi

    local ipc_dir="${IPC_BASE_DIR}/${workspace}/responses"
    mkdir -p "$ipc_dir"

    # If we don't have a data file and a response already exists, avoid overwriting
    if [[ "$had_data_file" == "false" ]]; then
        local existing_response="${ipc_dir}/${request_id}.json"
        if [[ -f "$existing_response" ]]; then
            log_debug "Response file already exists, skipping overwrite: $existing_response"
            return 0
        fi
    fi

    # Write IPC file to temporary location first, then rename atomically
    # This avoids NFS caching issues where the gateway might read an empty file
    local response_file="${ipc_dir}/${request_id}.json"
    local response_file_tmp="${ipc_dir}/${request_id}.json.tmp"
    local output_json
    output_json=$(printf '%s' "$output" | jq -Rs . 2>/dev/null || echo '""')
    # Write chatId as number if it looks like an integer, otherwise as string
    local chat_id_json
    if [[ "$chat_id" =~ ^-?[0-9]+$ ]]; then
        chat_id_json="$chat_id"
    else
        chat_id_json="\"$chat_id\""
    fi
    # Write response file using dd with fsync to force NFS write flush
    # conv=fsync ensures fsync() is called, flushing data to NFS server
    # This prevents NFS client-side caching from causing empty reads on gateway
    local json_content
    json_content=$(cat <<EOF
{
    "requestId": "$request_id",
    "chatId": $chat_id_json,
    "workspace": "$workspace",
    "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
    "output": $output_json,
    "exitCode": $exit_code
}
EOF
)
    printf '%s' "$json_content" | dd of="$response_file_tmp" conv=fsync status=none 2>/dev/null
    mv -f "$response_file_tmp" "$response_file"

    # Sync file to ensure it's visible across NFS before callback
    sync 2>/dev/null || true

    # Longer delay to allow NFS cache to flush (OrbStack can have cache delays)
    # Allow override for tests
    local sleep_before_sec="${CALLBACK_SLEEP_BEFORE_SEC:-2}"
    if [[ "$sleep_before_sec" != "0" ]]; then
        sleep "$sleep_before_sec"
    fi

    # Send HTTP callback
    # Use --arg for chatId since it could be a number or string
    # Convert to number if it looks like an integer, otherwise keep as string
    local payload
    if [[ "$chat_id" =~ ^-?[0-9]+$ ]]; then
        # chatId looks like an integer, pass as JSON number
        payload=$(jq -n \
            --arg requestId "$request_id" \
            --argjson chatId "$chat_id" \
            --arg workspace "$workspace" \
            '{requestId: $requestId, chatId: $chatId, workspace: $workspace}')
    else
        # chatId is not a number, pass as string
        payload=$(jq -n \
            --arg requestId "$request_id" \
            --arg chatId "$chat_id" \
            --arg workspace "$workspace" \
            '{requestId: $requestId, chatId: $chatId, workspace: $workspace}')
    fi

    # Optional callback payload mode: include output directly
    if [[ "${IPC_MODE:-}" == "callback_payload" ]] || \
       [[ "${AGENT_MODE:-}" == "callback_payload" ]] || \
       [[ "${IPC_MODE:-}" == "hybrid" ]] || \
       [[ "${AGENT_MODE:-}" == "hybrid" ]]; then
        payload=$(printf '%s' "$payload" | jq \
            --arg output "$output" \
            --argjson exitCode "$exit_code" \
            --arg error "" \
            --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
            '. + {output: $output, exitCode: $exitCode, timestamp: $timestamp} + (if $error != "" then {error: $error} else {} end)')
    fi

    # Send HTTP callback with retry logic and exponential backoff
    local max_retries="${CALLBACK_MAX_RETRIES:-3}"
    local retry_delay="${CALLBACK_RETRY_DELAY_SEC:-1}"
    local max_time="${CALLBACK_MAX_TIME_SEC:-10}"
    local attempt=0
    local callback_success=false
    local http_code=""
    local callback_error=""
    local retry_timestamps=()

    if [[ -z "${GATEWAY_URL}" ]]; then
        log_warn "Callback skipped: GATEWAY_URL not set"
        callback_error="no_gateway_url"
    else
        while [[ $attempt -lt $max_retries ]]; do
            attempt=$((attempt + 1))
            retry_timestamps+=("$(date -u +"%Y-%m-%dT%H:%M:%SZ")")

            # Capture HTTP status code using --write-out, output to temp file
            local temp_response
            temp_response=$(mktemp)
            http_code=$(curl -X POST "${GATEWAY_URL}/claude-callback" \
                -H "Content-Type: application/json" \
                -d "$payload" \
                --max-time "$max_time" \
                --silent \
                --write-out "%{http_code}" \
                --output "$temp_response" 2>/dev/null || true)
            if [[ -z "$http_code" ]]; then
                http_code="000"
            fi
            local response_body=""
            if [[ -f "$temp_response" ]]; then
                response_body=$(head -c 256 "$temp_response" 2>/dev/null || true)
            fi
            rm -f "$temp_response"

            if [[ $http_code -ge 200 && $http_code -lt 300 ]]; then
                log_info "Callback succeeded (attempt $attempt, HTTP $http_code)"
                callback_success=true
                callback_error=""
                callback_mark_sent "$marker_file"
                break
            fi

            # Do not retry on client errors (4xx)
            if [[ $http_code -ge 400 && $http_code -lt 500 ]]; then
                callback_error="client_error: HTTP $http_code"
                log_warn "Callback failed (HTTP $http_code) - client error, not retrying; body='${response_body}'"
                break
            fi

            callback_error="server_error: HTTP $http_code"
            if [[ -n "$response_body" ]]; then
                log_warn "Callback failed (HTTP $http_code); body='${response_body}'"
            fi

            if [[ $attempt -lt $max_retries ]]; then
                log_warn "Callback failed (HTTP $http_code), retrying in ${retry_delay}s... (attempt $attempt/$max_retries)"
                sleep $retry_delay
                retry_delay=$(awk "BEGIN {print $retry_delay * 2}")
            else
                log_warn "Callback failed after $max_retries attempts (HTTP $http_code)"
                log_info "Response file preserved for MailboxWatcher polling: $response_file"
            fi
        done
    fi

    # Update response file with callback metadata for diagnostics
    if command -v jq >/dev/null 2>&1; then
        local timestamps_json="[]"
        if [[ ${#retry_timestamps[@]} -gt 0 ]]; then
            timestamps_json=$(printf '%s\n' "${retry_timestamps[@]}" | jq -R . | jq -s .)
        fi

        local callback_json
        callback_json=$(jq -n \
            --argjson success "$callback_success" \
            --argjson attempts "$attempt" \
            --arg error "$callback_error" \
            --argjson retryTimestamps "$timestamps_json" \
            '{
                success: $success,
                attempts: $attempts,
                retryTimestamps: $retryTimestamps
            } + (if $error != "" then {error: $error} else {} end)')

        local response_with_callback
        response_with_callback=$(printf '%s' "$json_content" | jq --argjson callback "$callback_json" '. + {callback: $callback}')
        if [[ -n "$response_with_callback" ]]; then
            printf '%s' "$response_with_callback" | dd of="$response_file_tmp" conv=fsync status=none 2>/dev/null
            mv -f "$response_file_tmp" "$response_file"
        fi
    fi

    log_info "Response: $request_id exit=$exit_code"
}

# =============================================================================
# Utility
# =============================================================================

generate_uuid() {
    if command -v uuidgen &> /dev/null; then
        uuidgen | tr '[:upper:]' '[:lower:]'
    else
        printf '%04x%04x-%04x-%04x-%04x-%04x%04x%04x' \
            $RANDOM $RANDOM $RANDOM \
            $((RANDOM % 65536 | 0x4000)) \
            $((RANDOM % 65536 | 0x8000)) \
            $RANDOM $RANDOM $RANDOM
    fi
}

# =============================================================================
# Main
# =============================================================================

case "${1:-}" in
    request)
        shift
        cmd_request "$@"
        ;;
    response)
        cmd_response
        ;;
    help|--help|-h)
        cmd_help
        ;;
    init)
        cmd_init
        ;;
    start)
        cmd_start
        ;;
    status)
        cmd_status
        ;;
    *)
        echo "Usage: container_cmd.sh <command> [options]"
        echo ""
        echo "Commands:"
        echo "  request <message>   Run Claude with prompt"
        echo "  response          Write IPC + HTTP callback (for Stop hook)"
        echo "  help              Show this help message"
        echo "  init              Initialize environment"
        echo "  start             Start the agent server"
        echo "  status            Show running processes"
        echo ""
        echo "Run 'container_cmd.sh help' for full documentation."
        exit 1
        ;;
esac
