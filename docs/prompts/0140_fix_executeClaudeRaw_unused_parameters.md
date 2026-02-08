---
wbs: "0140"
title: "Fix executeClaudeRaw Unused Parameters"
status: "completed"
priority: "high"
complexity: "trivial"
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

# Fix executeClaudeRaw Unused Parameters

## Description

Document supported config options or use workspace/chatId in metadata for `executeClaudeRaw` at `src/gateway/services/claude-executor.ts:224`. The function accepts workspace and chatId parameters but doesn't use them.

## Requirements

### Functional Requirements

1. Either use workspace/chatId in execution metadata
2. Or document why these parameters are accepted but unused
3. Or remove unused parameters if truly not needed
4. Ensure parameter handling is intentional and documented

### Non-Functional Requirements

- Clear documentation of parameter usage
- Consistent parameter handling across similar functions

## Design

### Current State

**File**: `src/gateway/services/claude-executor.ts:224`

```typescript
async executeClaudeRaw(
  containerId: string,
  command: string,
  options?: {
    workspace?: string;  // Accepted but unused
    chatId?: string;     // Accepted but unused
    timeoutMs?: number;
  }
): Promise<ClaudeResponse>
```

### Solution Options

**Option 1: Use parameters in metadata**

```typescript
async executeClaudeRaw(
  containerId: string,
  command: string,
  options?: {
    workspace?: string;
    chatId?: string;
    timeoutMs?: number;
  }
): Promise<ClaudeResponse> {
  const { workspace, chatId, timeoutMs } = options || {};

  // Build metadata with workspace/chatId for tracking
  const metadata = {
    workspace: workspace || 'default',
    chatId: chatId || 'unknown',
    command,
    timestamp: Date.now(),
  };

  this.logger.debug({ metadata }, 'Executing raw Claude command');

  // Use metadata in request for tracking
  const response = await this.sendToContainer(containerId, command, {
    timeout: timeoutMs,
    metadata,
  });

  return response;
}
```

**Option 2: Remove unused parameters (if truly not needed)**

```typescript
async executeClaudeRaw(
  containerId: string,
  command: string,
  options?: {
    timeoutMs?: number;
  }
): Promise<ClaudeResponse>
```

**Option 3: Document as reserved for future use**

```typescript
/**
 * Execute a raw Claude command (minimal wrapper)
 *
 * @param containerId - Container to execute in
 * @param command - Command to execute
 * @param options - Execution options
 * @param options.workspace - Reserved for future use (tracking)
 * @param options.chatId - Reserved for future use (tracking)
 * @param options.timeoutMs - Execution timeout in milliseconds
 *
 * @note The workspace and chatId parameters are currently accepted for
 * API consistency but are not used in execution. They may be used for
 * request tracking in future implementations.
 */
async executeClaudeRaw(
  containerId: string,
  command: string,
  options?: {
    workspace?: string;  // Reserved: for future tracking
    chatId?: string;     // Reserved: for future tracking
    timeoutMs?: number;
  }
): Promise<ClaudeResponse>
```

### Recommended Approach: Option 1 (Use in metadata)

Using workspace/chatId in metadata provides:
1. Better observability and debugging
2. Consistent tracking across all execution methods
3. Foundation for future analytics
4. No breaking API changes

## Acceptance Criteria

- [ ] workspace and chatId parameters are used in metadata
- [ ] Metadata is logged for debugging
- [ ] JSDoc documentation updated
- [ ] Consistent with other executeClaude methods
- [ ] All tests pass

## File Changes

### New Files
- None

### Modified Files
1. `src/gateway/services/claude-executor.ts` - Use workspace/chatId in metadata, add JSDoc

### Deleted Files
- None

## Test Scenarios

### Test 1: Metadata Includes Workspace/ChatId
```typescript
const logger = createLogger();
const executor = new ClaudeExecutor(config, logger);

// Capture logs
const logs: any[] = [];
logger.on('data', (log) => logs.push(log));

await executor.executeClaudeRaw('container-1', 'test command', {
  workspace: 'my-workspace',
  chatId: 'user-123',
});

const executeLog = logs.find(l => l.msg?.includes('Executing raw Claude command'));
assert(executeLog?.metadata?.workspace === 'my-workspace');
assert(executeLog?.metadata?.chatId === 'user-123');
```

### Test 2: Optional Parameters
```typescript
// Should work without workspace/chatId
const result = await executor.executeClaudeRaw('container-1', 'test', {});
assert(result !== undefined);

// Should work with workspace/chatId
const result2 = await executor.executeClaudeRaw('container-1', 'test', {
  workspace: 'test',
  chatId: 'test-chat',
});
assert(result2 !== undefined);
```

### Test 3: Backward Compatibility
```typescript
// Existing calls without options should still work
const result = await executor.executeClaudeRaw('container-1', 'command');
assert(result !== undefined);
```

## Dependencies

- None

## Implementation Notes

- Add workspace/chatId to request metadata
- Include metadata in debug logs
- Update JSDoc to reflect parameter usage
- Keep parameters optional for backward compatibility
- Consider adding requestId to metadata as well

## Rollback Plan

Revert to unused parameters with documentation if issues arise.

## Success Metrics

- workspace/chatId appear in logs/metadata
- JSDoc documentation complete
- No breaking changes
- All tests pass
