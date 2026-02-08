---
wbs: "0134"
title: "Fix Async Mode Ignores Conversation History"
status: "completed"
priority: "critical"
complexity: "medium"
estimated_hours: 3
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

# Fix Async Mode Ignores Conversation History

## Description

The `history` parameter is silently dropped in async/tmux mode, causing loss of conversation context. In `src/gateway/services/claude-executor.ts:234-240, 446-479`, the history is not being passed through to `executeClaudeViaTmux`, resulting in incomplete feature parity between sync and async modes.

## Requirements

### Functional Requirements

1. Implement history building in `executeClaudeViaTmux`
2. Ensure conversation history is preserved across async executions
3. Achieve feature parity with sync mode execution
4. Handle history persistence in tmux sessions

### Non-Functional Requirements

- History operations must not significantly impact performance
- Must handle large conversation histories gracefully
- Proper error handling for history operations

## Design

### Current State Analysis

**File**: `src/gateway/services/claude-executor.ts`

Lines 234-240 (sync mode - uses history):
```typescript
// Sync mode properly uses history parameter
const history = options?.history || [];
// ... history is passed to Claude execution
```

Lines 446-479 (async mode - ignores history):
```typescript
// Async mode - history parameter accepted but not used
async executeClaudeViaTmux(
  containerId: string,
  instanceName: string,
  command: string,
  options?: ExecuteOptions  // history in options but ignored
): Promise<ClaudeResponse> {
  // ... history is never accessed or used
}
```

### Solution Design

**File**: `src/gateway/services/claude-executor.ts`

```typescript
async executeClaudeViaTmux(
  containerId: string,
  instanceName: string,
  command: string,
  options?: ExecuteOptions
): Promise<ClaudeResponse> {
  const { workspace, chatId, timeoutMs, history } = options || {};

  // 1. Build history context for tmux session
  const historyContext = await this.buildHistoryForTmux({
    workspace,
    chatId,
    history: history || [],
  });

  // 2. Prepend history context to command for session awareness
  const commandWithContext = this.prependHistoryToCommand(
    command,
    historyContext
  );

  // 3. Execute via tmux with context
  const sessionName = this.getSessionName(workspace);
  await this.tmuxManager.sendCommand(commandWithContext, {
    workspace,
    sessionName,
  });

  // 4. Wait for response
  const response = await this.waitForResponse(chatId, timeoutMs);

  // 5. Update history for next call
  await this.updateConversationHistory(workspace, chatId, {
    command,
    response,
  });

  return response;
}

/**
 * Build history context for tmux session
 */
private async buildHistoryForTmux(params: {
  workspace: string;
  chatId: string;
  history: ConversationMessage[];
}): Promise<string> {
  const { workspace, chatId, history } = params;

  // Load persisted history if available
  const persistedHistory = await this.loadPersistedHistory(workspace, chatId);
  const fullHistory = [...persistedHistory, ...history];

  if (fullHistory.length === 0) {
    return '';
  }

  // Build context string from history
  const contextLines = fullHistory.map((msg) => {
    if (msg.role === 'user') {
      return `User: ${msg.content}`;
    } else {
      return `Assistant: ${msg.content}`;
    }
  });

  return `
# Previous conversation context:
${contextLines.join('\n')}

---
`;
}

/**
 * Prepend history context to command
 */
private prependHistoryToCommand(command: string, context: string): string {
  if (!context) {
    return command;
  }

  // For tmux sessions, we can use a comment block or special marker
  return `${context}\n${command}`;
}

/**
 * Load persisted history from storage
 */
private async loadPersistedHistory(
  workspace: string,
  chatId: string
): Promise<ConversationMessage[]> {
  try {
    const historyFile = this.getHistoryFilePath(workspace, chatId);

    if (!await fileExists(historyFile)) {
      return [];
    }

    const content = await readFile(historyFile, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    this.logger.warn({ error, workspace, chatId }, 'Failed to load history');
    return [];
  }
}

/**
 * Update conversation history after execution
 */
private async updateConversationHistory(
  workspace: string,
  chatId: string,
  entry: { command: string; response: ClaudeResponse }
): Promise<void> {
  try {
    const historyFile = this.getHistoryFilePath(workspace, chatId);
    const history = await this.loadPersistedHistory(workspace, chatId);

    // Add new entries
    history.push({
      role: 'user',
      content: entry.command,
      timestamp: Date.now(),
    });

    history.push({
      role: 'assistant',
      content: entry.response.content || '',
      timestamp: Date.now(),
    });

    // Keep only last N messages to prevent unbounded growth
    const MAX_HISTORY = 100;
    const trimmedHistory = history.slice(-MAX_HISTORY);

    // Persist to file
    await writeFile(historyFile, JSON.stringify(trimmedHistory, null, 2));
  } catch (error) {
    this.logger.warn({ error, workspace, chatId }, 'Failed to update history');
  }
}

/**
 * Get history file path for workspace/chat
 */
private getHistoryFilePath(workspace: string, chatId: string): string {
  const safeWorkspace = workspace.replace(/[^a-zA-Z0-9-_]/g, '_');
  const safeChatId = chatId.replace(/[^a-zA-Z0-9-_]/g, '_');
  return `/data/history/${safeWorkspace}/${safeChatId}.json`;
}
```

## Acceptance Criteria

- [ ] History parameter is used in async mode
- [ ] Conversation context is maintained across async executions
- [ ] History is persisted to disk for later retrieval
- [ ] Feature parity with sync mode achieved
- [ ] Performance impact is minimal (<50ms overhead)
- [ ] Large histories are handled gracefully (trimmed)
- [ ] All tests pass including new history tests

## File Changes

### New Files
1. `src/gateway/tests/history-management.test.ts` - Tests for history in async mode

### Modified Files
1. `src/gateway/services/claude-executor.ts` - Add history handling in executeClaudeViaTmux

### Deleted Files
- None

## Test Scenarios

### Test 1: History Preserved in Async Mode
```typescript
const history = [
  { role: 'user', content: 'Hello', timestamp: Date.now() },
  { role: 'assistant', content: 'Hi there!', timestamp: Date.now() },
];

const result1 = await executor.executeClaudeViaTmux('c1', 'i1', 'My name is Alice', { history });
const result2 = await executor.executeClaudeViaTmux('c1', 'i1', 'What is my name?', { history });

// Result2 should know the name is Alice from previous context
assert(result2.content.includes('Alice'));
```

### Test 2: History Persistence
```typescript
// Execute with history
await executor.executeClaudeViaTmux('c1', 'i1', 'Remember X', {
  workspace: 'test',
  chatId: 'test-chat',
  history: [],
});

// Load persisted history
const loaded = await executor.loadPersistedHistory('test', 'test-chat');
assert(loaded.length > 0);
```

### Test 3: History Trimming
```typescript
// Add more than MAX_HISTORY messages
const largeHistory = Array.from({ length: 150 }, (_, i) => ({
  role: 'user' as const,
  content: `Message ${i}`,
  timestamp: Date.now(),
}));

await executor.updateConversationHistory('test', 'test', {
  command: 'last',
  response: { content: 'response' },
});

// Should only keep last 100
const trimmed = await executor.loadPersistedHistory('test', 'test');
assert(trimmed.length === 100); // Last 50 user + 50 assistant = 100 messages
```

### Test 4: No History Performance Impact
```typescript
// Measure execution time without history
const start1 = Date.now();
await executor.executeClaudeViaTmux('c1', 'i1', 'test', {});
const time1 = Date.now() - start1;

// Measure with empty history
const start2 = Date.now();
await executor.executeClaudeViaTmux('c1', 'i1', 'test', { history: [] });
const time2 = Date.now() - start2;

// Should be similar (allow 50ms variance)
assert(Math.abs(time1 - time2) < 50);
```

## Dependencies

- None

## Implementation Notes

- History files should be stored in `/data/history/` directory
- Use JSON format for easy debugging
- Implement history trimming to prevent unbounded growth
- Handle errors gracefully - don't fail execution if history operations fail
- Consider compression for large history files

## Rollback Plan

If history implementation causes issues:
1. Make history operations optional (behind feature flag)
2. Add try-catch to prevent failures from affecting execution
3. Can disable history persistence while keeping in-memory history

## Success Metrics

- Conversation context maintained across async executions
- <50ms overhead for history operations
- 100% test coverage for history code
- Zero execution failures due to history operations
