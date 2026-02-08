---
wbs: "0147"
title: "Fix Custom EventEmitter Instead of Native"
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

# Fix Custom EventEmitter Instead of Native

## Description

Replace custom EventEmitter implementation with Node.js native EventEmitter class in `src/gateway/services/ErrorRecoveryService.ts:507-525`. Using native implementation provides better compatibility and features.

## Requirements

### Functional Requirements

1. Replace custom EventEmitter with Node.js native EventEmitter
2. Update all event emission and listening code
3. Maintain existing functionality
4. Leverage native EventEmitter features

### Non-Functional Requirements

- Better compatibility with Node.js ecosystem
- Improved performance
- Standard event handling patterns

## Design

### Current State

**File**: `src/gateway/services/ErrorRecoveryService.ts:507-525`

```typescript
// Custom EventEmitter implementation
class EventEmitter {
  private listeners: Map<string, Function[]> = new Map();

  on(event: string, callback: Function): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(callback);
  }

  emit(event: string, ...args: any[]): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.forEach(cb => cb(...args));
    }
  }
}
```

### Solution

**File**: `src/gateway/services/ErrorRecoveryService.ts`

```typescript
import { EventEmitter } from 'events';

// Remove custom EventEmitter class
// Use native EventEmitter instead

export class ErrorRecoveryService {
  private events: EventEmitter;

  constructor(config: ErrorRecoveryConfig, logger: Logger) {
    this.logger = logger;
    this.config = config;

    // Use native EventEmitter
    this.events = new EventEmitter();

    // Configure max listeners (default is 10, can be increased)
    this.events.setMaxListeners(50);

    // ... rest of constructor ...
  }

  /**
   * Register event listener
   */
  on(event: RecoveryEvent, callback: (...args: any[]) => void): void {
    this.events.on(event, callback);
    this.logger.debug({ event }, 'Event listener registered');
  }

  /**
   * Register one-time event listener
   */
  once(event: RecoveryEvent, callback: (...args: any[]) => void): void {
    this.events.once(event, callback);
    this.logger.debug({ event }, 'One-time event listener registered');
  }

  /**
   * Remove event listener
   */
  off(event: RecoveryEvent, callback: (...args: any[]) => void): void {
    this.events.off(event, callback);
    this.logger.debug({ event }, 'Event listener removed');
  }

  /**
   * Emit event
   */
  private emit(event: RecoveryEvent, ...args: any[]): void {
    this.events.emit(event, ...args);
  }

  /**
   * Remove all listeners for an event or all events
   */
  removeAllListeners(event?: RecoveryEvent): void {
    if (event) {
      this.events.removeAllListeners(event);
      this.logger.debug({ event }, 'All listeners removed for event');
    } else {
      this.events.removeAllListeners();
      this.logger.debug('All listeners removed');
    }
  }

  /**
   * Get listener count for event
   */
  listenerCount(event: RecoveryEvent): number {
    return this.events.listenerCount(event);
  }

  /**
   * Get event names
   */
  eventNames(): RecoveryEvent[] {
    return this.events.eventNames() as RecoveryEvent[];
  }
}

/**
 * Recovery event types
 */
type RecoveryEvent =
  | 'error:recovered'
  | 'error:failed'
  | 'health:check'
  | 'session:restarted'
  | 'container:restarted';
```

## Acceptance Criteria

- [ ] Custom EventEmitter removed
- [ ] Native EventEmitter used
- [ ] All event operations work correctly
- [ ] Additional native features leveraged (once, off, etc.)
- [ ] Proper error handling for EventEmitter methods
- [ ] All tests pass

## File Changes

### New Files
1. `src/gateway/tests/error-recovery-events.test.ts` - Event handling tests

### Modified Files
1. `src/gateway/services/ErrorRecoveryService.ts` - Replace with native EventEmitter

### Deleted Files
- None (custom EventEmitter class removed)

## Test Scenarios

### Test 1: Basic Event Emission
```typescript
const service = new ErrorRecoveryService(config, logger);

let received = false;
service.on('error:recovered', () => {
  received = true;
});

service.emit('error:recovered');
assert(received === true);
```

### Test 2: Once Listener
```typescript
let count = 0;
service.once('error:recovered', () => {
  count++;
});

service.emit('error:recovered');
service.emit('error:recovered');

assert(count === 1); // Only called once
```

### Test 3: Remove Listener
```typescript
let count = 0;
const handler = () => count++;

service.on('error:recovered', handler);
service.emit('error:recovered');
assert(count === 1);

service.off('error:recovered', handler);
service.emit('error:recovered');
assert(count === 1); // Still 1, listener removed
```

### Test 4: Multiple Arguments
```typescript
let receivedArgs: any[] = [];
service.on('error:failed', (...args) => {
  receivedArgs = args;
});

service.emit('error:failed', 'error message', { code: 500 }, 123);
assert(receivedArgs.length === 3);
assert(receivedArgs[0] === 'error message');
```

### Test 5: Listener Count
```typescript
service.on('error:recovered', () => {});
service.on('error:recovered', () => {});

assert(service.listenerCount('error:recovered') === 2);
```

### Test 6: Max Listeners
```typescript
// Add many listeners
for (let i = 0; i < 100; i++) {
  service.on('error:recovered', () => {});
}

// Should not warn (maxListeners set to 50)
assert(service.listenerCount('error:recovered') === 100);
```

## Dependencies

- None

## Implementation Notes

- Set maxListeners appropriately for service needs
- Use type-safe event names (string literal types)
- Leverage once() for one-time handlers
- Use off() or removeListener() for cleanup
- Consider using async event handlers if needed
- Handle 'error' event specially (EventEmitter throws if unhandled)

## Rollback Plan

If native EventEmitter causes issues:
1. Can keep custom implementation as fallback
2. Use feature flag to switch between implementations
3. Debug any compatibility issues

## Success Metrics

- All event operations work correctly
- Additional native features available
- Better performance than custom implementation
- Standard Node.js patterns used
