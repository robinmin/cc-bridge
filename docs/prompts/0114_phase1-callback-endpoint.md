---
wbs: "0114"
title: "Phase 1.5: Gateway Callback Endpoint"
status: "pending"
priority: "critical"
complexity: "low"
estimated_hours: 3
phase: "phase-1-core-persistent-sessions"
dependencies: ["0112", "0113"]
created: 2026-02-07
impl_progress:
  planning: completed
  design: pending
  implementation: pending
  review: pending
  testing: pending
---

# Phase 1.5: Gateway Callback Endpoint

## Description

Implement the Gateway callback endpoint that receives Stop Hook notifications, reads the response from the filesystem, and sends it to Telegram. This endpoint acts as the bridge between filesystem IPC and Telegram delivery.

## Requirements

### Functional Requirements

1. **Callback Reception**
   - Receive POST requests from Stop Hook
   - Validate payload structure (requestId, chatId, workspace)
   - Authenticate requests (optional: shared secret)
   - Return quickly (within 100ms)

2. **Response Processing**
   - Read response file from filesystem using FileSystemIpc
   - Parse and validate response structure
   - Format output for Telegram
   - Handle errors gracefully

3. **Telegram Delivery**
   - Send response to correct chat ID
   - Handle Telegram API errors
   - Retry on transient failures
   - Track delivery status

### Non-Functional Requirements

- Endpoint must respond within 100ms
- Must handle concurrent callbacks
- Must be idempotent (duplicate callbacks handled)
- Must log all requests for debugging

## Design

### Callback Endpoint

**File**: `src/gateway/routes/claude-callback.ts`

```typescript
import { Context } from 'hono';
import { z } from 'zod';
import { FileSystemIpc } from '@/gateway/services/filesystem-ipc';
import { TelegramChannel } from '@/gateway/channels/telegram';
import { logger } from '@/packages/logger';

// Request schema
const CallbackRequestSchema = z.object({
  requestId: z.string().uuid(),
  chatId: z.union([z.string(), z.number()]),
  workspace: z.string(),
});

export interface CallbackContext {
  fileSystemIpc: FileSystemIpc;
  telegram: TelegramChannel;
}

export async function handleClaudeCallback(
  c: Context,
  context: CallbackContext
): Promise<Response> {
  const startTime = Date.now();

  try {
    // 1. Parse and validate request
    const body = await c.req.json();
    const parsed = CallbackRequestSchema.safeParse(body);

    if (!parsed.success) {
      logger.warn({ body, errors: parsed.error }, 'Invalid callback payload');
      return c.json({ error: 'Invalid payload' }, 400);
    }

    const { requestId, chatId, workspace } = parsed.data;

    logger.info({ requestId, chatId, workspace }, 'Received Claude callback');

    // 2. Respond quickly to Stop Hook (don't wait for file read)
    c.res.headers.set('X-Request-Id', requestId);
    const response = c.json({ status: 'accepted' }, 202);

    // 3. Process asynchronously (after response sent)
    processCallbackAsync(requestId, chatId, workspace, context)
      .catch(err => {
        logger.error({ err, requestId, chatId }, 'Async callback processing failed');
      });

    const duration = Date.now() - startTime;
    logger.debug({ requestId, duration }, 'Callback response sent');

    return response;

  } catch (error) {
    logger.error({ error }, 'Callback handler error');
    return c.json({ error: 'Internal server error' }, 500);
  }
}

async function processCallbackAsync(
  requestId: string,
  chatId: string | number,
  workspace: string,
  context: CallbackContext
) {
  try {
    // 1. Read response from filesystem
    const response = await context.fileSystemIpc.readResponse(
      workspace,
      requestId
    );

    logger.debug(
      { requestId, outputLength: response.output.length },
      'Response file read successfully'
    );

    // 2. Send to Telegram
    await context.telegram.sendMessage(chatId, response.output, {
      parseMode: 'Markdown',
    });

    logger.info({ requestId, chatId }, 'Response delivered to Telegram');

    // 3. Cleanup response file
    await context.fileSystemIpc.deleteResponse(workspace, requestId);

  } catch (error) {
    logger.error(
      { error, requestId, chatId, workspace },
      'Failed to process callback'
    );

    // Send error message to user
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    await context.telegram.sendMessage(
      chatId,
      `❌ Failed to retrieve Claude response: ${errorMsg}`
    );
  }
}
```

### Route Registration

**File**: `src/gateway/index.ts` (modified)

```typescript
import { handleClaudeCallback } from '@/gateway/routes/claude-callback';
import { FileSystemIpc } from '@/gateway/services/filesystem-ipc';

// Initialize FileSystemIpc
const fileSystemIpc = new FileSystemIpc({
  baseDir: GATEWAY_CONSTANTS.CONFIG.IPC_DIR,
});

// Register callback route
app.post('/claude-callback', (c) =>
  handleClaudeCallback(c, { fileSystemIpc, telegram })
);
```

## Acceptance Criteria

- [ ] Endpoint accepts POST requests at `/claude-callback`
- [ ] Payload validation rejects invalid requests (400 status)
- [ ] Valid requests return 202 Accepted within 100ms
- [ ] Response file is read from filesystem successfully
- [ ] Output is sent to correct Telegram chat ID
- [ ] Response file is deleted after successful delivery
- [ ] Duplicate callbacks are handled idempotently
- [ ] Errors are logged with full context
- [ ] Error messages are sent to user on failure
- [ ] Concurrent callbacks are processed correctly
- [ ] Request ID is included in response headers
- [ ] All test scenarios pass

## File Changes

### New Files
1. `src/gateway/routes/claude-callback.ts` - Callback handler
2. `src/gateway/tests/claude-callback.test.ts` - Unit tests

### Modified Files
1. `src/gateway/index.ts` - Register callback route

### Deleted Files
- None

## Test Scenarios

### Test 1: Valid Callback
```typescript
const mockFileSystemIpc = {
  readResponse: jest.fn().mockResolvedValue({
    requestId: 'req-001',
    chatId: '123',
    workspace: 'cc-bridge',
    timestamp: new Date().toISOString(),
    output: 'Hello from Claude!',
    exitCode: 0,
  }),
  deleteResponse: jest.fn().mockResolvedValue(undefined),
};

const mockTelegram = {
  sendMessage: jest.fn().mockResolvedValue(undefined),
};

const response = await app.request('/claude-callback', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    requestId: 'req-001',
    chatId: '123',
    workspace: 'cc-bridge',
  }),
});

expect(response.status).toBe(202);
expect(await response.json()).toEqual({ status: 'accepted' });

// Wait for async processing
await new Promise(resolve => setTimeout(resolve, 100));

expect(mockFileSystemIpc.readResponse).toHaveBeenCalledWith('cc-bridge', 'req-001');
expect(mockTelegram.sendMessage).toHaveBeenCalledWith('123', 'Hello from Claude!', expect.any(Object));
expect(mockFileSystemIpc.deleteResponse).toHaveBeenCalledWith('cc-bridge', 'req-001');
```

### Test 2: Invalid Payload
```typescript
const response = await app.request('/claude-callback', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    // Missing requestId
    chatId: '123',
  }),
});

expect(response.status).toBe(400);
expect(await response.json()).toEqual({ error: 'Invalid payload' });
```

### Test 3: File Not Found
```typescript
const mockFileSystemIpc = {
  readResponse: jest.fn().mockRejectedValue(
    new Error('Response file not found after 30000ms: req-missing')
  ),
  deleteResponse: jest.fn(),
};

const mockTelegram = {
  sendMessage: jest.fn().mockResolvedValue(undefined),
};

const response = await app.request('/claude-callback', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    requestId: 'req-missing',
    chatId: '123',
    workspace: 'cc-bridge',
  }),
});

expect(response.status).toBe(202); // Still accepts request

// Wait for async processing
await new Promise(resolve => setTimeout(resolve, 100));

// Should send error to user
expect(mockTelegram.sendMessage).toHaveBeenCalledWith(
  '123',
  expect.stringContaining('Failed to retrieve Claude response')
);
```

### Test 4: Telegram Delivery Failure
```typescript
const mockTelegram = {
  sendMessage: jest.fn().mockRejectedValue(
    new Error('Telegram API error: chat not found')
  ),
};

// Should log error and not crash
const response = await app.request('/claude-callback', {
  method: 'POST',
  body: JSON.stringify({ requestId: 'req-002', chatId: '999', workspace: 'cc-bridge' }),
});

expect(response.status).toBe(202);
```

### Test 5: Concurrent Callbacks
```typescript
const callbacks = [
  { requestId: 'req-001', chatId: '123', workspace: 'cc-bridge' },
  { requestId: 'req-002', chatId: '456', workspace: 'cc-bridge' },
  { requestId: 'req-003', chatId: '789', workspace: 'another-project' },
];

const responses = await Promise.all(
  callbacks.map(body =>
    app.request('/claude-callback', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  )
);

// All should succeed
expect(responses.every(r => r.status === 202)).toBe(true);
```

### Test 6: Duplicate Callbacks (Idempotency)
```typescript
const payload = {
  requestId: 'req-duplicate',
  chatId: '123',
  workspace: 'cc-bridge',
};

// Send same callback twice
const response1 = await app.request('/claude-callback', {
  method: 'POST',
  body: JSON.stringify(payload),
});

const response2 = await app.request('/claude-callback', {
  method: 'POST',
  body: JSON.stringify(payload),
});

expect(response1.status).toBe(202);
expect(response2.status).toBe(202);

// Should handle gracefully (file may already be deleted)
```

### Test 7: Response Headers
```typescript
const response = await app.request('/claude-callback', {
  method: 'POST',
  body: JSON.stringify({
    requestId: 'req-headers',
    chatId: '123',
    workspace: 'cc-bridge',
  }),
});

expect(response.headers.get('X-Request-Id')).toBe('req-headers');
```

## Dependencies

- Task 0112 (Filesystem IPC) must be complete
- Task 0113 (Stop Hook) must be complete
- Hono framework
- Zod for validation
- TelegramChannel implementation

## Implementation Notes

### Why 202 Accepted?

Return 202 instead of 200 because:
1. Processing happens asynchronously
2. File may not be ready yet
3. Telegram delivery happens after response
4. Stop Hook doesn't need to wait

### Idempotency

Duplicate callbacks can occur if:
- Stop Hook retries
- Network issues cause duplicate requests
- Multiple tmux sessions for same request

Handle by:
- Checking if file exists before reading
- Ignoring file-not-found errors on delete
- Tracking processed requests (optional)

### Error Handling

Send user-friendly errors to Telegram:
```
❌ Failed to retrieve Claude response: Response file not found after 30000ms
```

Don't expose internal errors in Telegram messages.

## Rollback Plan

If callback endpoint fails:
1. Remove route registration
2. Fall back to existing message handling
3. Can disable via: `ENABLE_CALLBACK_ENDPOINT=false`

## Success Metrics

- Endpoint responds in <100ms
- 100% successful callbacks processed
- <1% duplicate callback overhead
- Zero crashes on invalid payloads
- All test scenarios pass
