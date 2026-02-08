#!/bin/bash
set -euo pipefail

# =============================================================================
# Claude Code Stop Hook Script with Retry Logic and Offline Mode
# =============================================================================
# This script runs automatically after each Claude execution completes.
# It captures Claude's output, writes it to the filesystem, and sends a
# callback notification to the Gateway with exponential backoff retry logic.
#
# Environment variables (set by TmuxManager before each command):
# - REQUEST_ID: Unique request identifier
# - CHAT_ID: Telegram chat ID
# - WORKSPACE_NAME: Current workspace name
# - GATEWAY_CALLBACK_URL: Gateway callback endpoint
#
# Environment variables set by Claude CLI after execution:
# - CLAUDE_OUTPUT: Combined stdout/stderr
# - CLAUDE_EXIT_CODE: Process exit code
# - CLAUDE_STDERR: Error output (if any)
# =============================================================================

# Configuration
# Use TEST_IPC_DIR for testing if available, otherwise use IPC_BASE_DIR
RESPONSE_BASE_DIR="${TEST_IPC_DIR:-${IPC_BASE_DIR:-/ipc}}"
RESPONSE_DIR="${RESPONSE_BASE_DIR}/${WORKSPACE_NAME}/responses"
RESPONSE_FILE="${RESPONSE_DIR}/${REQUEST_ID}.json"
TEMP_FILE="${RESPONSE_FILE}.tmp"
LOG_FILE="${RESPONSE_BASE_DIR}/../logs/stop-hook.log"

# Retry configuration
MAX_RETRIES=3
INITIAL_BACKOFF=1
MAX_TOTAL_TIMEOUT=30
REQUEST_TIMEOUT=5
JITTER_PERCENT=20

# Get environment variables with defaults
REQUEST_ID="${REQUEST_ID:-unknown}"
CHAT_ID="${CHAT_ID:-unknown}"
WORKSPACE_NAME="${WORKSPACE_NAME:-unknown}"
GATEWAY_CALLBACK_URL="${GATEWAY_CALLBACK_URL:-}"

# Capture Claude output from environment variables
CLAUDE_OUTPUT="${CLAUDE_OUTPUT:-}"
CLAUDE_EXIT_CODE="${CLAUDE_EXIT_CODE:-0}"
CLAUDE_STDERR="${CLAUDE_STDERR:-}"
CLAUDE_MODEL="${CLAUDE_MODEL:-}"
CLAUDE_TOKENS="${CLAUDE_TOKENS:-0}"

# Global variables for error tracking
LAST_ERROR_TYPE=""
LAST_HTTP_CODE=""
RETRY_TIMESTAMPS=""

# Flag to track if logging is working
LOGGING_AVAILABLE=false

# Try to create log directory and file, don't fail if we can't
mkdir -p "$(dirname "${LOG_FILE}")" 2>/dev/null && LOGGING_AVAILABLE=true

# Ensure response directory exists
mkdir -p "${RESPONSE_DIR}"

# =============================================================================
# Logging Functions (Structured JSON)
# =============================================================================

log_json() {
    local level="$1"
    local message="$2"
    local extra="${3:-{}}"

    if [ "$LOGGING_AVAILABLE" = true ]; then
        local timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

        cat >> "${LOG_FILE}" <<EOF
{"level":"${level}","time":"${timestamp}","component":"stop-hook","requestId":"${REQUEST_ID}","chatId":"${CHAT_ID}","workspace":"${WORKSPACE_NAME}","msg":"${message}","extra":${extra}}
EOF
    fi
}

log_info() {
    log_json "info" "$1" "${2:-{}}"
    echo "[Stop Hook] $*" >&2
}

log_error() {
    log_json "error" "$1" "${2:-{}}"
    echo "[Stop Hook ERROR] $*" >&2
}

log_warn() {
    log_json "warn" "$1" "${2:-{}}"
    echo "[Stop Hook WARN] $*" >&2
}

# =============================================================================
# Calculate exponential backoff with jitter
# =============================================================================

calculate_backoff() {
    local attempt=$1
    local base_delay=$((INITIAL_BACKOFF * (2 ** (attempt - 1))))

    # Add jitter (±20%)
    local jitter=$((base_delay * JITTER_PERCENT / 100))
    local min_delay=$((base_delay - jitter))
    local max_delay=$((base_delay + jitter))

    # Random delay between min and max
    local delay_range=$((max_delay - min_delay + 1))
    local delay=$((min_delay + RANDOM % delay_range))

    echo "$delay"
}

# =============================================================================
# Build response JSON with callback metadata
# =============================================================================

build_response_json() {
    local callback_success="$1"
    local callback_attempts="$2"
    local callback_error="${3:-}"
    local retry_timestamps="${4:-[]}"

    local timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Build the JSON using jq for proper escaping
    jq -n \
        --arg requestId "${REQUEST_ID}" \
        --arg chatId "${CHAT_ID}" \
        --arg workspace "${WORKSPACE_NAME}" \
        --arg timestamp "${timestamp}" \
        --arg output "${CLAUDE_OUTPUT}" \
        --argjson exitCode "${CLAUDE_EXIT_CODE}" \
        --arg model "${CLAUDE_MODEL}" \
        --argjson tokens "${CLAUDE_TOKENS}" \
        --arg stderr "${CLAUDE_STDERR}" \
        --argjson callbackSuccess "${callback_success}" \
        --argjson callbackAttempts "${callback_attempts}" \
        --arg callbackError "${callback_error}" \
        --argjson retryTimestamps "${retry_timestamps}" \
        '{
            requestId: $requestId,
            chatId: $chatId,
            workspace: $workspace,
            timestamp: $timestamp,
            output: $output,
            exitCode: $exitCode,
            metadata: {
                model: $model,
                tokens: $tokens
            }
        } + (if $stderr != "" then {error: $stderr} else {} end) + {
            callback: {
                success: $callbackSuccess,
                attempts: $callbackAttempts
            } + (if $callbackError != "" then {error: $callbackError} else {} end) + {
                retryTimestamps: $retryTimestamps
            }
        }'
}

# =============================================================================
# Write response file with metadata
# =============================================================================

write_response_file() {
    local callback_success="$1"
    local callback_attempts="$2"
    local callback_error="${3:-}"
    local retry_timestamps="${4:-[]}"

    build_response_json "${callback_success}" "${callback_attempts}" "${callback_error}" "${retry_timestamps}" > "${TEMP_FILE}"

    # Atomic rename
    mv "${TEMP_FILE}" "${RESPONSE_FILE}"

    log_info "Response file written" "{\"success\":${callback_success},\"attempts\":${callback_attempts}}"
}

# =============================================================================
# Send callback with timeout and error categorization
# =============================================================================

send_callback() {
    local url="$1"
    local attempt="$2"
    local start_time=$(date +%s)  # Milliseconds since epoch

    # Build minimal callback payload
    local payload
    payload=$(jq -n \
        --arg requestId "${REQUEST_ID}" \
        --arg chatId "${CHAT_ID}" \
        --arg workspace "${WORKSPACE_NAME}" \
        '{requestId: $requestId, chatId: $chatId, workspace: $workspace}')

    local http_code
    local response
    local curl_output_file="/tmp/callback-response-${REQUEST_ID}-${attempt}.txt"

    # Use curl with timeout and capture HTTP code
    http_code=$(curl -X POST \
        -H "Content-Type: application/json" \
        -d "${payload}" \
        --max-time ${REQUEST_TIMEOUT} \
        --silent \
        --write-out "%{http_code}" \
        --output "${curl_output_file}" \
        "${url}" 2>/dev/null)

    # If curl failed to execute or returned empty, set to connection error code
    if [ -z "$http_code" ]; then
        http_code="000"
    fi

    local end_time=$(date +%s)
    local latency=$((end_time - start_time))

    response=$(cat "${curl_output_file}" 2>/dev/null || echo "")
    rm -f "${curl_output_file}"

    # Categorize error
    local error_type="none"
    local should_retry=true

    if [[ "$http_code" == "000" ]]; then
        error_type="network"
        should_retry=true
    elif [[ "$http_code" == "408" ]] || [[ "$http_code" == "504" ]]; then
        error_type="timeout"
        should_retry=true
    elif [[ "$http_code" =~ ^5[0-9]{2}$ ]]; then
        error_type="server_error"
        should_retry=true
    elif [[ "$http_code" =~ ^4[0-9]{2}$ ]]; then
        error_type="client_error"
        should_retry=false
    elif [[ "$http_code" =~ ^2[0-9]{2}$ ]]; then
        error_type="none"
        should_retry=false
    else
        error_type="unknown"
        should_retry=true
    fi

    local log_extra="{\"httpCode\":\"${http_code}\",\"latency\":${latency},\"errorType\":\"${error_type}\"}"
    log_info "Callback attempt ${attempt}" "${log_extra}"

    # Set global variables for retry decision
    LAST_ERROR_TYPE="$error_type"
    LAST_HTTP_CODE="$http_code"

    # Return success status
    if [[ "$http_code" =~ ^2[0-9]{2}$ ]]; then
        return 0
    else
        return 1
    fi
}

# =============================================================================
# Retry logic with exponential backoff
# =============================================================================

retry_callback() {
    local url="$1"
    local retry_count=0
    local start_time=$(date +%s)
    local retry_timestamps="["

    while [ $retry_count -lt $MAX_RETRIES ]; do
        retry_count=$((retry_count + 1))

        # Check total timeout
        local elapsed=$(($(date +%s) - start_time))
        if [ $elapsed -gt $MAX_TOTAL_TIMEOUT ]; then
            log_error "Total retry timeout exceeded" "{\"elapsed\":${elapsed}}"
            break
        fi

        # Record attempt timestamp
        local attempt_time="\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\""
        if [ $retry_count -gt 1 ]; then
            retry_timestamps="${retry_timestamps},"
        fi
        retry_timestamps="${retry_timestamps}${attempt_time}"

        # Attempt callback
        if send_callback "$url" "$retry_count"; then
            # Success!
            retry_timestamps="${retry_timestamps}]"
            write_response_file "true" "$retry_count" "" "$retry_timestamps"
            log_info "Callback succeeded" "{\"attempts\":${retry_count}}"
            return 0
        fi

        # Check if we should retry based on error type
        if [[ "${LAST_ERROR_TYPE}" == "client_error" ]]; then
            log_warn "Client error, not retrying" "{\"httpCode\":\"${LAST_HTTP_CODE}\"}"
            retry_timestamps="${retry_timestamps}]"
            write_response_file "false" "$retry_count" "${LAST_ERROR_TYPE}: HTTP ${LAST_HTTP_CODE}" "$retry_timestamps"
            return 1
        fi

        # Wait before retry (unless last attempt)
        if [ $retry_count -lt $MAX_RETRIES ]; then
            local backoff=$(calculate_backoff $retry_count)
            log_info "Retrying after backoff" "{\"attempt\":${retry_count},\"backoff\":${backoff},\"errorType\":\"${LAST_ERROR_TYPE}\"}"
            sleep "$backoff"
        fi
    done

    # All retries failed - enter offline mode
    retry_timestamps="${retry_timestamps}]"
    local error_msg="${LAST_ERROR_TYPE}: HTTP ${LAST_HTTP_CODE}"
    write_response_file "false" "$retry_count" "$error_msg" "$retry_timestamps"
    log_error "Callback failed after all retries" "{\"attempts\":${retry_count},\"errorType\":\"${LAST_ERROR_TYPE}\",\"httpCode\":\"${LAST_HTTP_CODE}\"}"

    return 1
}

# =============================================================================
# Main Execution
# =============================================================================

main() {
    log_info "Stop Hook started" "{}"

    # Validate required environment variables
    if [[ -z "${REQUEST_ID}" ]] || [[ "${REQUEST_ID}" == "unknown" ]]; then
        log_error "Missing or invalid REQUEST_ID" "{}"
        exit 1
    fi

    if [[ -z "${CHAT_ID}" ]] || [[ "${CHAT_ID}" == "unknown" ]]; then
        log_error "Missing or invalid CHAT_ID" "{}"
        exit 1
    fi

    if [[ -z "${WORKSPACE_NAME}" ]] || [[ "${WORKSPACE_NAME}" == "unknown" ]]; then
        log_error "Missing or invalid WORKSPACE_NAME" "{}"
        exit 1
    fi

    # Attempt callback with retry if URL is configured
    if [ -n "${GATEWAY_CALLBACK_URL}" ]; then
        if retry_callback "${GATEWAY_CALLBACK_URL}"; then
            exit 0
        else
            # Offline mode - file written, callback failed
            log_warn "Entering offline mode - response file written for polling" "{}"
            exit 0  # Don't fail the hook
        fi
    else
        # No callback URL - write file only
        log_info "No callback URL configured, writing response file only" "{}"
        write_response_file "false" "0" "No callback URL configured" "[]"
        exit 0
    fi
}

# Run main function
main
