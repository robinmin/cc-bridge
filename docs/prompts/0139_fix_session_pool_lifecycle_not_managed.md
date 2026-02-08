---
wbs: "0139"
title: "Fix SessionPool Lifecycle Not Managed"
status: "completed"
priority: "high"
complexity: "medium"
estimated_hours: 2
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

# Fix SessionPool Lifecycle Not Managed

## Description

Implement lifecycle management for SessionPool in `src/gateway/pipeline/agent-bot.ts:708-731`. Add cleanup method to properly release resources when the pool is no longer needed.

## Requirements

### Functional Requirements

1. Implement lifecycle management for session pools
2. Add cleanup method to release resources
3. Ensure all sessions are properly closed on cleanup
4. Handle cleanup errors gracefully

### Non-Functional Requirements

- No resource leaks after cleanup
- Graceful shutdown of all sessions
- Proper error handling during cleanup

## Design

### Current State Analysis

**File**: `src/gateway/pipeline/agent-bot.ts:708-731`

```typescript
// SessionPool created but never explicitly cleaned up
const sessionPool = new SessionPoolService(config, logger);
// ... usage ...
// No cleanup when done
```

### Solution Design

**File**: `src/gateway/services/SessionPoolService.ts`

```typescript
export class SessionPoolService {
  private sessions: Map<string, Session> = new Map();
  private destroyed = false;

  /**
   * Cleanup all sessions and release resources
   */
  async cleanup(): Promise<void> {
    if (this.destroyed) {
      return;
    }

    this.logger.info('Cleaning up SessionPool');

    const cleanupPromises: Promise<void>[] = [];

    // Cleanup all sessions
    for (const [workspace, session] of this.sessions.entries()) {
      cleanupPromises.push(
        this.cleanupSession(workspace, session).catch((err) => {
          this.logger.warn(
            { workspace, error: err },
            'Failed to cleanup session'
          );
        })
      );
    }

    // Wait for all cleanups (with timeout)
    await Promise.allSettled(cleanupPromises);

    // Clear sessions map
    this.sessions.clear();

    this.destroyed = true;
    this.logger.info('SessionPool cleanup complete');
  }

  /**
   * Cleanup a single session
   */
  private async cleanupSession(
    workspace: string,
    session: Session
  ): Promise<void> {
    try {
      // Stop accepting new requests
      session.status = 'draining';

      // Wait for active requests to complete (with timeout)
      const timeout = 5000; // 5 seconds
      const start = Date.now();

      while (session.activeRequests > 0 && Date.now() - start < timeout) {
        await sleep(100);
      }

      if (session.activeRequests > 0) {
        this.logger.warn(
          { workspace, activeRequests: session.activeRequests },
          'Session still has active requests during cleanup'
        );
      }

      // Kill the tmux session
      if (session.sessionName) {
        await this.tmuxManager.killSession(session.sessionName);
      }

      this.logger.debug({ workspace }, 'Session cleaned up');
    } catch (error) {
      this.logger.error({ workspace, error }, 'Error cleaning up session');
      throw error;
    }
  }

  /**
   * Check if pool is destroyed
   */
  isDestroyed(): boolean {
    return this.destroyed;
  }

  /**
   * Get pool statistics
   */
  getStats(): PoolStats {
    return {
      totalSessions: this.sessions.size,
      activeSessions: Array.from(this.sessions.values()).filter(
        s => s.status === 'active'
      ).length,
      drainingSessions: Array.from(this.sessions.values()).filter(
        s => s.status === 'draining'
      ).length,
      destroyed: this.destroyed,
    };
  }
}
```

**File**: `src/gateway/pipeline/agent-bot.ts`

```typescript
// In your shutdown handler
async shutdown(): Promise<void> {
  this.logger.info('Shutting down agent bot');

  // Cleanup session pool
  if (this.sessionPool && !this.sessionPool.isDestroyed()) {
    await this.sessionPool.cleanup();
  }

  // ... other cleanup ...

  this.logger.info('Agent bot shutdown complete');
}

// Add signal handlers
process.on('SIGTERM', async () => {
  await shutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await shutdown();
  process.exit(0);
});
```

## Acceptance Criteria

- [ ] `cleanup()` method releases all session resources
- [ ] All tmux sessions are killed on cleanup
- [ ] Active requests are allowed to complete before forced cleanup
- [ ] Cleanup is idempotent (safe to call multiple times)
- [ ] Proper error handling for cleanup failures
- [ ] `isDestroyed()` method returns correct state
- [ ] All tests pass

## File Changes

### New Files
1. `src/gateway/tests/session-pool-lifecycle.test.ts` - Lifecycle tests

### Modified Files
1. `src/gateway/services/SessionPoolService.ts` - Add cleanup(), isDestroyed(), getStats()
2. `src/gateway/pipeline/agent-bot.ts` - Add shutdown handler with pool cleanup

### Deleted Files
- None

## Test Scenarios

### Test 1: Basic Cleanup
```typescript
const pool = new SessionPoolService(config, logger);

// Create some sessions
await pool.getOrCreateSession('workspace1');
await pool.getOrCreateSession('workspace2');

assert(pool.getStats().totalSessions === 2);

await pool.cleanup();

assert(pool.isDestroyed() === true);
assert(pool.getStats().totalSessions === 0);
```

### Test 2: Cleanup with Active Requests
```typescript
const pool = new SessionPoolService(config, logger);
const session = await pool.getOrCreateSession('test');

// Simulate active request
session.activeRequests = 5;

// Cleanup should wait for requests to complete
const cleanupPromise = pool.cleanup();

// Requests complete
setTimeout(() => {
  session.activeRequests = 0;
}, 1000);

await cleanupPromise;
// Should complete after requests finish
```

### Test 3: Idempotent Cleanup
```typescript
const pool = new SessionPoolService(config, logger);

await pool.cleanup();
await pool.cleanup(); // Should not throw
await pool.cleanup(); // Should not throw

assert(pool.isDestroyed() === true);
```

### Test 4: Graceful Shutdown Integration
```typescript
const bot = new AgentBot(config);

// Create sessions
await bot.sessionPool.getOrCreateSession('test');

// Trigger shutdown
await bot.shutdown();

// Verify pool is cleaned up
assert(bot.sessionPool.isDestroyed() === true);
```

## Dependencies

- None

## Implementation Notes

- Add timeout for waiting on active requests
- Log cleanup progress
- Use Promise.allSettled to handle partial failures
- Mark sessions as 'draining' during cleanup
- Consider adding a force cleanup option

## Rollback Plan

If cleanup causes issues:
1. Make cleanup optional (behind feature flag)
2. Add try-catch in shutdown handler
3. Log warnings instead of throwing errors

## Success Metrics

- All sessions cleaned up on shutdown
- No orphaned tmux sessions after cleanup
- Cleanup completes in <10 seconds
- No resource leaks
