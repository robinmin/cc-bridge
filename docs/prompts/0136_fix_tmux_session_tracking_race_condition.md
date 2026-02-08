---
wbs: "0136"
title: "Fix TmuxManager Session Tracking Race Condition"
status: "completed"
priority: "high"
complexity: "medium"
estimated_hours: 3
phase: "code-review-fixes"
dependencies: []
created: 2026-02-07
impl_progress:
  planning: completed
  design: completed
  implementation: completed
  review: completed
  testing: completed
---

# Fix TmuxManager Session Tracking Race Condition

## Description

Fix race condition in TmuxManager session tracking at `src/gateway/services/tmux-manager.ts:199-206, 439`. The in-memory session tracking can become out of sync with actual tmux sessions, leading to operations on non-existent sessions.

## Requirements

### Functional Requirements

1. Implement background sync mechanism to keep session tracking accurate
2. Verify session existence before operations
3. Handle concurrent session operations safely
4. Provide fallback to tmux when tracking fails

### Non-Functional Requirements

- Operations remain fast despite verification
- No deadlocks from concurrent operations
- Graceful degradation when tmux is unavailable

## Design

### Current State Analysis

**File**: `src/gateway/services/tmux-manager.ts`

The issue occurs because:
1. In-memory `sessions` Map tracks sessions
2. Actual tmux sessions can be created/destroyed externally
3. No verification that tracked sessions still exist
4. No background sync with actual tmux state

### Solution Design

**File**: `src/gateway/services/tmux-manager.ts`

```typescript
export class TmuxManager {
  private sessions: Map<string, SessionInfo> = new Map();
  private syncLock: Mutex = new Mutex();  // Add mutex for concurrent safety
  private lastSyncTime: number = 0;
  private SYNC_INTERVAL = 5000;  // Sync every 5 seconds

  /**
   * Verify session exists before operation
   */
  private async verifySessionExists(sessionName: string): Promise<boolean> {
    // Use cached sync if recent
    const now = Date.now();
    if (now - this.lastSyncTime > this.SYNC_INTERVAL) {
      await this.syncSessions();
      this.lastSyncTime = now;
    }

    // Check if session exists in tracking
    return this.sessions.has(sessionName);
  }

  /**
   * Sync session tracking with actual tmux state
   */
  private async syncSessions(): Promise<void> {
    const release = await this.syncLock.acquire();

    try {
      // Get actual sessions from tmux
      const actualSessions = await this.listSessionsFromTmux();
      const actualNames = new Set(actualSessions.map(s => s.name));

      // Remove tracked sessions that no longer exist
      for (const [name, info] of this.sessions.entries()) {
        if (!actualNames.has(name)) {
          this.logger.debug({ sessionName: name }, 'Removing stale session from tracking');
          this.sessions.delete(name);
        }
      }

      // Add newly discovered sessions
      for (const session of actualSessions) {
        if (!this.sessions.has(session.name)) {
          this.logger.debug({ sessionName: session.name }, 'Discovered new session');
          this.sessions.set(session.name, {
            name: session.name,
            workspace: this.extractWorkspace(session.name),
            createdAt: Date.now(),  // Approximate
            lastActivityAt: Date.now(),
          });
        }
      }

      this.lastSyncTime = Date.now();
    } finally {
      release();
    }
  }

  /**
   * Get session with existence verification
   */
  async getSession(workspace: string): Promise<SessionInfo | null> {
    const sessionName = this.getSessionName(workspace);

    // Verify session exists
    const exists = await this.verifySessionExists(sessionName);
    if (!exists) {
      this.logger.warn({ workspace, sessionName }, 'Session does not exist');
      return null;
    }

    return this.sessions.get(sessionName) || null;
  }

  /**
   * Send command with verification
   */
  async sendCommand(
    command: string,
    context: CommandContext
  ): Promise<void> {
    const { sessionName } = context;

    // Verify before sending
    const exists = await this.verifySessionExists(sessionName);
    if (!exists) {
      throw new Error(`Session ${sessionName} does not exist`);
    }

    // Send via tmux with direct verification
    try {
      await this.sendToSession(sessionName, command);
    } catch (error) {
      // Sync and retry once
      await this.syncSessions();

      const stillExists = await this.verifySessionExists(sessionName);
      if (!stillExists) {
        throw new Error(`Session ${sessionName} no longer exists`);
      }

      // Retry sending
      await this.sendToSession(sessionName, command);
    }
  }

  /**
   * Kill session with verification
   */
  async killSession(sessionName: string): Promise<void> {
    const release = await this.syncLock.acquire();

    try {
      // Verify exists first
      const exists = await this.verifySessionExists(sessionName);
      if (!exists) {
        this.logger.warn({ sessionName }, 'Session does not exist, skipping kill');
        return;
      }

      // Kill via tmux
      await this.execCommand('tmux', ['kill-session', '-t', sessionName]);

      // Remove from tracking
      this.sessions.delete(sessionName);

      this.logger.info({ sessionName }, 'Session killed');
    } finally {
      release();
    }
  }

  /**
   * List sessions from actual tmux (not cached)
   */
  private async listSessionsFromTmux(): Promise<Array<{name: string}>> {
    try {
      const { stdout } = await this.execCommand('tmux', ['ls', '-F', '#{session_name}']);

      if (!stdout) {
        return [];
      }

      const lines = stdout.trim().split('\n');
      return lines
        .filter(line => line.trim())
        .map(name => ({ name: line.trim() }));
    } catch (error) {
      // tmux ls returns error if no sessions exist
      if (error.message.includes('no sessions')) {
        return [];
      }
      throw error;
    }
  }

  /**
   * Extract workspace from session name
   */
  private extractWorkspace(sessionName: string): string {
    // Session names are like "claude-workspace-name"
    const prefix = this.config.SESSION_NAME_PREFIX || 'claude-';
    return sessionName.slice(prefix.length);
  }
}
```

### Simple Mutex Implementation

```typescript
/**
 * Simple mutex for concurrent operation safety
 */
class Mutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      if (!this.locked) {
        this.locked = true;
        resolve(() => this.release());
      } else {
        this.queue.push(() => {
          this.locked = true;
          resolve(() => this.release());
        });
      }
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}
```

## Acceptance Criteria

- [ ] Session tracking stays in sync with actual tmux state
- [ ] Operations verify session existence before executing
- [ ] Background sync runs periodically
- [ ] Concurrent operations are safe (no deadlocks)
- [ ] Stale sessions are cleaned up automatically
- [ ] New sessions are discovered automatically
- [ ] Operations fail gracefully when sessions disappear
- [ ] All tests pass including race condition tests

## File Changes

### New Files
1. `src/gateway/tests/tmux-manager-race-condition.test.ts` - Race condition tests

### Modified Files
1. `src/gateway/services/tmux-manager.ts` - Add sync and verification logic

### Deleted Files
- None

## Test Scenarios

### Test 1: Session Sync After External Deletion
```typescript
// Create session
await manager.createSession('test-workspace');
assert(await manager.verifySessionExists('claude-test-workspace') === true);

// Delete externally via tmux
await execCommand('tmux', ['kill-session', '-t', 'claude-test-workspace']);

// Verify sync catches deletion
await manager.syncSessions();
assert(await manager.verifySessionExists('claude-test-workspace') === false);
```

### Test 2: Concurrent Operations
```typescript
// Create session
await manager.createSession('test-workspace');

// Run concurrent operations
const promises = [
  manager.sendCommand('cmd1', { workspace: 'test-workspace', sessionName: 'claude-test-workspace' }),
  manager.getSession('test-workspace'),
  manager.sendCommand('cmd2', { workspace: 'test-workspace', sessionName: 'claude-test-workspace' }),
];

await Promise.all(promises);
// Should not deadlock or throw
```

### Test 3: Auto-Sync on Operations
```typescript
await manager.createSession('test-workspace');

// Wait past sync interval
await sleep(6000);

// External deletion
await execCommand('tmux', ['kill-session', '-t', 'claude-test-workspace']);

// Next operation should trigger sync and detect deletion
const result = await manager.getSession('test-workspace');
assert(result === null);  // Should detect session is gone
```

### Test 4: New Session Discovery
```typescript
// Create session externally
await execCommand('tmux', ['new-session', '-d', '-s', 'claude-external-workspace']);

// Sync should discover it
await manager.syncSessions();

const session = await manager.getSession('external-workspace');
assert(session !== null);
assert(session.name === 'claude-external-workspace');
```

## Dependencies

- None

## Implementation Notes

- Use simple mutex implementation (no external dependencies)
- Sync interval should be configurable
- Consider adding a "force sync" method for testing
- Log sync operations for debugging
- Keep sync operations fast to avoid blocking

## Rollback Plan

If sync implementation causes issues:
1. Add feature flag to disable sync
2. Make verification optional (warnings only)
3. Keep existing code paths as fallback

## Success Metrics

- Zero operations on non-existent sessions
- Sync completes in <100ms
- No deadlocks in concurrent operations
- 100% test coverage for sync logic
