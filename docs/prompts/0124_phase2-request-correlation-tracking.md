---
wbs: "0124"
title: "Phase 2.5: Request Correlation Tracking"
status: "completed"
priority: "high"
complexity: "medium"
estimated_hours: 4
phase: "phase-2-filesystem-polish"
dependencies: ["0120", "0121", "0122"]
created: 2026-02-07
completed: 2026-02-07
impl_progress:
  planning: completed
  design: completed
  implementation: completed
  review: completed
  testing: completed
---

# Phase 2.5: Request Correlation Tracking

## Description

Implement request correlation tracking to monitor the complete lifecycle of each Claude execution request from creation through completion. Provides visibility into request state, timing metadata, and supports crash recovery with state persistence.

## Requirements

### Functional Requirements

1. **Request State Management**
   - Track requests through lifecycle states: `created` → `queued` → `processing` → `completed`/`failed`/`timeout`
   - State transitions must be atomic and persistent
   - Support multiple concurrent requests per workspace
   - State query by request ID

2. **Correlation Metadata**
   - Request ID (UUID)
   - Chat ID and workspace
   - Timestamps: created, queued, processing started, completed
   - Execution metadata: model, tokens, exit code
   - Callback metadata: success, attempts, retry timestamps
   - Error information (if applicable)

3. **State Persistence**
   - Write state to filesystem on each transition
   - Recover from crashes by reading persisted state
   - Automatic cleanup of old state files
   - Atomic state updates (write to temp file, then rename)

4. **Request Lookup**
   - Get request state by ID
   - List requests by workspace
   - List requests by state (e.g., all pending)
   - Query requests by time range

5. **Crash Recovery**
   - On startup, scan for incomplete requests
   - Mark hung requests as failed
   - Notify user of recovered requests
   - Clean up stale state files

### Non-Functional Requirements

- State lookup by ID must complete in <10ms
- State transitions must be atomic (no partial writes)
- Support 1000+ concurrent requests
- State files cleaned up after 24 hours
- Zero state corruption after crash

## Design

### Request State Schema

**File**: `src/gateway/schemas/request-state.ts`

```typescript
export interface RequestState {
  requestId: string;
  chatId: string | number;
  workspace: string;

  // State management
  state: RequestStateValue;
  previousState?: RequestStateValue;

  // Timestamps
  createdAt: number;
  queuedAt?: number;
  processingStartedAt?: number;
  completedAt?: number;
  lastUpdatedAt: number;

  // Execution metadata
  prompt?: string;
  model?: string;
  tokens?: number;
  exitCode?: number;
  output?: string;
  error?: string;

  // Callback metadata
  callback?: {
    success: boolean;
    attempts: number;
    retryTimestamps: string[];
    error?: string;
  };

  // Timeout handling
  timeoutAt?: number;
  timedOut: boolean;
}

export type RequestStateValue =
  | "created"
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "timeout";

export interface StateTransition {
  from: RequestStateValue;
  to: RequestStateValue;
  timestamp: number;
}
```

### Request Tracker Service

**File**: `src/gateway/services/RequestTracker.ts`

```typescript
import { logger } from "@/packages/logger";
import { promises as fs } from "fs";
import path from "path";

export class RequestTracker {
  private stateDir: string;
  private cache: Map<string, RequestState> = new Map();

  constructor(config: { stateBaseDir: string }) {
    this.stateDir = path.join(config.stateBaseDir, "requests");
  }

  /**
   * Initialize tracker - recover existing state
   */
  async start(): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true });
    await this.recoverState();
  }

  /**
   * Create new request
   */
  async createRequest(request: Omit<RequestState, "state" | "createdAt" | "lastUpdatedAt">): Promise<RequestState> {
    const state: RequestState = {
      ...request,
      state: "created",
      createdAt: Date.now(),
      lastUpdatedAt: Date.now(),
    };

    await this.writeState(state);
    this.cache.set(state.requestId, state);

    logger.info({ requestId: state.requestId }, "Request created");
    return state;
  }

  /**
   * Update request state
   */
  async updateState(
    requestId: string,
    updates: Partial<Pick<RequestState, "state" | "processingStartedAt" | "completedAt" | "exitCode" | "output" | "error" | "callback" | "timeoutAt" | "timedOut">>
  ): Promise<RequestState | null> {
    const current = await this.getRequest(requestId);
    if (!current) return null;

    const updated: RequestState = {
      ...current,
      ...updates,
      lastUpdatedAt: Date.now(),
      previousState: current.state,
    };

    await this.writeState(updated);
    this.cache.set(requestId, updated);

    logger.debug({ requestId, from: current.state, to: updated.state }, "State transition");
    return updated;
  }

  /**
   * Get request state
   */
  async getRequest(requestId: string): Promise<RequestState | null> {
    // Check cache first
    const cached = this.cache.get(requestId);
    if (cached) return cached;

    // Read from filesystem
    const statePath = path.join(this.stateDir, `${requestId}.json`);
    try {
      const content = await fs.readFile(statePath, "utf-8");
      const state: RequestState = JSON.parse(content);
      this.cache.set(requestId, state);
      return state;
    } catch {
      return null;
    }
  }

  /**
   * List requests by workspace
   */
  async listRequests(workspace: string, options?: {
    state?: RequestStateValue;
    limit?: number;
  }): Promise<RequestState[]> {
    const workspaceDir = path.join(this.stateDir, "by-workspace", workspace);
    try {
      const files = await fs.readdir(workspaceDir);
      const requests: RequestState[] = [];

      for (const file of files.slice(0, options?.limit || 100)) {
        const content = await fs.readFile(path.join(workspaceDir, file), "utf-8");
        const state: RequestState = JSON.parse(content);

        if (!options?.state || state.state === options.state) {
          requests.push(state);
        }
      }

      return requests.sort((a, b) => b.createdAt - a.createdAt);
    } catch {
      return [];
    }
  }

  /**
   * Write state to filesystem (atomic)
   */
  private async writeState(state: RequestState): Promise<void> {
    // Write to main location
    const mainPath = path.join(this.stateDir, `${state.requestId}.json`);
    const tmpPath = `${mainPath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(state, null, 2));
    await fs.rename(tmpPath, mainPath);

    // Write to workspace-indexed location
    const workspaceDir = path.join(this.stateDir, "by-workspace", state.workspace);
    await fs.mkdir(workspaceDir, { recursive: true });
    const wsPath = path.join(workspaceDir, `${state.requestId}.json`);
    const wsTmpPath = `${wsPath}.tmp`;
    await fs.writeFile(wsTmpPath, JSON.stringify(state, null, 2));
    await fs.rename(wsTmpPath, wsPath);
  }

  /**
   * Recover state from filesystem
   */
  private async recoverState(): Promise<void> {
    const files = await fs.readdir(this.stateDir).catch(() => []);
    let recovered = 0;

    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      try {
        const content = await fs.readFile(path.join(this.stateDir, file), "utf-8");
        const state: RequestState = JSON.parse(content);

        // Check for stale requests (>24 hours old)
        const age = Date.now() - state.lastUpdatedAt;
        if (age > 24 * 60 * 60 * 1000) {
          await this.cleanupRequest(state.requestId);
          continue;
        }

        // Check for hung requests (processing for >1 hour)
        if (state.state === "processing" && state.processingStartedAt) {
          const processingTime = Date.now() - state.processingStartedAt;
          if (processingTime > 60 * 60 * 1000) {
            await this.updateState(state.requestId, {
              state: "timeout",
              timedOut: true,
            });
          }
        }

        this.cache.set(state.requestId, state);
        recovered++;
      } catch (err) {
        logger.warn({ file, error: err }, "Failed to recover state file");
      }
    }

    logger.info({ recovered }, "State recovery complete");
  }

  /**
   * Clean up request state
   */
  private async cleanupRequest(requestId: string): Promise<void> {
    // Remove main file
    await fs.unlink(path.join(this.stateDir, `${requestId}.json`)).catch(() => {});

    // Remove workspace-indexed file (need to find workspace)
    const state = this.cache.get(requestId);
    if (state) {
      await fs.unlink(
        path.join(this.stateDir, "by-workspace", state.workspace, `${requestId}.json`)
      ).catch(() => {});
      this.cache.delete(requestId);
    }
  }

  /**
   * Stop tracker and cleanup
   */
  async stop(): Promise<void> {
    this.cache.clear();
  }
}
```

## Integration Points

### ClaudeExecutor Integration

```typescript
// In ClaudeExecutor.ts
async executeClaude(...) {
  // Create request state
  const state = await requestTracker.createRequest({
    requestId,
    chatId: config.chatId,
    workspace: config.workspace,
    prompt: text,
  });

  // Update to processing
  await requestTracker.updateState(requestId, {
    state: "processing",
    processingStartedAt: Date.now(),
  });

  // Execute Claude...
  const result = await tmuxManager.sendToSession(...);

  // Update completed state
  await requestTracker.updateState(requestId, {
    state: result.success ? "completed" : "failed",
    completedAt: Date.now(),
    exitCode: result.exitCode,
    output: result.output,
    error: result.error,
  });
}
```

### Stop Hook Integration

```typescript
// In stop-hook.sh, update state when callback completes
# After successful callback
REQUEST_STATE_DIR="${IPC_BASE_DIR}/../requests"
REQUEST_STATE_FILE="${REQUEST_STATE_DIR}/${REQUEST_ID}.json"

# Update with callback metadata
if [ -f "$REQUEST_STATE_FILE" ]; then
  tmpfile=$(mktemp)
  jq \
    --argjson callbackSuccess true \
    --argjson callbackAttempts $attempts \
    --argjson callbackTimestamps "$retry_timestamps_json" \
    '.callback = {
      success: $callbackSuccess,
      attempts: $callbackAttempts,
      retryTimestamps: $callbackTimestamps
    } | .lastUpdatedAt = now | todate' \
    "$REQUEST_STATE_FILE" > "$tmpfile"
  mv "$tmpfile" "$REQUEST_STATE_FILE"
fi
```

## Acceptance Criteria

- [ ] Request state created on execution start
- [ ] State transitions: created → processing → completed/failed
- [ ] State persisted to filesystem atomically
- [ ] Request lookup by ID returns current state
- [ ] List requests by workspace and state
- [ ] Hung requests detected on recovery (>1 hour processing)
- [ ] Old state files cleaned up (>24 hours)
- [ ] Crash recovery restores incomplete requests
- [ ] State files use atomic write (temp + rename)
- [ ] Thread-safe concurrent state updates

## File Changes

### New Files
1. `src/gateway/schemas/request-state.ts` - State schema definitions
2. `src/gateway/services/RequestTracker.ts` - Request tracking service
3. `src/gateway/tests/request-tracker.test.ts` - Unit tests
4. `scripts/update-request-state.sh` - Helper script for Stop Hook

### Modified Files
1. `src/gateway/services/claude-executor.ts` - Create/update request state
2. `scripts/stop-hook.sh` - Update request state on callback
3. `src/gateway/index.ts` - Initialize RequestTracker
4. `src/gateway/routes/status.ts` - Request status query endpoint

## Test Scenarios

### Test 1: State Transitions
```typescript
it("should track state transitions", async () => {
  const state = await tracker.createRequest({
    requestId: "test-001",
    chatId: "123",
    workspace: "test",
  });

  expect(state.state).toBe("created");

  await tracker.updateState("test-001", {
    state: "processing",
    processingStartedAt: Date.now(),
  });

  const updated = await tracker.getRequest("test-001");
  expect(updated?.state).toBe("processing");
  expect(updated?.previousState).toBe("created");
});
```

### Test 2: Crash Recovery
```typescript
it("should recover state after crash", async () => {
  // Create state
  await tracker.createRequest({
    requestId: "recovery-001",
    chatId: "123",
    workspace: "test",
  });

  // Simulate crash - clear cache
  (tracker as any).cache.clear();

  // Restart tracker
  await tracker.recoverState();

  const recovered = await tracker.getRequest("recovery-001");
  expect(recovered).toBeDefined();
  expect(recovered?.requestId).toBe("recovery-001");
});
```

### Test 3: Hung Request Detection
```typescript
it("should mark hung requests as timeout", async () => {
  await tracker.createRequest({
    requestId: "hung-001",
    chatId: "123",
    workspace: "test",
  });

  await tracker.updateState("hung-001", {
    state: "processing",
    processingStartedAt: Date.now() - (61 * 60 * 1000), // 61 minutes ago
  });

  await tracker.recoverState();

  const timedOut = await tracker.getRequest("hung-001");
  expect(timedOut?.state).toBe("timeout");
  expect(timedOut?.timedOut).toBe(true);
});
```

## Dependencies

- Task 0120 (File Cleanup) - for state file cleanup
- Task 0121 (Stop Hook Retry) - for callback metadata tracking
- Task 0122 (Callback Hardening) - for request ID validation

## Rollback Plan

If Request Tracker causes issues:
1. Disable via `ENABLE_REQUEST_TRACKER=false`
2. ClaudeExecutor operates without state tracking
3. Callback proceeds without state updates

## Success Metrics

- Request creation: <5ms
- State transition: <10ms
- Lookup by ID: <10ms (cached), <50ms (disk)
- Recovery of 1000 requests: <1s
- Zero state corruption after crash
- All test scenarios pass
