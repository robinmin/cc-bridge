---
wbs: "0137"
title: "Fix FileSystemIpc Cleanup Timer Leak"
status: "completed"
priority: "high"
complexity: "simple"
estimated_hours: 1
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

# Fix FileSystemIpc Cleanup Timer Leak

## Description

Ensure `stopCleanup()` is called when FileSystemIpc service is no longer needed to prevent timer leaks. The cleanup timer at `src/gateway/services/filesystem-ipc.ts:72, 360` may continue running after the service is destroyed.

## Requirements

### Functional Requirements

1. Implement proper cleanup method that stops all timers
2. Ensure cleanup is called when service is destroyed
3. Add lifecycle management for cleanup timer

### Non-Functional Requirements

- No timer leaks after service destruction
- Proper resource cleanup

## Design

### Current State Analysis

**File**: `src/gateway/services/filesystem-ipc.ts`

Lines 72, 360:
```typescript
// Cleanup timer started but may never be stopped
this.cleanupTimer = setInterval(() => {
  this.cleanupOldFiles();
}, this.CLEANUP_INTERVAL);
```

### Solution Design

**File**: `src/gateway/services/filesystem-ipc.ts`

```typescript
export class FileSystemIpc {
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly CLEANUP_INTERVAL = 60000; // 1 minute
  private destroyed = false;

  constructor(config: IpcConfig, logger: Logger) {
    // ... existing code ...

    // Start cleanup timer
    this.startCleanup();
  }

  /**
   * Start cleanup timer
   */
  private startCleanup(): void {
    if (this.destroyed) {
      return;
    }

    // Clear existing timer if any
    this.stopCleanup();

    this.cleanupTimer = setInterval(() => {
      if (!this.destroyed) {
        this.cleanupOldFiles().catch((err) => {
          this.logger.warn({ error: err }, 'Cleanup failed');
        });
      }
    }, this.CLEANUP_INTERVAL);

    this.logger.debug('Cleanup timer started');
  }

  /**
   * Stop cleanup timer
   */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      this.logger.debug('Cleanup timer stopped');
    }
  }

  /**
   * Destroy the service and cleanup resources
   */
  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.logger.info('Destroying FileSystemIpc service');

    // Stop cleanup timer
    this.stopCleanup();

    // Mark as destroyed
    this.destroyed = true;

    this.logger.info('FileSystemIpc service destroyed');
  }

  /**
   * Cleanup old files
   */
  private async cleanupOldFiles(): Promise<void> {
    if (this.destroyed) {
      return;
    }

    try {
      // ... existing cleanup logic ...
    } catch (error) {
      this.logger.error({ error }, 'Failed to cleanup old files');
    }
  }

  /**
   * Check if service is destroyed
   */
  isDestroyed(): boolean {
    return this.destroyed;
  }
}
```

### Usage in Service Lifecycle

**File**: Any file that creates FileSystemIpc instance

```typescript
// When creating service
const ipc = new FileSystemIpc(config, logger);

// When shutting down
await shutdown();
ipc.destroy();
```

## Acceptance Criteria

- [ ] `stopCleanup()` method stops the cleanup timer
- [ ] `destroy()` method calls `stopCleanup()` and marks service as destroyed
- [ ] Cleanup operations are skipped after service is destroyed
- [ ] No timer leaks after service destruction
- [ ] All tests pass

## File Changes

### New Files
1. `src/gateway/tests/filesystem-ipc-lifecycle.test.ts` - Lifecycle tests

### Modified Files
1. `src/gateway/services/filesystem-ipc.ts` - Add stopCleanup(), destroy(), isDestroyed() methods

### Deleted Files
- None

## Test Scenarios

### Test 1: Timer Cleanup
```typescript
const ipc = new FileSystemIpc(config, logger);
const timerCountBefore = process._getActiveHandles().filter(
  h => h instanceof Timer
).length;

ipc.destroy();

// Wait a bit
await sleep(100);

const timerCountAfter = process._getActiveHandles().filter(
  h => h instanceof Timer
).length;

// Should have fewer timers (or same count)
assert(timerCountAfter <= timerCountBefore);
```

### Test 2: Operations After Destroy
```typescript
const ipc = new FileSystemIpc(config, logger);
ipc.destroy();

// Operations should be safe but no-op
assert(ipc.isDestroyed() === true);

// Cleanup should not run after destroy
await sleep(CLEANUP_INTERVAL + 100);
// No errors, cleanup was skipped
```

### Test 3: Multiple Destroy Calls
```typescript
const ipc = new FileSystemIpc(config, logger);

ipc.destroy();
ipc.destroy(); // Should not throw
ipc.destroy(); // Should not throw

assert(ipc.isDestroyed() === true);
```

### Test 4: Restart After Destroy
```typescript
const ipc = new FileSystemIpc(config, logger);
ipc.destroy();

// Create new instance (restart)
const ipc2 = new FileSystemIpc(config, logger);

assert(ipc2.isDestroyed() === false);
// Cleanup should run
```

## Dependencies

- None

## Implementation Notes

- Add destroyed flag to prevent operations after cleanup
- Make destroy() idempotent (safe to call multiple times)
- Log cleanup operations for debugging
- Consider adding a restart() method if needed

## Rollback Plan

If issues arise:
1. Make destroy() optional (document best practice)
2. Add graceful degradation for missing cleanup

## Success Metrics

- No timer leaks after service destruction
- All cleanup operations stop after destroy()
- Idempotent destroy() method
