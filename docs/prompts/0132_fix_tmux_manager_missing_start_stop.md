---
wbs: "0132"
title: "Fix TmuxManager Missing start() and stop() Methods"
status: "completed"
priority: "critical"
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

# Fix TmuxManager Missing start() and stop() Methods

## Description

Implement missing `start()` and `stop()` methods in the TmuxManager class. The code in `src/agent/index.ts:48,68` calls these methods but they don't exist, causing runtime errors in HTTP mode.

## Requirements

### Functional Requirements

1. Implement `start()` method to initialize tmux manager
2. Implement `stop()` method to gracefully shutdown tmux manager
3. Ensure proper cleanup of resources on stop
4. Handle concurrent start/stop calls safely

### Non-Functional Requirements

- Methods must be idempotent (calling start twice is safe)
- Methods must handle errors gracefully
- Proper logging for lifecycle events

## Design

### Implementation Plan

**File**: `src/gateway/services/tmux-manager.ts`

```typescript
export class TmuxManager {
  private started: boolean = false;
  private stopping: boolean = false;

  /**
   * Start the tmux manager and initialize resources
   */
  async start(): Promise<void> {
    if (this.started) {
      this.logger.warn('TmuxManager already started');
      return;
    }

    try {
      // Ensure tmux server is running
      await this.ensureTmuxServer();

      // Initialize session tracking
      await this.initializeSessionTracking();

      this.started = true;
      this.logger.info('TmuxManager started successfully');
    } catch (error) {
      this.logger.error({ error }, 'Failed to start TmuxManager');
      throw error;
    }
  }

  /**
   * Stop the tmux manager and cleanup resources
   */
  async stop(): Promise<void> {
    if (!this.started || this.stopping) {
      return;
    }

    this.stopping = true;

    try {
      // Stop cleanup timers
      this.stopCleanup();

      // Close all active sessions
      await this.closeAllSessions();

      this.started = false;
      this.logger.info('TmuxManager stopped successfully');
    } catch (error) {
      this.logger.error({ error }, 'Error during TmuxManager stop');
      throw error;
    } finally {
      this.stopping = false;
    }
  }

  /**
   * Check if manager is started
   */
  isRunning(): boolean {
    return this.started;
  }

  private async ensureTmuxServer(): Promise<void> {
    // Check if tmux server is running
    const { success } = await this.execCommand('tmux', ['ls']);

    if (!success) {
      // Start tmux server
      await this.execCommand('tmux', ['start-server']);
      this.logger.info('Started tmux server');
    }
  }

  private async initializeSessionTracking(): Promise<void> {
    // Discover existing sessions
    await this.discoverExistingSessions();
  }

  private async closeAllSessions(): Promise<void> {
    const sessions = await this.listSessions();

    for (const session of sessions) {
      try {
        await this.killSession(session.name);
      } catch (error) {
        this.logger.warn(
          { session: session.name, error },
          'Failed to kill session during shutdown'
        );
      }
    }
  }
}
```

## Acceptance Criteria

- [ ] `start()` method initializes tmux manager successfully
- [ ] `stop()` method cleans up all resources
- [ ] Methods are idempotent (can be called multiple times safely)
- [ ] Proper error handling and logging
- [ ] `isRunning()` method returns correct state
- [ ] All existing tests pass
- [ ] New tests for start/stop lifecycle

## File Changes

### New Files
1. `src/gateway/tests/tmux-manager-lifecycle.test.ts` - Tests for start/stop methods

### Modified Files
1. `src/gateway/services/tmux-manager.ts` - Add start(), stop(), isRunning() methods

### Deleted Files
- None

## Test Scenarios

### Test 1: Start Method
```typescript
const manager = new TmuxManager(config, logger);
await manager.start();
assert(manager.isRunning() === true);

// Idempotent check
await manager.start();
assert(manager.isRunning() === true);
```

### Test 2: Stop Method
```typescript
await manager.start();
await manager.stop();
assert(manager.isRunning() === false);

// Idempotent check
await manager.stop();
// Should not throw
```

### Test 3: Start Before Stop
```typescript
const manager = new TmuxManager(config, logger);
await manager.stop();
// Should not throw, should be no-op
```

### Test 4: Resource Cleanup
```typescript
await manager.start();
// Create some sessions
await manager.createSession('test-workspace');

await manager.stop();
// All sessions should be killed
const sessions = await tmuxListSessions();
assert(sessions.length === 0);
```

## Dependencies

- None

## Implementation Notes

- Use a flag to track started state
- Implement idempotency checks
- Ensure cleanup timers are stopped
- Log all lifecycle events
- Handle concurrent calls gracefully

## Rollback Plan

If the implementation causes issues:
1. Remove calls to start()/stop() from `src/agent/index.ts`
2. Revert `tmux-manager.ts` changes
3. System continues to work but without explicit lifecycle management

## Success Metrics

- start() and stop() methods work without errors
- All resources properly cleaned up on stop
- Idempotent behavior verified
- 100% test coverage for new methods
