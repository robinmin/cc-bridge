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
# IPC_DATA_DIR is set via docker-compose.yml, fallback to /ipc/data if not set
export IPC_DATA_DIR="${IPC_DATA_DIR:-/ipc/data}"

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
    echo "[container_cmd.sh] $1"
}

log_warn() {
    echo "[container_cmd.sh] ⚠️  Warning: $1" >&2
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
  GATEWAY_CALLBACK_URL Callback URL (default: ${GATEWAY_URL}/claude-callback)
  IPC_BASE_DIR         IPC base directory (default: /ipc)
  IPC_DATA_DIR         Data directory for temp files (default: /ipc/data)
  WORKSPACE_NAME       Workspace name (default: cc-bridge)
  CHAT_ID              Chat ID for the conversation

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
}

# =============================================================================
# Command: start - Start the agent server
# =============================================================================

cmd_start() {
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

    echo "[container_cmd.sh] request_id=$request_id session=${SESSION_NAME:-default}"

    # Create temp file to share Claude output with response command
    local data_dir="${IPC_DATA_DIR}/${workspace}"
    mkdir -p "$data_dir"
    local data_file="${data_dir}/${request_id}.json"

    # Write request_id to well-known file for Stop hook to read
    # Stop hook runs in separate process without REQUEST_ID env var
    local latest_file="${IPC_DATA_DIR}/${workspace}/latest_request_id"
    echo -n "$request_id" > "$latest_file"

    # Debug: log the data file path
    echo "[container_cmd.sh] DEBUG: data_file=$data_file" >&2

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
    local parse_error=false
    CLAUDE_OUTPUT=$(echo "$claude_result" | jq -r '.result // empty' 2>/dev/null || true)
    local is_error
    is_error=$(echo "$claude_result" | jq -r '.is_error // false' 2>/dev/null || true)

    if [[ -z "$CLAUDE_OUTPUT" ]]; then
        echo "[container_cmd.sh] Warning: JSON parsing failed, falling back to raw output" >&2
        CLAUDE_OUTPUT="$claude_result"
        CLAUDE_EXIT=$claude_exit
    elif [[ "$is_error" == "true" ]]; then
        CLAUDE_EXIT=1
    else
        CLAUDE_EXIT=$claude_exit
    fi

    # Write output to temp file for response command to read
    # Stop hook runs in separate process, can't inherit these vars
    # Using JSON format for structured data storage
    echo "[container_cmd.sh] DEBUG: Writing data_file=$data_file" >&2
    cat > "$data_file" <<EOF
{
    "claude_output": $(printf '%s' "$CLAUDE_OUTPUT" | jq -Rs .),
    "exit_code": $CLAUDE_EXIT,
    "chat_id": $([[ "$chat_id" =~ ^-?[0-9]+$ ]] && echo "$chat_id" || echo "\"$chat_id\"")
}
EOF
    echo "[container_cmd.sh] DEBUG: data_file written, exists=$(test -f "$data_file" && echo yes || echo no)" >&2

    echo "[container_cmd.sh] Done: $request_id exit=$CLAUDE_EXIT"

    # Call response inline since Stop hook may not trigger in -p mode
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
        local latest_file="${IPC_DATA_DIR}/${workspace}/latest_request_id"
        if [[ -f "$latest_file" ]]; then
            request_id=$(cat "$latest_file" 2>/dev/null || echo "unknown")
        fi
    fi

    local data_file="${IPC_DATA_DIR}/${workspace}/${request_id}.json"

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
        echo "[container_cmd.sh] DEBUG: read output='${output:0:50}...' exit_code=$exit_code chat_id=$chat_id" >&2
    else
        # Data file may have already been cleaned up by inline response call
        # This is normal in some execution scenarios
        echo "[container_cmd.sh] DEBUG: Data file not found (already cleaned up or never created): $data_file" >&2
    fi

    [[ "$request_id" != "unknown" ]] || { echo "Error: REQUEST_ID not set" >&2; exit 1; }
    if [[ -z "$chat_id" || "$chat_id" == "default" ]]; then
        echo "Error: CHAT_ID not set" >&2
        exit 1
    fi

    local ipc_dir="${IPC_BASE_DIR}/${workspace}/responses"
    mkdir -p "$ipc_dir"

    # If we don't have a data file and a response already exists, avoid overwriting
    if [[ "$had_data_file" == "false" ]]; then
        local existing_response="${ipc_dir}/${request_id}.json"
        if [[ -f "$existing_response" ]]; then
            echo "[container_cmd.sh] DEBUG: Response file already exists, skipping overwrite: $existing_response" >&2
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
        echo "[container_cmd.sh] Callback skipped: GATEWAY_URL not set"
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
                echo "[container_cmd.sh] Callback succeeded (attempt $attempt, HTTP $http_code)"
                callback_success=true
                callback_error=""
                break
            fi

            # Do not retry on client errors (4xx)
            if [[ $http_code -ge 400 && $http_code -lt 500 ]]; then
                callback_error="client_error: HTTP $http_code"
                echo "[container_cmd.sh] Callback failed (HTTP $http_code) - client error, not retrying; body='${response_body}'"
                break
            fi

            callback_error="server_error: HTTP $http_code"
            if [[ -n "$response_body" ]]; then
                echo "[container_cmd.sh] Callback failed (HTTP $http_code); body='${response_body}'" >&2
            fi

            if [[ $attempt -lt $max_retries ]]; then
                echo "[container_cmd.sh] Callback failed (HTTP $http_code), retrying in ${retry_delay}s... (attempt $attempt/$max_retries)"
                sleep $retry_delay
                retry_delay=$(awk "BEGIN {print $retry_delay * 2}")
            else
                echo "[container_cmd.sh] Callback failed after $max_retries attempts (HTTP $http_code)"
                echo "[container_cmd.sh] Response file preserved for MailboxWatcher polling: $response_file"
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

    echo "[container_cmd.sh] Response: $request_id exit=$exit_code"
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
