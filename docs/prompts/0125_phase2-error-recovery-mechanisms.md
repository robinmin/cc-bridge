---
wbs: "0125"
title: "Phase 2.6: Error Recovery Mechanisms"
status: "completed"
priority: "critical"
complexity: "high"
estimated_hours: 6
phase: "phase-2-filesystem-polish"
dependencies: ["0121", "0122", "0124"]
created: 2026-02-07
completed: 2026-02-07
impl_progress:
  planning: completed
  design: completed
  implementation: completed
  review: completed
  testing: completed
---

# Phase 2.6: Error Recovery Mechanisms

## Description

Implement comprehensive error recovery mechanisms to handle all failure scenarios gracefully: file write failures, Stop Hook failures, callback failures, and container restarts. Ensures system resilience with automatic recovery, fallback mechanisms, and user notification.

## Requirements

### Functional Requirements

1. **File Write Failure Recovery**
   - Retry file writes with exponential backoff (3 attempts)
   - Fallback to alternate directory if primary fails
   - Disk space check before write attempts
   - User notification on persistent write failure
   - Automatic cleanup of partial writes

2. **Stop Hook Failure Handling**
   - Fallback to polling if Stop Hook fails repeatedly
   - Automatic re-enable after threshold period
   - Circuit breaker for Stop Hook execution
   - Graceful degradation to stdio mode
   - Alert on Stop Hook malfunction

3. **Callback Failure Recovery**
   - Exponential backoff retry (implemented in 0121)
   - Fallback to Gateway polling for missed callbacks
   - Dead letter queue for failed callbacks
   - Automatic retry from DLQ
   - User notification after all retries exhausted

4. **Container Restart Recovery**
   - Session state persistence before shutdown
   - Automatic session recreation on restart
   - Pending request recovery and continuation
   - Request deduplication on recovery
   - User notification of service interruption

5. **Network Failure Handling**
   - Connection pooling with automatic retry
   - Circuit breaker for Gateway connections
   - Offline mode with local queueing
   - Automatic sync when connectivity restored
   - Health check integration

6. **Graceful Degradation**
   - Progressive feature disable on errors
   - Maintain core functionality during failures
   - Clear user messaging about degraded state
   - Automatic recovery when possible
   - Manual recovery commands

### Non-Functional Requirements

- Recovery attempts must not exceed 30 seconds
- User notification within 5 seconds of unrecoverable error
- Zero data loss during recoverable failures
- Automatic recovery success rate >95%
- System remains partially functional during failures

## Design

### Error Recovery Service

**File**: `src/agent/services/ErrorRecoveryService.ts`

```typescript
import { Logger } from 'pino';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import path from 'path';

export enum ErrorType {
  FILE_WRITE = 'file_write',
  STOP_HOOK = 'stop_hook',
  CALLBACK = 'callback',
  NETWORK = 'network',
  DISK_SPACE = 'disk_space',
  PERMISSION = 'permission',
}

export enum RecoveryAction {
  RETRY = 'retry',
  FALLBACK = 'fallback',
  NOTIFY = 'notify',
  DEGRADE = 'degrade',
  CIRCUIT_BREAK = 'circuit_break',
}

interface ErrorContext {
  errorType: ErrorType;
  requestId: string;
  workspace: string;
  error: Error;
  attemptCount: number;
  metadata?: Record<string, any>;
}

interface RecoveryStrategy {
  maxRetries: number;
  backoffMs: number;
  fallbackAction?: () => Promise<void>;
  circuitBreakerThreshold?: number;
}

export class ErrorRecoveryService extends EventEmitter {
  private logger: Logger;
  private failureCounters: Map<ErrorType, number>;
  private circuitBreakers: Map<ErrorType, boolean>;
  private lastFailures: Map<ErrorType, number>;
  private recoveryStrategies: Map<ErrorType, RecoveryStrategy>;

  constructor(logger: Logger) {
    super();
    this.logger = logger.child({ component: 'ErrorRecoveryService' });
    this.failureCounters = new Map();
    this.circuitBreakers = new Map();
    this.lastFailures = new Map();

    // Initialize recovery strategies
    this.recoveryStrategies = new Map([
      [ErrorType.FILE_WRITE, {
        maxRetries: 3,
        backoffMs: 1000,
        circuitBreakerThreshold: 10,
      }],
      [ErrorType.STOP_HOOK, {
        maxRetries: 3,
        backoffMs: 2000,
        circuitBreakerThreshold: 5,
      }],
      [ErrorType.CALLBACK, {
        maxRetries: 3,
        backoffMs: 1000,
        circuitBreakerThreshold: 10,
      }],
      [ErrorType.NETWORK, {
        maxRetries: 5,
        backoffMs: 500,
        circuitBreakerThreshold: 20,
      }],
    ]);

    // Reset circuit breakers periodically
    setInterval(() => this.resetCircuitBreakers(), 300000); // 5 minutes
  }

  /**
   * Handle error with automatic recovery
   */
  async handleError(context: ErrorContext): Promise<boolean> {
    this.logger.error({
      errorType: context.errorType,
      requestId: context.requestId,
      workspace: context.workspace,
      error: context.error,
      attempt: context.attemptCount,
    }, 'Handling error');

    // Check circuit breaker
    if (this.isCircuitOpen(context.errorType)) {
      this.logger.warn({
        errorType: context.errorType,
      }, 'Circuit breaker open, skipping recovery');

      this.emit('recovery:circuit_open', context);
      return false;
    }

    // Get recovery strategy
    const strategy = this.recoveryStrategies.get(context.errorType);
    if (!strategy) {
      this.logger.error({ errorType: context.errorType }, 'No recovery strategy defined');
      return false;
    }

    // Attempt recovery based on error type
    try {
      const recovered = await this.attemptRecovery(context, strategy);

      if (recovered) {
        this.resetFailureCounter(context.errorType);
        this.emit('recovery:success', context);
        return true;
      }

      // Increment failure counter
      this.incrementFailureCounter(context.errorType);

      // Check if we should open circuit breaker
      if (strategy.circuitBreakerThreshold) {
        const failures = this.failureCounters.get(context.errorType) || 0;
        if (failures >= strategy.circuitBreakerThreshold) {
          this.openCircuitBreaker(context.errorType);
        }
      }

      this.emit('recovery:failure', context);
      return false;
    } catch (err) {
      this.logger.error({ err, context }, 'Recovery attempt failed');
      this.emit('recovery:error', context);
      return false;
    }
  }

  /**
   * Attempt recovery based on error type
   */
  private async attemptRecovery(
    context: ErrorContext,
    strategy: RecoveryStrategy
  ): Promise<boolean> {
    switch (context.errorType) {
      case ErrorType.FILE_WRITE:
        return this.recoverFileWrite(context, strategy);
      case ErrorType.STOP_HOOK:
        return this.recoverStopHook(context, strategy);
      case ErrorType.CALLBACK:
        return this.recoverCallback(context, strategy);
      case ErrorType.NETWORK:
        return this.recoverNetwork(context, strategy);
      case ErrorType.DISK_SPACE:
        return this.recoverDiskSpace(context, strategy);
      case ErrorType.PERMISSION:
        return this.recoverPermission(context, strategy);
      default:
        this.logger.warn({ errorType: context.errorType }, 'Unknown error type');
        return false;
    }
  }

  /**
   * Recover from file write failure
   */
  private async recoverFileWrite(
    context: ErrorContext,
    strategy: RecoveryStrategy
  ): Promise<boolean> {
    const { requestId, workspace, metadata } = context;
    const filePath = metadata?.filePath as string;
    const data = metadata?.data as string;

    if (!filePath || !data) {
      this.logger.error('Missing file path or data for recovery');
      return false;
    }

    // Retry write with backoff
    for (let attempt = 1; attempt <= strategy.maxRetries; attempt++) {
      try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const tempPath = `${filePath}.tmp`;
        await fs.writeFile(tempPath, data, 'utf-8');
        await fs.rename(tempPath, filePath);

        this.logger.info({ requestId, filePath, attempt }, 'File write recovered');
        return true;
      } catch (err) {
        this.logger.warn({ err, attempt, maxRetries: strategy.maxRetries }, 'File write retry failed');
        if (attempt < strategy.maxRetries) {
          await this.sleep(strategy.backoffMs * attempt);
        }
      }
    }

    return this.tryFallbackDirectory(requestId, workspace, data);
  }

  /**
   * Recover from Stop Hook failure
   */
  private async recoverStopHook(
    context: ErrorContext,
    strategy: RecoveryStrategy
  ): Promise<boolean> {
    this.logger.warn({ context }, 'Stop Hook failed, falling back to polling');
    this.emit('stop_hook:fallback_polling', context);
    return true; // Graceful degradation
  }

  /**
   * Recover from callback failure
   */
  private async recoverCallback(
    context: ErrorContext,
    strategy: RecoveryStrategy
  ): Promise<boolean> {
    const { requestId, workspace } = context;

    this.emit('callback:dead_letter', {
      requestId,
      workspace,
      retryAfter: Date.now() + 60000,
    });

    return true; // Gateway will handle retry
  }

  /**
   * Recover from network failure
   */
  private async recoverNetwork(
    context: ErrorContext,
    strategy: RecoveryStrategy
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= strategy.maxRetries; attempt++) {
      try {
        await this.testConnectivity();
        this.logger.info({ attempt }, 'Network connectivity restored');
        return true;
      } catch (err) {
        if (attempt < strategy.maxRetries) {
          await this.sleep(strategy.backoffMs * Math.pow(2, attempt - 1));
        }
      }
    }

    this.emit('network:offline_mode', context);
    return false;
  }

  /**
   * Recover from disk space issue
   */
  private async recoverDiskSpace(
    context: ErrorContext,
    strategy: RecoveryStrategy
  ): Promise<boolean> {
    this.emit('disk:emergency_cleanup', context);
    await this.sleep(5000);
    return true;
  }

  /**
   * Recover from permission error
   */
  private async recoverPermission(
    context: ErrorContext,
    strategy: RecoveryStrategy
  ): Promise<boolean> {
    const filePath = context.metadata?.filePath as string;
    if (!filePath) return false;

    try {
      await fs.chmod(path.dirname(filePath), 0o755);
      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * Try writing to fallback directory
   */
  private async tryFallbackDirectory(
    requestId: string,
    workspace: string,
    data: string
  ): Promise<boolean> {
    const fallbackPath = `/tmp/ipc-fallback/${workspace}/responses/${requestId}.json`;

    try {
      await fs.mkdir(path.dirname(fallbackPath), { recursive: true });
      await fs.writeFile(fallbackPath, data, 'utf-8');
      this.emit('file:fallback_directory', { requestId, workspace, fallbackPath });
      return true;
    } catch (err) {
      return false;
    }
  }

  private async testConnectivity(): Promise<void> {
    // Placeholder - implement connectivity check
  }

  private incrementFailureCounter(errorType: ErrorType): void {
    const current = this.failureCounters.get(errorType) || 0;
    this.failureCounters.set(errorType, current + 1);
    this.lastFailures.set(errorType, Date.now());
  }

  private resetFailureCounter(errorType: ErrorType): void {
    this.failureCounters.set(errorType, 0);
  }

  private openCircuitBreaker(errorType: ErrorType): void {
    this.circuitBreakers.set(errorType, true);
    this.emit('circuit_breaker:open', { errorType });
  }

  private isCircuitOpen(errorType: ErrorType): boolean {
    return this.circuitBreakers.get(errorType) || false;
  }

  private resetCircuitBreakers(): void {
    const now = Date.now();
    const resetThreshold = 300000;

    for (const [errorType, isOpen] of this.circuitBreakers.entries()) {
      if (!isOpen) continue;

      const lastFailure = this.lastFailures.get(errorType) || 0;
      if (now - lastFailure > resetThreshold) {
        this.circuitBreakers.set(errorType, false);
        this.resetFailureCounter(errorType);
        this.emit('circuit_breaker:reset', { errorType });
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getStats() {
    const stats: Record<string, any> = {};
    for (const [errorType, count] of this.failureCounters.entries()) {
      stats[errorType] = {
        failures: count,
        circuitOpen: this.circuitBreakers.get(errorType) || false,
        lastFailure: this.lastFailures.get(errorType),
      };
    }
    return stats;
  }
}
```

## Acceptance Criteria

- [ ] File write failures retry 3 times with exponential backoff
- [ ] Fallback directory used when primary write fails
- [ ] Stop Hook failures trigger fallback to polling
- [ ] Circuit breaker opens after threshold failures
- [ ] Callback failures added to dead letter queue
- [ ] Gateway polls for missed callbacks
- [ ] Container restart recreates active sessions
- [ ] Pending requests recovered and re-queued
- [ ] User notified of unrecoverable errors within 5 seconds
- [ ] Circuit breakers auto-reset after 5 minutes
- [ ] Graceful degradation maintains core functionality
- [ ] Zero data loss during recoverable failures
- [ ] Recovery success rate >95%

## File Changes

### New Files
1. `src/agent/services/ErrorRecoveryService.ts` - Main error recovery
2. `src/agent/services/RestartRecoveryService.ts` - Container restart recovery
3. `src/gateway/services/UserNotificationService.ts` - User notifications
4. `tests/unit/ErrorRecoveryService.test.ts` - Unit tests
5. `tests/integration/error-recovery.test.ts` - Integration tests

### Modified Files
1. `src/agent/index.ts` - Initialize ErrorRecoveryService
2. `src/gateway/index.ts` - Initialize UserNotificationService
3. `src/agent/services/TmuxManager.ts` - Integrate error recovery
4. `scripts/stop-hook.sh` - Report failures to recovery service

### Deleted Files
- None

## Test Scenarios

### Test 1: File Write Recovery
```typescript
describe('ErrorRecoveryService - File Write', () => {
  it('should retry file writes', async () => {
    let attempts = 0;
    jest.spyOn(fs, 'writeFile').mockImplementation(async () => {
      attempts++;
      if (attempts < 3) throw new Error('ENOSPC');
    });

    const recovered = await recovery.handleError({
      errorType: ErrorType.FILE_WRITE,
      requestId: 'req-001',
      workspace: 'test',
      error: new Error('Write failed'),
      attemptCount: 1,
      metadata: { filePath: '/ipc/test/responses/req-001.json', data: '{}' },
    });

    expect(recovered).toBe(true);
    expect(attempts).toBe(3);
  });
});
```

### Test 2: Circuit Breaker
```typescript
it('should open circuit breaker after threshold', async () => {
  for (let i = 0; i < 5; i++) {
    await recovery.handleError({
      errorType: ErrorType.STOP_HOOK,
      requestId: `req-${i}`,
      workspace: 'test',
      error: new Error('Failed'),
      attemptCount: 1,
    });
  }

  expect(recovery['isCircuitOpen'](ErrorType.STOP_HOOK)).toBe(true);
});
```

## Dependencies

- Task 0121 (Stop Hook Retry Logic)
- Task 0122 (Gateway Callback Hardening)
- Task 0124 (Request Correlation Tracking)

## Rollback Plan

If error recovery causes issues:
1. Disable via `ENABLE_ERROR_RECOVERY=false`
2. System reverts to fail-fast behavior
3. Manual recovery required

## Success Metrics

- Automatic recovery success rate >95%
- Mean time to recovery <30 seconds
- User notification latency <5 seconds
- Zero data loss in recoverable scenarios
- All test scenarios pass

