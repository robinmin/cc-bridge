---
wbs: "0113"
title: "Phase 1.4: Stop Hook Script Implementation"
status: "pending"
priority: "critical"
complexity: "medium"
estimated_hours: 5
phase: "phase-1-core-persistent-sessions"
dependencies: ["0112"]
created: 2026-02-07
impl_progress:
  planning: completed
  design: pending
  implementation: pending
  review: pending
  testing: pending
---

# Phase 1.4: Stop Hook Script Implementation

## Description

Implement the Stop Hook script that runs after each Claude execution completes. This script captures Claude's output, writes it to the filesystem, and sends a callback notification to the Gateway.

## Requirements

### Functional Requirements

1. **Output Capture**
   - Capture stdout and stderr from Claude
   - Handle both successful and error exits
   - Preserve output formatting (newlines, special chars)
   - Support large outputs (>10MB)

2. **File Writing**
   - Write response to `/ipc/{workspace}/responses/{requestId}.json`
   - Include metadata (exit code, timestamp, duration)
   - Use atomic writes (temp + rename)
   - Handle write errors gracefully

3. **Callback Notification**
   - POST minimal payload to Gateway callback URL
   - Include only: requestId, chatId, workspace
   - Retry on failure (max 3 attempts)
   - Timeout after 5 seconds

### Non-Functional Requirements

- Hook execution must complete in <1 second
- Must not block Claude from showing output to user
- Must handle network failures gracefully
- Must work in offline mode (no Gateway available)

## Design

### Stop Hook Configuration

**File**: `~/.claude/hooks/stop.json`

```json
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
```

### Stop Hook Script

**File**: `scripts/stop-hook.sh`

```bash
#!/bin/bash
set -euo pipefail

# Environment variables (set by TmuxManager before each command):
# - REQUEST_ID: Unique request identifier
# - CHAT_ID: Telegram chat ID
# - WORKSPACE_NAME: Current workspace name
# - GATEWAY_CALLBACK_URL: Gateway callback endpoint

# Constants
RESPONSE_DIR="/ipc/${WORKSPACE_NAME}/responses"
RESPONSE_FILE="${RESPONSE_DIR}/${REQUEST_ID}.json"
TEMP_FILE="${RESPONSE_FILE}.tmp"
MAX_RETRIES=3
RETRY_DELAY=1

# Ensure response directory exists
mkdir -p "${RESPONSE_DIR}"

# Capture Claude output from environment variables set by Claude CLI
# (Claude sets these after execution)
CLAUDE_OUTPUT="${CLAUDE_OUTPUT:-}"
CLAUDE_EXIT_CODE="${CLAUDE_EXIT_CODE:-0}"
CLAUDE_STDERR="${CLAUDE_STDERR:-}"

# Build response JSON
cat > "${TEMP_FILE}" <<EOF
{
  "requestId": "${REQUEST_ID}",
  "chatId": "${CHAT_ID}",
  "workspace": "${WORKSPACE_NAME}",
  "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "output": $(echo "${CLAUDE_OUTPUT}" | jq -Rs .),
  "exitCode": ${CLAUDE_EXIT_CODE},
  "error": $(echo "${CLAUDE_STDERR}" | jq -Rs .)
}
EOF

# Atomic rename
mv "${TEMP_FILE}" "${RESPONSE_FILE}"

# Send callback to Gateway
send_callback() {
  local url="${GATEWAY_CALLBACK_URL}"
  local payload=$(cat <<EOF
{
  "requestId": "${REQUEST_ID}",
  "chatId": "${CHAT_ID}",
  "workspace": "${WORKSPACE_NAME}"
}
EOF
)

  curl -X POST \
    -H "Content-Type: application/json" \
    -d "${payload}" \
    --max-time 5 \
    --silent \
    --fail \
    "${url}" || return 1
}

# Retry logic for callback
retry_count=0
while [ $retry_count -lt $MAX_RETRIES ]; do
  if send_callback; then
    exit 0
  fi

  retry_count=$((retry_count + 1))
  [ $retry_count -lt $MAX_RETRIES ] && sleep $RETRY_DELAY
done

# Callback failed, but file is written - Gateway can poll
exit 0
```

### Hook Installation

**File**: `scripts/install-hooks.sh`

```bash
#!/bin/bash
# Install Stop Hook into Claude configuration

HOOK_DIR="$HOME/.claude/hooks"
HOOK_CONFIG="${HOOK_DIR}/stop.json"

# Create hooks directory
mkdir -p "${HOOK_DIR}"

# Write hook configuration
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

# Make hook script executable
chmod +x /app/scripts/stop-hook.sh

echo "Stop Hook installed successfully"
```

## Acceptance Criteria

- [ ] Stop Hook script is executable and has correct permissions
- [ ] Hook runs automatically after each Claude execution
- [ ] Response files are created in correct location
- [ ] JSON structure matches ClaudeResponseFile interface
- [ ] Large outputs (>10MB) are handled correctly
- [ ] Special characters in output are escaped properly
- [ ] Exit codes are captured accurately
- [ ] Callback POSTs to Gateway successfully
- [ ] Callback retries on failure (up to 3 times)
- [ ] Hook completes in <1 second for normal outputs
- [ ] Hook doesn't block Claude from displaying output
- [ ] Works when Gateway is offline (file still written)
- [ ] Environment variables are read correctly

## File Changes

### New Files
1. `scripts/stop-hook.sh` - Main Stop Hook script
2. `scripts/install-hooks.sh` - Hook installation script
3. `docker/agent/scripts/stop-hook.sh` - Container-specific copy

### Modified Files
1. `src/dockers/docker-compose.yml` - Mount scripts directory
2. `src/dockers/Dockerfile.agent` - Install jq, curl dependencies

### Deleted Files
- None

## Test Scenarios

### Test 1: Hook Execution
```bash
# Inside container, simulate Claude execution
export REQUEST_ID="test-001"
export CHAT_ID="123"
export WORKSPACE_NAME="cc-bridge"
export GATEWAY_CALLBACK_URL="http://host.docker.internal:8080/claude-callback"
export CLAUDE_OUTPUT="Hello from Claude!"
export CLAUDE_EXIT_CODE="0"
export CLAUDE_STDERR=""

# Run hook
/app/scripts/stop-hook.sh

# Verify file created
test -f /ipc/cc-bridge/responses/test-001.json
echo "✓ Response file created"

# Verify JSON structure
jq . /ipc/cc-bridge/responses/test-001.json
# Expected: Valid JSON with all fields
```

### Test 2: Large Output Handling
```bash
# Generate large output (10MB)
export CLAUDE_OUTPUT=$(head -c 10485760 /dev/urandom | base64)

/app/scripts/stop-hook.sh

# Verify file size
FILE_SIZE=$(stat -f%z /ipc/cc-bridge/responses/test-002.json)
[ $FILE_SIZE -gt 10000000 ] && echo "✓ Large output handled"
```

### Test 3: Special Character Escaping
```bash
export CLAUDE_OUTPUT='Output with "quotes" and \n newlines and $variables'

/app/scripts/stop-hook.sh

# Verify JSON is valid
jq -e . /ipc/cc-bridge/responses/test-003.json > /dev/null
echo "✓ Special characters escaped correctly"
```

### Test 4: Callback Success
```bash
# Start mock Gateway server
nc -l 8080 > callback-received.txt &

# Run hook
export REQUEST_ID="test-004"
/app/scripts/stop-hook.sh

# Verify callback received
grep "test-004" callback-received.txt
echo "✓ Callback sent successfully"
```

### Test 5: Callback Retry on Failure
```bash
# No Gateway running (connection refused)
export GATEWAY_CALLBACK_URL="http://localhost:9999/callback"

# Run hook (should retry 3 times, then give up)
time /app/scripts/stop-hook.sh

# Verify file still created despite callback failure
test -f /ipc/cc-bridge/responses/test-005.json
echo "✓ File written even when callback fails"
```

### Test 6: Exit Code Capture
```bash
export CLAUDE_EXIT_CODE="1"
export CLAUDE_STDERR="Error: Something went wrong"

/app/scripts/stop-hook.sh

# Verify exit code in file
jq -e '.exitCode == 1' /ipc/cc-bridge/responses/test-006.json
echo "✓ Exit code captured correctly"
```

### Test 7: Concurrent Executions
```bash
# Run 5 hooks concurrently
for i in {1..5}; do
  (
    export REQUEST_ID="concurrent-$i"
    export CLAUDE_OUTPUT="Output $i"
    /app/scripts/stop-hook.sh
  ) &
done
wait

# Verify all 5 files created
test -f /ipc/cc-bridge/responses/concurrent-1.json
test -f /ipc/cc-bridge/responses/concurrent-5.json
echo "✓ Concurrent executions handled"
```

## Dependencies

- Task 0112 (Filesystem IPC) must be complete
- `jq` installed in Docker container (for JSON escaping)
- `curl` installed in Docker container (for callbacks)
- Bash 4.0+ in Docker container

## Implementation Notes

### Environment Variables from Claude

Claude CLI sets these variables after execution:
- `CLAUDE_OUTPUT` - Combined stdout/stderr
- `CLAUDE_EXIT_CODE` - Process exit code
- `CLAUDE_STDERR` - Error output (if any)
- `CLAUDE_MODEL` - Model used (optional)
- `CLAUDE_TOKENS` - Token count (optional)

### JSON Escaping with jq

```bash
# Safe JSON escaping for any string
escaped=$(echo "$RAW_STRING" | jq -Rs .)
# Result: "properly escaped \"string\""
```

### Callback Payload Size

Keep callback minimal to reduce network overhead:
```json
{
  "requestId": "req-001",
  "chatId": "123",
  "workspace": "cc-bridge"
}
```

Gateway reads full output from filesystem.

### Async Execution

Mark hook as `"async": true` in configuration so Claude doesn't wait for hook completion before returning to user.

## Rollback Plan

If Stop Hook fails:
1. Disable hook in `~/.claude/hooks/stop.json`
2. Fall back to existing stdio IPC
3. Can toggle via environment: `ENABLE_STOP_HOOK=false`

## Success Metrics

- Hook executes in <500ms for typical outputs
- 100% success rate for file writes
- >95% success rate for callbacks (with retries)
- Zero data loss
- No impact on Claude's responsiveness
- All test scenarios pass
