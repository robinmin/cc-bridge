---
wbs: "0144"
title: "Fix Missing Timeout in sendToSession"
status: "completed"
priority: "medium"
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

# Fix Missing Timeout in sendToSession

## Description

Add optional timeout parameter and implement timeout handling for `sendToSession` in `src/gateway/services/tmux-manager.ts:225-230`. Currently, commands can hang indefinitely.

## Requirements

### Functional Requirements

1. Add optional timeout parameter to sendToSession
2. Implement timeout handling
3. Provide default timeout value
4. Handle timeout errors gracefully

### Non-Functional Requirements

- Commands don't hang indefinitely
- Configurable timeout per command
- Clear error messages on timeout

## Design

### Current State

**File**: `src/gateway/services/tmux-manager.ts:225-230`

```typescript
async sendToSession(
  sessionName: string,
  command: string
): Promise<void> {
  // No timeout - can hang indefinitely
  await this.execCommand('tmux', ['send-keys', '-t', sessionName, command]);
}
```

### Solution

**File**: `src/gateway/services/tmux-manager.ts`

```typescript
export class TmuxManager {
  private readonly DEFAULT_SEND_TIMEOUT = 5000; // 5 seconds
  private readonly DEFAULT_EXEC_TIMEOUT = 30000; // 30 seconds

  /**
   * Send command to tmux session with optional timeout
   *
   * @param sessionName - Target tmux session name
   * @param command - Command to send
   * @param options - Execution options
   * @param options.timeout - Timeout in milliseconds (default: 5000)
   * @throws {TimeoutError} If command execution times out
   */
  async sendToSession(
    sessionName: string,
    command: string,
    options?: { timeout?: number }
  ): Promise<void> {
    const timeout = options?.timeout ?? this.DEFAULT_SEND_TIMEOUT;

    try {
      await this.withTimeout(
        this.execCommand('tmux', ['send-keys', '-t', sessionName, command]),
        timeout,
        `sendToSession(${sessionName})`
      );
    } catch (error) {
      if (error instanceof TimeoutError) {
        this.logger.error(
          { sessionName, command, timeout },
          'Command send timed out'
        );
        throw new TimeoutError(
          `Failed to send command to session ${sessionName} within ${timeout}ms`
        );
      }
      throw error;
    }
  }

  /**
   * Execute command with timeout
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    operation: string
  ): Promise<T> {
    let timeoutHandle: NodeJS.Timeout | null = null;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new TimeoutError(`Operation "${operation}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}

/**
 * Timeout error class
 */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}
```

### Usage Examples

```typescript
// Default timeout (5 seconds)
await tmuxManager.sendToSession('claude-workspace', 'echo hello');

// Custom timeout (10 seconds)
await tmuxManager.sendToSession('claude-workspace', 'long-running-command', {
  timeout: 10000,
});

// No timeout (use 0 or Infinity)
await tmuxManager.sendToSession('claude-workspace', 'quick-command', {
  timeout: 0,
});
```

## Acceptance Criteria

- [ ] sendToSession accepts optional timeout parameter
- [ ] Default timeout is 5 seconds
- [ ] TimeoutError thrown on timeout
- [ ] Proper error logging on timeout
- [ ] Configurable per command
- [ ] All tests pass

## File Changes

### New Files
1. `src/gateway/tests/tmux-manager-timeout.test.ts` - Timeout tests

### Modified Files
1. `src/gateway/services/tmux-manager.ts` - Add timeout handling

### Deleted Files
- None

## Test Scenarios

### Test 1: Default Timeout
```typescript
// Should complete within default timeout
await tmuxManager.sendToSession('claude-test', 'echo fast');
```

### Test 2: Custom Timeout
```typescript
// Should use custom timeout
await tmuxManager.sendToSession('claude-test', 'sleep 1', { timeout: 2000 });
```

### Test 3: Timeout Error
```typescript
// Should timeout
try {
  await tmuxManager.sendToSession('claude-test', 'sleep 10', { timeout: 100 });
  assert.fail('Should have thrown TimeoutError');
} catch (error) {
  assert(error instanceof TimeoutError);
  assert(error.message.includes('timed out'));
}
```

### Test 4: No Timeout
```typescript
// Should not timeout with 0 or Infinity
await tmuxManager.sendToSession('claude-test', 'sleep 1', { timeout: 0 });
```

## Dependencies

- None

## Implementation Notes

- Use Promise.race for timeout implementation
- Create TimeoutError class for better error handling
- Make timeout optional with sensible default
- Log timeout events for debugging
- Consider adding timeout to other execCommand calls

## Rollback Plan

If timeout causes issues:
1. Make timeout behavior configurable (default to no timeout)
2. Add feature flag for timeout enforcement
3. Log warnings instead of throwing errors

## Success Metrics

- Commands respect timeout limits
- No indefinite hangs
- Clear timeout error messages
- Configurable per command
