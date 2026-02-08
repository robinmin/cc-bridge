---
wbs: "0121"
title: "Phase 2.2: Stop Hook Retry Logic + Offline Mode"
status: "pending"
priority: "high"
complexity: "medium"
estimated_hours: 4
phase: "phase-2-filesystem-polish"
dependencies: ["0113", "0120"]
created: 2026-02-07
impl_progress:
  planning: completed
  design: pending
  implementation: pending
  review: pending
  testing: pending
---

# Phase 2.2: Stop Hook Retry Logic + Offline Mode

## Description

Enhance the Stop Hook script with production-grade retry logic, exponential backoff, offline mode support, comprehensive error logging, and timeout handling. Ensures callbacks are resilient to network failures and Gateway unavailability.

## Requirements

### Functional Requirements

1. **Exponential Backoff Retry**
   - 3 retry attempts with exponential backoff (1s, 2s, 4s)
   - Jitter to prevent thundering herd (±20% random delay)
   - Different backoff for transient vs permanent errors
   - Max total retry time: 10 seconds

2. **Offline Mode Support**
   - File written even if callback fails completely
   - Offline indicator in response file metadata
   - Gateway can poll for missed responses
   - Automatic recovery when Gateway comes back online

3. **Error Logging and Metrics**
   - Structured JSON logs for all retry attempts
   - Error categorization (network, timeout, 4xx, 5xx)
   - Callback latency metrics (percentiles)
   - Success/failure counters per workspace

4. **Timeout Handling**
   - Per-request timeout: 5 seconds
   - Total retry timeout: 30 seconds max
   - Graceful degradation on timeout
   - Circuit breaker integration (fail fast after threshold)

5. **Response File Metadata**
   - Track callback attempts count
   - Record callback success/failure status
   - Include retry timestamps
   - Store error details for debugging

### Non-Functional Requirements

- Retry logic must not block Claude execution
- Hook must complete in < 30 seconds worst case
- Logs must be parseable for monitoring dashboards
- Must handle concurrent callback failures gracefully
- No memory leaks from failed callbacks

## Design

### Enhanced Stop Hook Script

**File**: `scripts/stop-hook.sh`

```bash
#!/bin/bash
set -euo pipefail

# ============================================================================
# Stop Hook with Retry Logic and Offline Mode
# ============================================================================

# Environment variables (set by TmuxManager):
# - REQUEST_ID, CHAT_ID, WORKSPACE_NAME, GATEWAY_CALLBACK_URL
# - CLAUDE_OUTPUT, CLAUDE_EXIT_CODE, CLAUDE_STDERR

# Constants
RESPONSE_DIR="/ipc/${WORKSPACE_NAME}/responses"
RESPONSE_FILE="${RESPONSE_DIR}/${REQUEST_ID}.json"
TEMP_FILE="${RESPONSE_FILE}.tmp"
LOG_FILE="/var/log/claude-agent/stop-hook.log"

MAX_RETRIES=3
INITIAL_BACKOFF=1
MAX_TOTAL_TIMEOUT=30
REQUEST_TIMEOUT=5
JITTER_PERCENT=20

# Ensure directories exist
mkdir -p "${RESPONSE_DIR}"
mkdir -p "$(dirname "${LOG_FILE}")"

# ============================================================================
# Logging Functions
# ============================================================================

log_json() {
  local level="$1"
  local message="$2"
  local extra="${3:-{}}"

  cat >> "${LOG_FILE}" <<EOF
{"level":"${level}","time":"$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")","component":"stop-hook","requestId":"${REQUEST_ID}","chatId":"${CHAT_ID}","workspace":"${WORKSPACE_NAME}","msg":"${message}","extra":${extra}}
EOF
}

log_info() {
  log_json "info" "$1" "${2:-{}}"
}

log_error() {
  log_json "error" "$1" "${2:-{}}"
}

log_warn() {
  log_json "warn" "$1" "${2:-{}}"
}

# ============================================================================
# Calculate exponential backoff with jitter
# ============================================================================

calculate_backoff() {
  local attempt=$1
  local base_delay=$((INITIAL_BACKOFF * (2 ** (attempt - 1))))

  # Add jitter (±20%)
  local jitter=$((base_delay * JITTER_PERCENT / 100))
  local min_delay=$((base_delay - jitter))
  local max_delay=$((base_delay + jitter))

  # Random delay between min and max
  local delay=$((min_delay + RANDOM % (max_delay - min_delay + 1)))

  echo "$delay"
}

# ============================================================================
# Write response file with metadata
# ============================================================================

write_response_file() {
  local callback_success="$1"
  local callback_attempts="$2"
  local callback_error="${3:-}"
  local retry_timestamps="${4:-[]}"

  cat > "${TEMP_FILE}" <<EOF
{
  "requestId": "${REQUEST_ID}",
  "chatId": "${CHAT_ID}",
  "workspace": "${WORKSPACE_NAME}",
  "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "output": $(echo "${CLAUDE_OUTPUT}" | jq -Rs .),
  "exitCode": ${CLAUDE_EXIT_CODE},
  "error": $(echo "${CLAUDE_STDERR}" | jq -Rs .),
  "callback": {
    "success": ${callback_success},
    "attempts": ${callback_attempts},
    "error": $(echo "${callback_error}" | jq -Rs .),
    "retryTimestamps": ${retry_timestamps}
  }
}
EOF

  # Atomic rename
  mv "${TEMP_FILE}" "${RESPONSE_FILE}"

  log_info "Response file written" "{\"success\":${callback_success},\"attempts\":${callback_attempts}}"
}

# ============================================================================
# Send callback with timeout
# ============================================================================

send_callback() {
  local url="$1"
  local attempt="$2"
  local start_time=$(date +%s%3N)

  local payload=$(cat <<EOF
{
  "requestId": "${REQUEST_ID}",
  "chatId": "${CHAT_ID}",
  "workspace": "${WORKSPACE_NAME}"
}
EOF
)

  local http_code
  local response

  # Use curl with timeout and capture HTTP code
  http_code=$(curl -X POST \
    -H "Content-Type: application/json" \
    -d "${payload}" \
    --max-time ${REQUEST_TIMEOUT} \
    --silent \
    --write-out "%{http_code}" \
    --output /tmp/callback-response-${REQUEST_ID}.txt \
    "${url}" 2>&1 || echo "000")

  local end_time=$(date +%s%3N)
  local latency=$((end_time - start_time))

  response=$(cat /tmp/callback-response-${REQUEST_ID}.txt 2>/dev/null || echo "")
  rm -f /tmp/callback-response-${REQUEST_ID}.txt

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

  log_info "Callback attempt ${attempt}" "{\"httpCode\":\"${http_code}\",\"latency\":${latency},\"errorType\":\"${error_type}\"}"

  # Return success status
  if [[ "$http_code" =~ ^2[0-9]{2}$ ]]; then
    return 0
  else
    # Export error type for retry decision
    export LAST_ERROR_TYPE="$error_type"
    export LAST_HTTP_CODE="$http_code"
    return 1
  fi
}

# ============================================================================
# Retry logic with exponential backoff
# ============================================================================

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
      break
    fi

    # Add comma for next timestamp
    retry_timestamps="${retry_timestamps},"

    # Wait before retry (unless last attempt)
    if [ $retry_count -lt $MAX_RETRIES ]; then
      local backoff=$(calculate_backoff $retry_count)
      log_info "Retrying after backoff" "{\"attempt\":${retry_count},\"backoff\":${backoff}}"
      sleep "$backoff"
    fi
  done

  # All retries failed - enter offline mode
  retry_timestamps="${retry_timestamps}]"
  write_response_file "false" "$retry_count" "${LAST_ERROR_TYPE}: HTTP ${LAST_HTTP_CODE}" "$retry_timestamps"
  log_error "Callback failed after all retries" "{\"attempts\":${retry_count},\"errorType\":\"${LAST_ERROR_TYPE}\"}"

  return 1
}

# ============================================================================
# Main Execution
# ============================================================================

main() {
  log_info "Stop Hook started" "{}"

  # Validate environment variables
  if [[ -z "${REQUEST_ID:-}" ]] || [[ -z "${CHAT_ID:-}" ]] || [[ -z "${WORKSPACE_NAME:-}" ]]; then
    log_error "Missing required environment variables" "{}"
    exit 1
  fi

  # Attempt callback with retry
  if retry_callback "${GATEWAY_CALLBACK_URL}"; then
    exit 0
  else
    # Offline mode - file written, callback failed
    log_warn "Entering offline mode" "{}"
    exit 0  # Don't fail the hook
  fi
}

# Run main function
main
```

### Callback Endpoint Enhancement

**File**: `src/gateway/routes/callback.ts` (modifications)

```typescript
import { FastifyInstance } from 'fastify';
import { logger } from '../utils/logger';
import { ClaudeResponseFile } from '../types';

interface CallbackMetrics {
  totalCallbacks: number;
  successCount: number;
  failureCount: number;
  latencyMs: number[];
}

const metrics: Map<string, CallbackMetrics> = new Map();

export async function callbackRoutes(fastify: FastifyInstance) {
  fastify.post('/claude-callback', async (request, reply) => {
    const startTime = Date.now();

    const { requestId, chatId, workspace } = request.body as {
      requestId: string;
      chatId: string;
      workspace: string;
    };

    try {
      // Validate request
      if (!requestId || !chatId || !workspace) {
        logger.warn({ body: request.body }, 'Invalid callback payload');
        return reply.code(400).send({ error: 'Missing required fields' });
      }

      // Read response file
      const responsePath = `/ipc/${workspace}/responses/${requestId}.json`;
      const responseData: ClaudeResponseFile = await fs.readFile(responsePath, 'utf-8')
        .then(JSON.parse)
        .catch((err) => {
          logger.error({ err, requestId, responsePath }, 'Failed to read response file');
          throw new Error('Response file not found');
        });

      // Update metrics
      const latency = Date.now() - startTime;
      updateMetrics(workspace, true, latency);

      // Check if callback was already retried
      if (responseData.callback && !responseData.callback.success) {
        logger.warn({
          requestId,
          attempts: responseData.callback.attempts,
          error: responseData.callback.error,
        }, 'Callback succeeded after retries');
      }

      // Process response (send to Telegram, update DB, etc.)
      await processClaudeResponse(responseData);

      // Clean up request tracking
      cleanupService.untrackRequest(requestId);

      logger.info({
        requestId,
        chatId,
        workspace,
        latency,
        retries: responseData.callback?.attempts || 1,
      }, 'Callback processed successfully');

      return reply.code(200).send({ success: true });

    } catch (err) {
      const latency = Date.now() - startTime;
      updateMetrics(workspace, false, latency);

      logger.error({ err, requestId, chatId, workspace }, 'Callback processing failed');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  // Metrics endpoint
  fastify.get('/callback/metrics', async (request, reply) => {
    const allMetrics = Array.from(metrics.entries()).map(([workspace, m]) => ({
      workspace,
      total: m.totalCallbacks,
      success: m.successCount,
      failure: m.failureCount,
      successRate: ((m.successCount / m.totalCallbacks) * 100).toFixed(2) + '%',
      avgLatency: (m.latencyMs.reduce((a, b) => a + b, 0) / m.latencyMs.length).toFixed(2) + 'ms',
      p95Latency: percentile(m.latencyMs, 95).toFixed(2) + 'ms',
      p99Latency: percentile(m.latencyMs, 99).toFixed(2) + 'ms',
    }));

    return reply.send({ metrics: allMetrics });
  });
}

function updateMetrics(workspace: string, success: boolean, latency: number): void {
  if (!metrics.has(workspace)) {
    metrics.set(workspace, {
      totalCallbacks: 0,
      successCount: 0,
      failureCount: 0,
      latencyMs: [],
    });
  }

  const m = metrics.get(workspace)!;
  m.totalCallbacks++;
  if (success) m.successCount++;
  else m.failureCount++;

  m.latencyMs.push(latency);

  // Keep only last 1000 latency samples
  if (m.latencyMs.length > 1000) {
    m.latencyMs.shift();
  }
}

function percentile(arr: number[], p: number): number {
  const sorted = arr.slice().sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[index] || 0;
}
```

### Response File Type Update

**File**: `src/types/ipc.ts`

```typescript
export interface ClaudeResponseFile {
  requestId: string;
  chatId: string;
  workspace: string;
  timestamp: string;
  output: string;
  exitCode: number;
  error: string;
  callback?: {
    success: boolean;
    attempts: number;
    error: string;
    retryTimestamps: string[];
  };
}
```

## Acceptance Criteria

- [ ] Stop Hook retries callback 3 times with exponential backoff
- [ ] Backoff timing: 1s (±20%), 2s (±20%), 4s (±20%)
- [ ] Jitter prevents all retries happening at exact same time
- [ ] Client errors (4xx) do not trigger retries
- [ ] Server errors (5xx) and network errors trigger retries
- [ ] Total retry timeout capped at 30 seconds
- [ ] Response file written even if all callbacks fail
- [ ] Offline mode metadata included in response file
- [ ] Callback attempts count tracked in response file
- [ ] Retry timestamps recorded for debugging
- [ ] Structured JSON logs written for all attempts
- [ ] Error categorization correct (network, timeout, 4xx, 5xx)
- [ ] Callback metrics endpoint returns success rate and latency
- [ ] Hook completes in < 1 second when callback succeeds
- [ ] Hook completes in < 10 seconds when retries needed

## File Changes

### New Files
1. `tests/integration/stop-hook-retry.test.sh` - Integration tests
2. `tests/unit/callback-metrics.test.ts` - Metrics unit tests

### Modified Files
1. `scripts/stop-hook.sh` - Add retry logic and offline mode
2. `src/gateway/routes/callback.ts` - Add metrics tracking
3. `src/types/ipc.ts` - Add callback metadata to response type
4. `src/dockers/Dockerfile.agent` - Ensure jq, curl installed
5. `.env.example` - Add retry configuration variables

### Deleted Files
- None

## Test Scenarios

### Test 1: Successful Callback (No Retry)

```bash
# Start Gateway
cd src/gateway && bun run index.ts &

# Simulate Claude execution with callback
export REQUEST_ID="test-success-001"
export CHAT_ID="123"
export WORKSPACE_NAME="cc-bridge"
export GATEWAY_CALLBACK_URL="http://localhost:8080/claude-callback"
export CLAUDE_OUTPUT="Hello World"
export CLAUDE_EXIT_CODE="0"
export CLAUDE_STDERR=""

# Run Stop Hook
./scripts/stop-hook.sh

# Check logs - should show 1 attempt, success
grep "test-success-001" /var/log/claude-agent/stop-hook.log | grep "Callback succeeded"

# Check response file
jq '.callback.success' /ipc/cc-bridge/responses/test-success-001.json
# Expected: true

jq '.callback.attempts' /ipc/cc-bridge/responses/test-success-001.json
# Expected: 1
```

### Test 2: Retry on Network Failure

```bash
# Gateway not running (connection refused)
export GATEWAY_CALLBACK_URL="http://localhost:9999/callback"
export REQUEST_ID="test-retry-001"

# Run Stop Hook
time ./scripts/stop-hook.sh

# Should take ~7 seconds (1s + 2s + 4s backoff)
# Expected: real 0m7.XXXs

# Check logs - should show 3 attempts
grep "test-retry-001" /var/log/claude-agent/stop-hook.log | grep "Callback attempt"
# Expected: 3 lines

# Check response file - callback failed but file exists
jq '.callback.success' /ipc/cc-bridge/responses/test-retry-001.json
# Expected: false

jq '.callback.attempts' /ipc/cc-bridge/responses/test-retry-001.json
# Expected: 3

jq '.callback.error' /ipc/cc-bridge/responses/test-retry-001.json
# Expected: "network: HTTP 000"
```

### Test 3: No Retry on Client Error (4xx)

```bash
# Mock Gateway that returns 400
(while true; do echo -e "HTTP/1.1 400 Bad Request\r\n\r\n" | nc -l 8080; done) &

export GATEWAY_CALLBACK_URL="http://localhost:8080/callback"
export REQUEST_ID="test-4xx-001"

# Run Stop Hook
time ./scripts/stop-hook.sh

# Should NOT retry, exit immediately
# Expected: real 0m0.XXXs (< 2 seconds)

# Check logs - should show only 1 attempt
grep "test-4xx-001" /var/log/claude-agent/stop-hook.log | grep "Callback attempt"
# Expected: 1 line

grep "test-4xx-001" /var/log/claude-agent/stop-hook.log | grep "Client error, not retrying"
# Expected: found
```

### Test 4: Exponential Backoff Verification

```typescript
describe('Stop Hook - Exponential Backoff', () => {
  it('should use exponential backoff with jitter', async () => {
    // Mock failing Gateway
    const attempts: number[] = [];

    nock('http://localhost:8080')
      .post('/callback')
      .times(3)
      .reply(500, () => {
        attempts.push(Date.now());
        return { error: 'Server error' };
      });

    // Run Stop Hook
    await execAsync('./scripts/stop-hook.sh', {
      env: {
        REQUEST_ID: 'backoff-test',
        GATEWAY_CALLBACK_URL: 'http://localhost:8080/callback',
        // ... other env vars
      },
    });

    // Verify backoff timing
    const delay1 = attempts[1] - attempts[0];
    const delay2 = attempts[2] - attempts[1];

    // First backoff ~1s (±20%)
    expect(delay1).toBeGreaterThan(800);
    expect(delay1).toBeLessThan(1200);

    // Second backoff ~2s (±20%)
    expect(delay2).toBeGreaterThan(1600);
    expect(delay2).toBeLessThan(2400);
  });
});
```

### Test 5: Offline Mode File Writing

```bash
# No Gateway available
export GATEWAY_CALLBACK_URL="http://nonexistent:8080/callback"
export REQUEST_ID="offline-001"
export CLAUDE_OUTPUT="This is offline mode test"

# Run Stop Hook
./scripts/stop-hook.sh

# Verify file written despite callback failure
test -f /ipc/cc-bridge/responses/offline-001.json
echo "✓ File written in offline mode"

# Verify metadata shows callback failure
jq '.callback.success' /ipc/cc-bridge/responses/offline-001.json
# Expected: false

# Verify output is correct
jq -r '.output' /ipc/cc-bridge/responses/offline-001.json
# Expected: "This is offline mode test"
```

### Test 6: Metrics Endpoint

```bash
# Send multiple callbacks
for i in {1..10}; do
  curl -X POST http://localhost:8080/claude-callback \
    -H "Content-Type: application/json" \
    -d "{\"requestId\":\"req-$i\",\"chatId\":\"123\",\"workspace\":\"cc-bridge\"}"
done

# Check metrics
curl http://localhost:8080/callback/metrics

# Expected output:
# {
#   "metrics": [{
#     "workspace": "cc-bridge",
#     "total": 10,
#     "success": 10,
#     "failure": 0,
#     "successRate": "100.00%",
#     "avgLatency": "45.23ms",
#     "p95Latency": "89.50ms",
#     "p99Latency": "95.30ms"
#   }]
# }
```

### Test 7: Total Timeout Enforcement

```bash
# Mock Gateway with slow response (6 seconds per request)
(while true; do sleep 6; echo -e "HTTP/1.1 200 OK\r\n\r\n" | nc -l 8080; done) &

export GATEWAY_CALLBACK_URL="http://localhost:8080/callback"
export REQUEST_ID="timeout-test"

# Run Stop Hook with total timeout
time ./scripts/stop-hook.sh

# Should timeout before all retries complete
# Expected: real 0m30.XXXs (max 30 seconds)

# Check logs
grep "timeout-test" /var/log/claude-agent/stop-hook.log | grep "Total retry timeout exceeded"
```

## Dependencies

- Task 0113 (Stop Hook basic implementation) must be complete
- Task 0120 (File Cleanup) for cleanup service integration
- `jq` for JSON processing
- `curl` for HTTP requests
- Bash 4.0+ for associative arrays

## Implementation Notes

### Jitter Calculation

Jitter prevents thundering herd problem when many hooks retry simultaneously:

```bash
# Without jitter: All hooks retry at exact 1s, 2s, 4s
# With jitter: Hooks retry at 0.8-1.2s, 1.6-2.4s, 3.2-4.8s
```

### Error Categorization

Different errors need different retry strategies:

- **Network errors (connection refused)**: Retry - Gateway may be restarting
- **Timeouts (408, 504)**: Retry - Gateway may be overloaded
- **Server errors (5xx)**: Retry - Temporary Gateway issue
- **Client errors (4xx)**: Don't retry - Bad request format
- **Success (2xx)**: Stop - Callback succeeded

### Structured Logging

All logs use JSON format for easy parsing:

```json
{
  "level": "info",
  "time": "2026-02-07T10:30:45.123Z",
  "component": "stop-hook",
  "requestId": "req-001",
  "chatId": "123",
  "workspace": "cc-bridge",
  "msg": "Callback succeeded",
  "extra": {"attempts": 2}
}
```

## Rollback Plan

If retry logic causes issues:

1. Revert to simple callback (no retry):
   ```bash
   git checkout origin/main -- scripts/stop-hook.sh
   ```

2. Set max retries to 0:
   ```bash
   export MAX_RETRIES=0
   ```

3. All files still written, just no retry resilience

## Success Metrics

- Callback success rate >99% in production
- Average retry count <1.1 (most succeed first try)
- P95 latency <200ms for successful callbacks
- P95 latency <10s for retried callbacks
- Zero data loss (files always written)
- Offline mode handles 100% of Gateway outages
- Structured logs parseable by monitoring tools

