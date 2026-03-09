#!/usr/bin/env bash
# =============================================================================
# CC-Bridge Host Execution Handler (runs on host OS, not in Docker)
# =============================================================================
# Usage:
#   host_exec.sh request <message>   # Run Claude and send response (with callback)
#   host_exec.sh response            # Write IPC + HTTP callback (Stop hook)
#   host_exec.sh help                # Show this help message
# =============================================================================
#
# This script provides the same callback mechanism as container_cmd.sh
# but runs on the host OS instead of inside a Docker container.
#
# Environment Variables:
#   REQUEST_ID      Request ID for tracking
#   CHAT_ID         Chat ID for the conversation
#   WORKSPACE_NAME  Workspace name (default: cc-bridge)
#   GATEWAY_URL     Gateway URL for callback (default: http://localhost:8080)
#                   Set to empty string to disable callback (sync mode)
#   IPC_BASE_DIR    IPC base directory (default: data)
# =============================================================================

set -eo pipefail

# Configuration
export IPC_BASE_DIR="${IPC_BASE_DIR:-data}"
export GATEWAY_URL="${GATEWAY_URL:-http://localhost:8080}"

# =============================================================================
# Helper Functions
# =============================================================================

log_info() {
    echo "[$(date +"%Y-%m-%dT%H:%M:%S%z")] [host_exec.sh] $1"
}

log_warn() {
    echo "[$(date +"%Y-%m-%dT%H:%M:%S%z")] [host_exec.sh] ⚠️  Warning: $1" >&2
}

log_debug() {
    if [[ "${DEBUG:-}" == "1" ]]; then
        echo "[$(date +"%Y-%m-%dT%H:%M:%S%z")] [host_exec.sh] DEBUG: $1" >&2
    fi
}

log_error() {
    echo "[$(date +"%Y-%m-%dT%H:%M:%S%z")] [host_exec.sh] ERROR: $1" >&2
}

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

xml_escape() {
    # Escape XML special characters to keep Claude message payload valid
    printf '%s' "$1" | sed -e 's/&/\&amp;/g' \
        -e 's/</\&lt;/g' \
        -e 's/>/\&gt;/g' \
        -e 's/\"/\&quot;/g' \
        -e "s/'/\&apos;/g"
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

# =============================================================================
# Command: help - Show usage information
# =============================================================================

cmd_help() {
    cat <<'EOF'
host_exec.sh - CC-Bridge Host Execution Handler

Usage:
  host_exec.sh request <message>   Run Claude with prompt and send response
  host_exec.sh response            Write IPC file + HTTP callback (for Stop hook)
  host_exec.sh help                Show this help message

Environment Variables:
  GATEWAY_URL          Gateway URL (default: http://localhost:8080)
  IPC_BASE_DIR         IPC base directory (default: data)
  WORKSPACE_NAME       Workspace name (default: cc-bridge)
  CHAT_ID              Chat ID for the conversation
  REQUEST_ID           Request ID for tracking
  DEBUG                Enable debug logging (1/0)

Examples:
  host_exec.sh request "Hello Claude"
  REQUEST_ID=abc123 CHAT_ID=oc_xxx host_exec.sh request "What's the weather?"
EOF
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

    log_info "request_id=$request_id workspace=$workspace"

    # Create directories
    local data_dir="${IPC_BASE_DIR}/data/${workspace}"
    mkdir -p "$data_dir"
    local data_file="${data_dir}/${request_id}.json"

    # Write request_id to well-known file for Stop hook to read
    local latest_file="${data_dir}/latest_request_id"
    echo -n "$request_id" > "$latest_file"

    log_debug "data_file=$data_file"

    # Export env vars for response command
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

    # Run Claude and capture output with JSON format
    # Unset CLAUDECODE to allow running claude inside Claude Code sessions
    # Use CLAUDE_ALLOWED_TOOLS env var to specify allowed tools (comma-separated)
    # Default includes common file ops + web tools - override with CLAUDE_ALLOWED_TOOLS="*" for all
    local claude_result
    local claude_exit=0
    local allowed_tools="${CLAUDE_ALLOWED_TOOLS:-Read,Write,Bash,Grep,Glob,WebSearch,WebFetch}"
    set +e
    claude_result=$(unset CLAUDECODE CLAUDE_API_KEY CLAUDE_API_URL && claude -p "$prompt" --output-format json --allowedTools="${allowed_tools}" 2>&1)
    claude_exit=$?
    set -e

    # Parse Claude's JSON output format
    local CLAUDE_OUTPUT=""
    local CLAUDE_EXIT=0

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

    # Call response to write IPC file and send callback
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

    # Try to get request_id from latest file if not set
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
    local release_lock
    release_lock() { callback_lock_release "$lock_dir"; }
    trap release_lock EXIT

    # Read Claude output from temp file
    local output=""
    local exit_code=0
    local had_data_file=false

    if [[ -f "$data_file" ]]; then
        had_data_file=true
        output=$(jq -r '.claude_output // ""' "$data_file")
        exit_code=$(jq -r '.exit_code // 0' "$data_file")

        local chat_id_from_file
        chat_id_from_file=$(jq -r '.chat_id // empty' "$data_file")
        if [[ -n "$chat_id_from_file" ]]; then
            chat_id="$chat_id_from_file"
        fi

        rm -f "$data_file" 2>/dev/null || true
        log_debug "read output='${output:0:50}...' exit_code=$exit_code chat_id=$chat_id"
    else
        log_debug "Data file not found: $data_file"
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

    # Write response file
    local response_file="${ipc_dir}/${request_id}.json"
    local response_file_tmp="${ipc_dir}/${request_id}.json.tmp"
    local output_json
    output_json=$(printf '%s' "$output" | jq -Rs . 2>/dev/null || echo '""')

    local chat_id_json
    if [[ "$chat_id" =~ ^-?[0-9]+$ ]]; then
        chat_id_json="$chat_id"
    else
        chat_id_json="\"$chat_id\""
    fi

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
    printf '%s' "$json_content" > "$response_file_tmp"
    mv -f "$response_file_tmp" "$response_file"

    log_info "Response file written: $response_file"

    # Send HTTP callback
    local payload
    if [[ "$chat_id" =~ ^-?[0-9]+$ ]]; then
        payload=$(jq -n \
            --arg requestId "$request_id" \
            --argjson chatId "$chat_id" \
            --arg workspace "$workspace" \
            --arg output "$output" \
            --argjson exitCode "$exit_code" \
            --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
            '{requestId: $requestId, chatId: $chatId, workspace: $workspace, output: $output, exitCode: $exitCode, timestamp: $timestamp}')
    else
        payload=$(jq -n \
            --arg requestId "$request_id" \
            --arg chatId "$chat_id" \
            --arg workspace "$workspace" \
            --arg output "$output" \
            --argjson exitCode "$exit_code" \
            --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
            '{requestId: $requestId, chatId: $chatId, workspace: $workspace, output: $output, exitCode: $exitCode, timestamp: $timestamp}')
    fi

    if [[ -z "${GATEWAY_URL}" ]]; then
        log_warn "Callback skipped: GATEWAY_URL not set (sync mode)"
        return 0
    fi

    # Send HTTP callback with retry
    local max_retries="${CALLBACK_MAX_RETRIES:-3}"
    local retry_delay="${CALLBACK_RETRY_DELAY_SEC:-1}"
    local max_time="${CALLBACK_MAX_TIME_SEC:-10}"
    local attempt=0
    local callback_success=false
    local http_code=""

    while [[ $attempt -lt $max_retries ]]; do
        attempt=$((attempt + 1))

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
        rm -f "$temp_response"

        if [[ $http_code -ge 200 && $http_code -lt 300 ]]; then
            log_info "Callback succeeded (attempt $attempt, HTTP $http_code)"
            callback_success=true
            callback_mark_sent "$marker_file"
            break
        fi

        # Don't retry on client errors
        if [[ $http_code -ge 400 && $http_code -lt 500 ]]; then
            log_warn "Callback failed (HTTP $http_code) - client error, not retrying"
            break
        fi

        if [[ $attempt -lt $max_retries ]]; then
            log_warn "Callback failed (HTTP $http_code), retrying in ${retry_delay}s..."
            sleep $retry_delay
            retry_delay=$((retry_delay * 2))
        else
            log_warn "Callback failed after $max_retries attempts (HTTP $http_code)"
        fi
    done

    log_info "Response complete: $request_id exit=$exit_code callback=$callback_success"
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
    *)
        echo "Usage: host_exec.sh <command> [options]"
        echo ""
        echo "Commands:"
        echo "  request <message>   Run Claude with prompt and send callback"
        echo "  response            Write IPC file + HTTP callback"
        echo "  help                Show this help message"
        exit 1
        ;;
esac
