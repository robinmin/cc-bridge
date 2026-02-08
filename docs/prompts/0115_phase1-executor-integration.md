---
wbs: "0115"
title: "Phase 1.6: ClaudeExecutor Integration with tmux"
status: "completed"
priority: "critical"
complexity: "high"
estimated_hours: 6
phase: "phase-1-core-persistent-sessions"
dependencies: ["0111", "0114"]
created: 2026-02-07
completed: 2026-02-07
impl_progress:
  planning: completed
  design: completed
  implementation: completed
  review: completed
  testing: completed
---

# Phase 1.6: ClaudeExecutor Integration with tmux

## Description

Integrate TmuxManager with the existing ClaudeExecutor to enable persistent Claude sessions. Update the execution flow to use tmux send-keys instead of one-shot `docker exec` with stdio IPC.

## Requirements

### Functional Requirements

1. **Execution Method Selection**
   - Primary: Use tmux send-keys for Telegram requests
   - Fallback: Use existing stdio IPC if tmux unavailable
   - Configuration flag to enable/disable tmux mode

2. **Request Flow**
   - Generate unique request ID
   - Get or create tmux session for chat/workspace
   - Send prompt via TmuxManager
   - Return immediately (don't wait for response)
   - Response arrives via callback endpoint

3. **Backward Compatibility**
   - Maintain existing `executeClaudeRaw()` API
   - Support both sync (stdio) and async (tmux) modes
   - Existing tests continue to pass

### Non-Functional Requirements

- Execution request completes in <1 second
- Zero impact on existing functionality
- Graceful degradation if tmux unavailable
- Clear logging for debugging

## Design

### Updated ClaudeExecutor

**File**: `src/gateway/services/claude-executor.ts` (modified)

```typescript
import { TmuxManager } from '@/gateway/services/tmux-manager';
import crypto from 'node:crypto';

export interface ClaudeExecutionConfig {
  // ... existing fields ...
  useTmux?: boolean;  // New: Enable tmux mode (default: false)
}

// Singleton instances
let tmuxManager: TmuxManager | null = null;

function getTmuxManager(): TmuxManager {
  if (!tmuxManager) {
    tmuxManager = new TmuxManager();
  }
  return tmuxManager;
}

/**
 * Execute Claude via persistent tmux session (async mode)
 * Returns immediately, response arrives via callback
 */
export async function executeClaudeViaTmux(
  containerId: string,
  instanceName: string,
  prompt: string,
  config: ClaudeExecutionConfig = {}
): Promise<{ requestId: string }> {
  const requestId = crypto.randomUUID();
  const manager = getTmuxManager();

  const workspace = config.workspace || 'cc-bridge';
  const chatId = config.chatId || 'default';

  logger.info(
    { requestId, containerId, workspace, chatId },
    'Executing Claude via tmux'
  );

  try {
    // 1. Get or create session
    const sessionName = await manager.getOrCreateSession(
      containerId,
      workspace,
      chatId
    );

    // 2. Send prompt to session
    await manager.sendToSession(
      containerId,
      sessionName,
      prompt,
      { requestId, chatId: String(chatId), workspace }
    );

    logger.info(
      { requestId, sessionName },
      'Prompt sent to tmux session'
    );

    // 3. Return request ID (response arrives via callback)
    return { requestId };

  } catch (error) {
    logger.error(
      { error, requestId, containerId },
      'Failed to execute via tmux'
    );
    throw error;
  }
}

/**
 * Unified execution method with automatic mode selection
 */
export async function executeClaude(
  containerId: string,
  instanceName: string,
  prompt: string,
  config: ClaudeExecutionConfig = {}
): Promise<ClaudeExecutionResult | { requestId: string }> {
  // Determine execution mode
  const useTmux = config.useTmux ?? process.env.ENABLE_TMUX === 'true';

  if (useTmux) {
    // Async mode: return request ID
    return await executeClaudeViaTmux(
      containerId,
      instanceName,
      prompt,
      config
    );
  } else {
    // Sync mode: return result immediately
    return await executeClaudeRaw(
      containerId,
      instanceName,
      prompt,
      config
    );
  }
}
```

### AgentBot Integration

**File**: `src/gateway/pipeline/agent-bot.ts` (modified)

```typescript
import { executeClaude } from '@/gateway/services/claude-executor';

export class AgentBot {
  async processMessage(chatId: number, text: string, workspace: string) {
    const instance = instanceManager.getInstance(workspace);
    if (!instance) {
      await this.telegram.sendMessage(chatId, '❌ Workspace not found');
      return;
    }

    // Build prompt
    const history = await persistence.getHistory(chatId, workspace);
    const prompt = buildClaudePrompt(text, history);

    try {
      // Execute with tmux if enabled
      const result = await executeClaude(
        instance.containerId,
        instance.name,
        prompt,
        {
          workspace,
          chatId,
          useTmux: true, // Enable tmux mode
        }
      );

      if ('requestId' in result) {
        // Async mode: response will arrive via callback
        logger.info(
          { requestId: result.requestId, chatId },
          'Request submitted, waiting for callback'
        );

        // Optionally send "processing" message
        await this.telegram.sendMessage(
          chatId,
          '⏳ Processing your request...'
        );
      } else {
        // Sync mode: send result immediately
        await this.telegram.sendMessage(chatId, result.output || '');
      }

    } catch (error) {
      logger.error({ error, chatId }, 'Execution failed');
      await this.telegram.sendMessage(
        chatId,
        `❌ Error: ${error.message}`
      );
    }
  }
}
```

## Acceptance Criteria

- [ ] `executeClaude()` supports both sync and async modes
- [ ] Async mode returns `{ requestId }` immediately
- [ ] Sync mode returns `ClaudeExecutionResult` with output
- [ ] Mode selection works via `useTmux` config flag
- [ ] Mode selection works via `ENABLE_TMUX` environment variable
- [ ] AgentBot uses tmux mode when enabled
- [ ] Existing tests continue to pass (backward compatibility)
- [ ] New tests for tmux mode pass
- [ ] Logging includes request IDs for tracing
- [ ] Graceful fallback if TmuxManager throws error
- [ ] Request ID generation is unique and traceable

## File Changes

### New Files
1. `src/gateway/tests/claude-executor-tmux.test.ts` - Tests for tmux integration

### Modified Files
1. `src/gateway/services/claude-executor.ts` - Add tmux execution methods
2. `src/gateway/pipeline/agent-bot.ts` - Use new execution API
3. `src/gateway/consts.ts` - Add ENABLE_TMUX constant

### Deleted Files
- None

## Test Scenarios

### Test 1: Tmux Mode Execution
```typescript
const result = await executeClaude(
  'claude-cc-bridge',
  'cc-bridge',
  'Hello Claude!',
  {
    workspace: 'cc-bridge',
    chatId: '123',
    useTmux: true,
  }
);

expect(result).toHaveProperty('requestId');
expect(typeof result.requestId).toBe('string');
```

### Test 2: Sync Mode Execution (Backward Compatibility)
```typescript
const result = await executeClaude(
  'claude-cc-bridge',
  'cc-bridge',
  'Hello Claude!',
  {
    workspace: 'cc-bridge',
    chatId: '123',
    useTmux: false, // Explicit sync mode
  }
);

expect(result).toHaveProperty('success');
expect(result).toHaveProperty('output');
```

### Test 3: Environment Variable Mode Selection
```typescript
process.env.ENABLE_TMUX = 'true';

const result = await executeClaude(
  'claude-cc-bridge',
  'cc-bridge',
  'Hello Claude!',
  { workspace: 'cc-bridge', chatId: '123' }
);

// Should use tmux mode
expect(result).toHaveProperty('requestId');
```

### Test 4: AgentBot Integration
```typescript
const bot = new AgentBot(telegram);

// Mock TmuxManager
const mockSendToSession = jest.fn().mockResolvedValue(undefined);
TmuxManager.prototype.sendToSession = mockSendToSession;

await bot.processMessage(123, 'Test message', 'cc-bridge');

// Verify tmux was called
expect(mockSendToSession).toHaveBeenCalled();
```

### Test 5: Error Handling - Session Creation Fails
```typescript
// Mock TmuxManager to fail
TmuxManager.prototype.getOrCreateSession = jest.fn()
  .mockRejectedValue(new Error('tmux not available'));

const result = await executeClaude(
  'claude-cc-bridge',
  'cc-bridge',
  'Hello!',
  { useTmux: true }
).catch(err => err);

expect(result).toBeInstanceOf(Error);
expect(result.message).toContain('tmux not available');
```

### Test 6: Request ID Uniqueness
```typescript
const results = await Promise.all([
  executeClaude('container', 'instance', 'prompt1', { useTmux: true }),
  executeClaude('container', 'instance', 'prompt2', { useTmux: true }),
  executeClaude('container', 'instance', 'prompt3', { useTmux: true }),
]);

const requestIds = results.map(r => r.requestId);
const uniqueIds = new Set(requestIds);

expect(uniqueIds.size).toBe(3); // All unique
```

### Test 7: Backward Compatibility - Existing Tests
```typescript
// Existing test should still pass without modification
describe('Existing executeClaudeRaw tests', () => {
  it('should execute successfully', async () => {
    const result = await executeClaudeRaw(
      'container',
      'instance',
      'prompt',
      {}
    );

    expect(result.success).toBe(true);
    // ... existing assertions ...
  });
});
```

## Dependencies

- Task 0111 (TmuxManager) must be complete
- Task 0114 (Callback endpoint) must be complete
- Existing ClaudeExecutor implementation
- AgentBot implementation

## Implementation Notes

### Mode Selection Priority

```
1. Explicit config.useTmux (highest priority)
2. Environment variable ENABLE_TMUX
3. Default: false (sync mode for safety)
```

### Request Tracking

Store request metadata for debugging:
```typescript
interface PendingRequest {
  requestId: string;
  chatId: string | number;
  workspace: string;
  timestamp: Date;
  status: 'pending' | 'completed' | 'failed';
}

// Map of pending requests
const pendingRequests = new Map<string, PendingRequest>();
```

### Timeout Handling

In tmux mode, response may never arrive (if Stop Hook fails).
Options:
1. Gateway polls filesystem after timeout
2. User can retry request
3. Background job cleans up stale requests

Implement timeout handling in Phase 2.

## Rollback Plan

If integration fails:
1. Set `ENABLE_TMUX=false` globally
2. All requests fall back to sync mode
3. Remove tmux-specific code in later commit
4. Zero impact on existing functionality

## Success Metrics

- Request submission completes in <1 second
- 100% backward compatibility with existing tests
- Zero errors in sync mode
- Clear distinction between sync/async modes in logs
- All test scenarios pass
