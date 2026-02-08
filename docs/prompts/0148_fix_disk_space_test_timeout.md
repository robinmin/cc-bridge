---
wbs: "0148"
title: "Fix Disk Space Test Timeout"
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

# Fix Disk Space Test Timeout

## Description

Use timer mock or reduce wait time for disk space test in `src/gateway/tests/error-recovery.test.ts:434-456`. The test currently has excessive wait times.

## Requirements

### Functional Requirements

1. Reduce test wait time to reasonable duration
2. Use timer mocking for faster tests
3. Ensure test still validates disk space checking
4. Maintain test reliability

### Non-Functional Requirements

- Fast test execution
- Reliable test results
- Clear test assertions

## Design

### Current State

**File**: `src/gateway/tests/error-recovery.test.ts:434-456`

```typescript
it('should handle low disk space', async () => {
  // Slow test - waits for real time
  await sleep(10000); // 10 seconds!
  // ...
});
```

### Solution

**Option 1: Timer Mocking (Recommended)**

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('ErrorRecoveryService - Disk Space', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should handle low disk space', async () => {
    const service = new ErrorRecoveryService(config, logger);

    // Mock disk space check to return low space
    vi.spyOn(service, 'checkDiskSpace').mockResolvedValue({
      available: 1024 * 1024 * 100, // 100MB
      total: 1024 * 1024 * 1024 * 10, // 10GB
      percentage: 99,
    });

    // Register recovery callback
    let recovered = false;
    service.on('disk:recovered', () => {
      recovered = true;
    });

    // Start health check
    service.start();

    // Fast-forward time
    await vi.advanceTimersByTimeAsync(30000); // 30 seconds in test time

    // Verify recovery was triggered
    expect(recovered).toBe(true);

    // Cleanup
    await service.stop();
  });
});
```

**Option 2: Reduce Wait Time (Simpler)**

```typescript
it('should handle low disk space', async () => {
  const service = new ErrorRecoveryService({
    ...config,
    healthCheckInterval: 100, // 100ms for testing
    diskSpaceCheckInterval: 200, // 200ms for testing
  }, logger);

  // Mock disk space check
  vi.spyOn(service, 'checkDiskSpace').mockResolvedValue({
    available: 1024 * 1024 * 100,
    total: 1024 * 1024 * 1024 * 10,
    percentage: 99,
  });

  let recovered = false;
  service.on('disk:recovered', () => {
    recovered = true;
  });

  service.start();

  // Short wait
  await sleep(500); // 500ms instead of 10000ms

  expect(recovered).toBe(true);

  await service.stop();
});
```

### Recommended Approach: Option 1 (Timer Mocking)

Timer mocking provides:
1. Faster test execution
2. Deterministic timing
3. Better test isolation
4. No actual waiting

## Acceptance Criteria

- [ ] Test executes in <1 second
- [ ] Disk space checking still validated
- [ ] Test is deterministic (no flaky timing)
- [ ] All test assertions pass
- [ ] Clean mock cleanup

## File Changes

### New Files
- None

### Modified Files
1. `src/gateway/tests/error-recovery.test.ts` - Use timer mocking or reduced waits

### Deleted Files
- None

## Test Scenarios

### Test 1: Timer Mocking
```typescript
beforeEach(() => {
  vi.useFakeTimers();
});

it('fast disk space test', async () => {
  const service = new ErrorRecoveryService(config, logger);

  vi.spyOn(service, 'checkDiskSpace').mockResolvedValue({
    available: 100 * 1024 * 1024,
    total: 10 * 1024 * 1024 * 1024,
    percentage: 99,
  });

  service.start();

  // Advance 30 seconds instantly
  await vi.advanceTimersByTimeAsync(30000);

  // Verify behavior
  // ...

  await service.stop();
});

afterEach(() => {
  vi.useRealTimers();
});
```

### Test 2: Short Interval Config
```typescript
it('fast disk space test with config', async () => {
  const service = new ErrorRecoveryService({
    healthCheckInterval: 50,
    diskSpaceCheckInterval: 100,
  }, logger);

  // Test logic...
  // Total time: <500ms
});
```

## Dependencies

- Vitest testing framework

## Implementation Notes

- Use `vi.useFakeTimers()` for timer mocking
- Use `vi.advanceTimersByTimeAsync()` for async timer advancement
- Always restore real timers in afterEach
- Consider using shorter intervals for all health check tests
- Document why timers are mocked in test comments

## Rollback Plan

If timer mocking causes issues:
1. Use reduced intervals instead
2. Add longer timeout to test if needed
3. Mark as slow test if unavoidable

## Success Metrics

- Test executes in <1 second
- All disk space scenarios validated
- No timing-dependent flakiness
- Clean mock cleanup
