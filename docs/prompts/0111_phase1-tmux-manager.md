---
wbs: "0111"
title: "Phase 1.2: TmuxManager Implementation"
status: "pending"
priority: "critical"
complexity: "high"
estimated_hours: 8
phase: "phase-1-core-persistent-sessions"
dependencies: ["0110"]
created: 2026-02-07
impl_progress:
  planning: completed
  design: pending
  implementation: pending
  review: pending
  testing: pending
---

# Phase 1.2: TmuxManager Implementation

## Description

Implement the TmuxManager class to manage persistent tmux sessions inside Docker containers. This manager creates, monitors, and communicates with Claude sessions running in tmux panes.

## Requirements

### Functional Requirements

1. **Session Lifecycle Management**
   - Create new tmux session with unique name (e.g., `claude-workspace-{chatId}`)
   - Check if session exists before creating
   - Send commands to existing sessions
   - Kill sessions on cleanup

2. **Command Execution**
   - Send prompts to Claude via `tmux send-keys`
   - Handle special characters and escaping
   - Support multi-line prompts
   - Capture session metadata (created time, last used)

3. **Session Discovery**
   - List all active tmux sessions in container
   - Map sessions to chat IDs and workspaces
   - Detect orphaned sessions (no recent activity)

### Non-Functional Requirements

- Command execution must be atomic (no race conditions)
- Session names must be deterministic and collision-free
- Error handling for stale/dead sessions
- Maximum 10 concurrent sessions per container (resource limit)

## Design

### TmuxManager Class Structure

**File**: `src/gateway/services/tmux-manager.ts`

```typescript
export interface TmuxSessionInfo {
  sessionName: string;
  workspace: string;
  chatId: string | number;
  createdAt: Date;
  lastUsedAt: Date;
  containerId: string;
}

export interface TmuxManagerConfig {
  maxSessionsPerContainer?: number;
  sessionIdleTimeoutMs?: number;
}

export class TmuxManager {
  private sessions: Map<string, TmuxSessionInfo>;

  constructor(config?: TmuxManagerConfig);

  /**
   * Get or create a tmux session for a specific chat and workspace
   * @returns Session name
   */
  async getOrCreateSession(
    containerId: string,
    workspace: string,
    chatId: string | number
  ): Promise<string>;

  /**
   * Send a prompt to an existing tmux session
   * @returns Request ID for tracking
   */
  async sendToSession(
    containerId: string,
    sessionName: string,
    prompt: string,
    metadata: { requestId: string; chatId: string; workspace: string }
  ): Promise<void>;

  /**
   * Check if a tmux session exists
   */
  async sessionExists(
    containerId: string,
    sessionName: string
  ): Promise<boolean>;

  /**
   * List all active sessions in a container
   */
  async listSessions(containerId: string): Promise<string[]>;

  /**
   * Kill a specific session
   */
  async killSession(
    containerId: string,
    sessionName: string
  ): Promise<void>;

  /**
   * Cleanup idle sessions (not used in last N minutes)
   */
  async cleanupIdleSessions(): Promise<number>;
}
```

### Session Naming Convention

```
claude-{workspace}-{chatId}

Examples:
- claude-cc-bridge-123456789  (workspace: cc-bridge, chatId: 123456789)
- claude-myproject-987654321  (workspace: myproject, chatId: 987654321)
```

### Command Execution Strategy

```typescript
// Send command via tmux send-keys
async sendToSession(containerId, sessionName, prompt, metadata) {
  // 1. Verify session exists
  if (!await this.sessionExists(containerId, sessionName)) {
    throw new Error(`Session ${sessionName} does not exist`);
  }

  // 2. Escape prompt for shell
  const escapedPrompt = this.escapeForShell(prompt);

  // 3. Set environment variables for Stop Hook
  const envVars = [
    `export REQUEST_ID=${metadata.requestId}`,
    `export CHAT_ID=${metadata.chatId}`,
    `export WORKSPACE_NAME=${metadata.workspace}`,
  ].join('; ');

  // 4. Build Claude command with environment
  const command = `${envVars}; claude -p "${escapedPrompt}"`;

  // 5. Send to tmux session
  await this.execInContainer(containerId, [
    'tmux', 'send-keys', '-t', sessionName, command, 'C-m'
  ]);

  // 6. Update last used timestamp
  this.updateSessionTimestamp(sessionName);
}
```

## Acceptance Criteria

- [ ] TmuxManager can create new sessions successfully
- [ ] Session names follow the convention `claude-{workspace}-{chatId}`
- [ ] `getOrCreateSession()` reuses existing sessions if they exist
- [ ] `sendToSession()` successfully sends prompts to Claude
- [ ] Multi-line prompts are handled correctly
- [ ] Special characters (quotes, newlines, $, etc.) are escaped properly
- [ ] Session metadata (created/lastUsed times) is tracked accurately
- [ ] `listSessions()` returns all active sessions in container
- [ ] `killSession()` terminates sessions cleanly
- [ ] Idle sessions are cleaned up after configured timeout
- [ ] Concurrent requests to same session are handled safely
- [ ] Error handling for non-existent containers
- [ ] Error handling for tmux command failures

## File Changes

### New Files
1. `src/gateway/services/tmux-manager.ts` - Main TmuxManager implementation
2. `src/gateway/tests/tmux-manager.test.ts` - Unit tests

### Modified Files
1. `src/gateway/consts.ts` - Add TMUX-related constants

### Deleted Files
- None

## Test Scenarios

### Test 1: Session Creation
```typescript
const manager = new TmuxManager();
const containerId = 'claude-cc-bridge';
const sessionName = await manager.getOrCreateSession(
  containerId,
  'cc-bridge',
  '123456789'
);

// Verify session exists
expect(sessionName).toBe('claude-cc-bridge-123456789');
expect(await manager.sessionExists(containerId, sessionName)).toBe(true);

// Verify session appears in list
const sessions = await manager.listSessions(containerId);
expect(sessions).toContain(sessionName);
```

### Test 2: Session Reuse
```typescript
const manager = new TmuxManager();
const session1 = await manager.getOrCreateSession(
  containerId, 'cc-bridge', '123'
);
const session2 = await manager.getOrCreateSession(
  containerId, 'cc-bridge', '123'
);

// Should return same session
expect(session1).toBe(session2);
```

### Test 3: Send Command to Session
```typescript
const manager = new TmuxManager();
const sessionName = await manager.getOrCreateSession(
  containerId, 'cc-bridge', '123'
);

await manager.sendToSession(containerId, sessionName, 'Hello Claude!', {
  requestId: 'req-001',
  chatId: '123',
  workspace: 'cc-bridge'
});

// No error means success
// Actual Claude response tested in integration tests
```

### Test 4: Special Character Escaping
```typescript
const testCases = [
  'Simple message',
  'Message with "quotes"',
  'Message with $variables',
  'Multi\nline\nmessage',
  "Message with 'single quotes'",
  'Message with `backticks`',
];

for (const prompt of testCases) {
  await manager.sendToSession(containerId, sessionName, prompt, metadata);
  // Should not throw errors
}
```

### Test 5: Session Cleanup
```typescript
const manager = new TmuxManager({ sessionIdleTimeoutMs: 1000 });

// Create session
const sessionName = await manager.getOrCreateSession(
  containerId, 'cc-bridge', '123'
);

// Wait for timeout
await new Promise(resolve => setTimeout(resolve, 1500));

// Run cleanup
const cleaned = await manager.cleanupIdleSessions();
expect(cleaned).toBe(1);

// Verify session is gone
expect(await manager.sessionExists(containerId, sessionName)).toBe(false);
```

### Test 6: Concurrent Requests
```typescript
const manager = new TmuxManager();
const sessionName = await manager.getOrCreateSession(
  containerId, 'cc-bridge', '123'
);

// Send multiple prompts concurrently
const promises = [
  manager.sendToSession(containerId, sessionName, 'Prompt 1', {...}),
  manager.sendToSession(containerId, sessionName, 'Prompt 2', {...}),
  manager.sendToSession(containerId, sessionName, 'Prompt 3', {...}),
];

// Should all complete without errors
await Promise.all(promises);
```

### Test 7: Container Error Handling
```typescript
const manager = new TmuxManager();

// Non-existent container
await expect(
  manager.getOrCreateSession('invalid-container', 'test', '123')
).rejects.toThrow('Container not found');
```

## Dependencies

- Task 0110 (Docker + tmux setup) must be complete
- Docker must support `docker exec` commands
- tmux installed in Docker container

## Implementation Notes

### Shell Escaping Strategy

```typescript
private escapeForShell(text: string): string {
  // Replace single quotes with '\'' (close quote, escaped quote, open quote)
  return text.replace(/'/g, "'\\''");
}

// Usage: Wrap in single quotes for safety
const command = `claude -p '${this.escapeForShell(prompt)}'`;
```

### Environment Variable Passing

```typescript
// Option 1: Inline environment variables (preferred for one-off commands)
tmux send-keys -t session "REQUEST_ID=123 CHAT_ID=456 claude -p 'prompt'" C-m

// Option 2: tmux set-environment (persistent across session)
tmux set-environment -t session REQUEST_ID 123
tmux set-environment -t session CHAT_ID 456
tmux send-keys -t session "claude -p 'prompt'" C-m
```

### Session Tracking

```typescript
// Store session metadata in memory (survives Gateway restart via discovery)
private sessions: Map<string, TmuxSessionInfo> = new Map();

// Persist to disk for recovery?
// Option: Store in SQLite alongside message history
```

## Rollback Plan

If TmuxManager implementation fails:
1. Keep using existing `executeClaudeRaw()` with one-shot IPC
2. TmuxManager is additive, doesn't break existing functionality
3. Can disable via feature flag: `ENABLE_TMUX_SESSIONS=false`

## Success Metrics

- Session creation completes in <500ms
- Command sending completes in <100ms
- Zero session name collisions
- <1% session creation failures
- All test scenarios pass
- No memory leaks from session tracking
