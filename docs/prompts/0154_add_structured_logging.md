---
wbs: "0154"
title: "Add Structured Logging for Error Context"
status: "completed"
priority: "low"
complexity: "simple"
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

# Add Structured Logging for Error Context

## Description

Use structured logging consistently across various files to improve error context and debugging capabilities. Add relevant context to log messages.

## Requirements

### Functional Requirements

1. Use structured logging (pino) consistently
2. Add relevant context to error logs
3. Include request/session identifiers
4. Add timestamps and correlation IDs

### Non-Functional Requirements

- Consistent log format
- Searchable logs
- Production-friendly

## Design

### Structured Logging Pattern

**File**: `src/shared/logger.ts` (utility)

```typescript
import { Logger } from 'pino';

/**
 * Create a child logger with additional context
 */
export function createChildLogger(
  parent: Logger,
  context: Record<string, unknown>
): Logger {
  return parent.child(context);
}

/**
 * Log error with full context
 */
export function logError(
  logger: Logger,
  error: unknown,
  message: string,
  context?: Record<string, unknown>
): void {
  const errorContext = {
    message,
    ...context,
    error: error instanceof Error ? {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause,
    } : error,
  };

  logger.error(errorContext, message);
}

/**
 * Log request with context
 */
export function logRequest(
  logger: Logger,
  context: {
    requestId?: string;
    workspace?: string;
    chatId?: string;
    userId?: string;
    command?: string;
  }
): Logger {
  return logger.child({
    requestId: context.requestId || generateRequestId(),
    workspace: context.workspace,
    chatId: context.chatId,
    userId: context.userId,
    command: context.command,
  });
}

function generateRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
```

### Usage Examples

**Example 1: Error Logging with Context**

```typescript
// Before
this.logger.error('Failed to execute command');

// After
logError(this.logger, error, 'Failed to execute command', {
  requestId,
  workspace,
  command: sanitizedCommand,
  containerId,
  timeoutMs,
});
```

**Example 2: Request-scoped Logging**

```typescript
// Create request-scoped logger
const requestLogger = logRequest(this.logger, {
  requestId,
  workspace,
  chatId,
  command,
});

// All logs from this logger include context
requestLogger.info('Command queued');
requestLogger.debug('Sending to container');
```

**Example 3: Service Initialization**

```typescript
// Service constructor
constructor(config: ServiceConfig, logger: Logger) {
  this.logger = createChildLogger(logger, {
    service: 'TmuxManager',
    version: '1.0.0',
  });
}
```

### Log Context Guidelines

**Always Include:**
- `requestId` - For request-related logs
- `workspace` - For workspace operations
- `sessionName` - For session operations
- `containerId` - For container operations
- `error.name`, `error.message`, `error.stack` - For errors

**Include When Relevant:**
- `chatId` - For chat-specific operations
- `userId` - For user-specific operations
- `command` - For command execution (sanitized)
- `duration` - For operation timing
- `retryCount` - For retry operations
- `status` - For state changes

## Acceptance Criteria

- [ ] Structured logging used consistently
- [ ] Error logs include full context
- [ ] Request logs include correlation IDs
- [ ] Logs are searchable and parseable
- [ ] Sensitive data is sanitized

## File Changes

### New Files
1. `src/shared/logger.ts` - Logging utilities
2. `docs/contributing/logging-guidelines.md` - Logging documentation

### Modified Files
1. All files that log errors or events:
   - `src/gateway/services/*.ts`
   - `src/agent/services/*.ts`
   - `src/gateway/routes/*.ts`
   - `src/agent/routes/*.ts`

### Deleted Files
- None

## Test Scenarios

### Test 1: Error Context
```typescript
// Trigger error
const logs = captureLogs();
await service.failingOperation();

const errorLog = logs.find(l => l.level === 'error');
assert(errorLog.requestId !== undefined);
assert(errorLog.workspace !== undefined);
assert(errorLog.error !== undefined);
```

### Test 2: Request Correlation
```typescript
// All logs for a request share the same requestId
const requestId = 'test-123';
const requestLogger = logRequest(logger, { requestId });

requestLogger.info('Step 1');
requestLogger.info('Step 2');

const logs = captureLogs();
assert(logs[0].requestId === requestId);
assert(logs[1].requestId === requestId);
```

## Dependencies

- pino (logger)

## Implementation Notes

- Use pino for structured logging
- Create child loggers with context
- Sanitize sensitive data (tokens, passwords)
- Include correlation IDs
- Log at appropriate levels (error, warn, info, debug, trace)

## Rollback Plan

If logging changes cause issues:
1. Gradually add context to logs
2. Keep existing logs working
3. Add feature flag for enhanced logging

## Success Metrics

- All error logs have context
- Request logs are correlated
- Logs are parseable by log aggregators
- Sensitive data is sanitized
