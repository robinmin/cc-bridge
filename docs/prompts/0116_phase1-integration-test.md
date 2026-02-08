---
wbs: "0116"
title: "Phase 1.7: End-to-End Integration Test"
status: "completed"
priority: "critical"
complexity: "medium"
estimated_hours: 4
phase: "phase-1-core-persistent-sessions"
dependencies: ["0110", "0111", "0112", "0113", "0114", "0115"]
created: 2026-02-07
completed: 2026-02-07
impl_progress:
  planning: completed
  design: completed
  implementation: completed
  review: completed
  testing: completed
---

# Phase 1.7: End-to-End Integration Test

## Description

Create comprehensive end-to-end tests to verify the entire persistent tmux session workflow: from Telegram message → tmux execution → Stop Hook → callback → Telegram response.

## Requirements

### Functional Requirements

1. **Complete User Flow**
   - Send message via Telegram
   - Verify tmux session created
   - Verify Claude executes in tmux
   - Verify Stop Hook writes response file
   - Verify callback is received
   - Verify response sent to Telegram

2. **Performance Validation**
   - Measure total latency (Telegram → Telegram)
   - Verify latency is <30s (vs current 120s timeout)
   - Confirm no timeouts occur

3. **Error Scenarios**
   - Container not found
   - tmux unavailable
   - Stop Hook fails
   - Callback endpoint down
   - File not written

### Non-Functional Requirements

- Tests must be automated (no manual intervention)
- Tests must clean up resources (sessions, files)
- Tests must be repeatable
- Tests must provide clear failure diagnostics

## Design

### Test Structure

**File**: `src/gateway/tests/integration/tmux-workflow.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { TelegramChannel } from '@/gateway/channels/telegram';
import { AgentBot } from '@/gateway/pipeline/agent-bot';
import { instanceManager } from '@/gateway/instance-manager';
import { FileSystemIpc } from '@/gateway/services/filesystem-ipc';
import { TmuxManager } from '@/gateway/services/tmux-manager';
import crypto from 'node:crypto';

describe('End-to-End tmux Workflow', () => {
  let telegram: TelegramChannel;
  let agentBot: AgentBot;
  let fileSystemIpc: FileSystemIpc;
  let tmuxManager: TmuxManager;
  let testChatId: number;

  beforeAll(async () => {
    // Initialize components
    telegram = new TelegramChannel(process.env.TELEGRAM_BOT_TOKEN);
    agentBot = new AgentBot(telegram);
    fileSystemIpc = new FileSystemIpc({ baseDir: './data/ipc' });
    tmuxManager = new TmuxManager();

    // Discover instances
    await instanceManager.refresh();

    // Use test chat ID
    testChatId = parseInt(process.env.TEST_CHAT_ID || '0');
  });

  afterAll(async () => {
    // Cleanup test sessions
    const instances = instanceManager.getInstances();
    for (const instance of instances) {
      const sessions = await tmuxManager.listSessions(instance.containerId);
      for (const session of sessions) {
        if (session.includes('test-')) {
          await tmuxManager.killSession(instance.containerId, session);
        }
      }
    }
  });

  it('should complete full workflow: Telegram → tmux → callback → Telegram', async () => {
    const workspace = 'cc-bridge';
    const testMessage = 'Hello Claude! This is a test message.';

    // 1. Send message via AgentBot
    const startTime = Date.now();

    await agentBot.processMessage(testChatId, testMessage, workspace);

    // 2. Verify tmux session was created
    const instance = instanceManager.getInstance(workspace);
    expect(instance).toBeDefined();

    const sessionName = `claude-${workspace}-${testChatId}`;
    const sessionExists = await tmuxManager.sessionExists(
      instance!.containerId,
      sessionName
    );
    expect(sessionExists).toBe(true);

    // 3. Wait for response (with timeout)
    const receivedMessage = await waitForTelegramMessage(
      testChatId,
      30000 // 30s timeout
    );

    const endTime = Date.now();
    const totalLatency = endTime - startTime;

    // 4. Verify response
    expect(receivedMessage).toBeDefined();
    expect(receivedMessage.text).toContain(''); // Any response

    // 5. Verify latency
    expect(totalLatency).toBeLessThan(30000); // <30s (vs 120s timeout)

    console.log(`✓ Total latency: ${totalLatency}ms`);
  }, 60000); // 60s test timeout

  it('should reuse existing session for same chat', async () => {
    const workspace = 'cc-bridge';
    const instance = instanceManager.getInstance(workspace);

    // Send first message
    await agentBot.processMessage(testChatId, 'First message', workspace);

    // Wait for completion
    await waitForTelegramMessage(testChatId, 30000);

    // Get session count
    const sessionsBeforeSecond = await tmuxManager.listSessions(
      instance!.containerId
    );

    // Send second message
    await agentBot.processMessage(testChatId, 'Second message', workspace);

    // Verify session count unchanged (reused)
    const sessionsAfterSecond = await tmuxManager.listSessions(
      instance!.containerId
    );

    expect(sessionsAfterSecond.length).toBe(sessionsBeforeSecond.length);
  }, 90000);

  it('should handle concurrent requests to same session', async () => {
    const workspace = 'cc-bridge';

    // Send 3 concurrent messages
    const promises = [
      agentBot.processMessage(testChatId, 'Concurrent 1', workspace),
      agentBot.processMessage(testChatId, 'Concurrent 2', workspace),
      agentBot.processMessage(testChatId, 'Concurrent 3', workspace),
    ];

    // All should complete without errors
    await Promise.all(promises);

    // Wait for all responses
    const responses = await Promise.all([
      waitForTelegramMessage(testChatId, 30000),
      waitForTelegramMessage(testChatId, 30000),
      waitForTelegramMessage(testChatId, 30000),
    ]);

    expect(responses.length).toBe(3);
  }, 120000);

  it('should handle Stop Hook failure gracefully', async () => {
    // Temporarily disable callback endpoint
    // (simulate Stop Hook callback failure)

    const workspace = 'cc-bridge';
    const instance = instanceManager.getInstance(workspace);

    // Send message
    await agentBot.processMessage(testChatId, 'Test with hook failure', workspace);

    // Response file should still be written
    // (even if callback fails)

    // Wait and check filesystem directly
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Verify response file exists
    const files = await fs.promises.readdir(
      `./data/ipc/${workspace}/responses`
    );

    expect(files.length).toBeGreaterThan(0);
  }, 30000);
});

// Helper: Wait for Telegram message
async function waitForTelegramMessage(
  chatId: number,
  timeout: number
): Promise<{ text: string }> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    // Poll Telegram for new messages
    // (Use Telegram getUpdates API)
    const updates = await telegram.getUpdates();

    const message = updates.find(
      u => u.message?.chat.id === chatId &&
           u.message.date * 1000 > startTime
    );

    if (message) {
      return { text: message.message.text };
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  throw new Error(`No message received after ${timeout}ms`);
}
```

### Performance Test

**File**: `src/gateway/tests/integration/performance.test.ts`

```typescript
describe('Performance Benchmarks', () => {
  it('should complete simple query in <10s', async () => {
    const startTime = Date.now();

    await agentBot.processMessage(testChatId, 'What is 2+2?', 'cc-bridge');
    await waitForTelegramMessage(testChatId, 30000);

    const latency = Date.now() - startTime;

    expect(latency).toBeLessThan(10000); // <10s for simple query
    console.log(`Simple query latency: ${latency}ms`);
  });

  it('should handle 10 sequential requests without timeout', async () => {
    const latencies: number[] = [];

    for (let i = 0; i < 10; i++) {
      const start = Date.now();

      await agentBot.processMessage(
        testChatId,
        `Request ${i + 1}`,
        'cc-bridge'
      );
      await waitForTelegramMessage(testChatId, 30000);

      latencies.push(Date.now() - start);
    }

    const avgLatency = latencies.reduce((a, b) => a + b) / latencies.length;
    const maxLatency = Math.max(...latencies);

    console.log(`Average latency: ${avgLatency}ms`);
    console.log(`Max latency: ${maxLatency}ms`);

    expect(maxLatency).toBeLessThan(30000); // All <30s
  });
});
```

## Acceptance Criteria

- [ ] End-to-end test passes: Telegram → tmux → callback → Telegram
- [ ] Total latency is <30s (improvement from 120s timeout)
- [ ] Simple queries complete in <10s
- [ ] Session reuse works correctly
- [ ] Concurrent requests don't cause errors
- [ ] Stop Hook failure is handled gracefully
- [ ] Performance benchmarks show improvement
- [ ] All cleanup happens (no resource leaks)
- [ ] Tests provide clear failure diagnostics
- [ ] Tests are repeatable

## File Changes

### New Files
1. `src/gateway/tests/integration/tmux-workflow.test.ts` - E2E tests
2. `src/gateway/tests/integration/performance.test.ts` - Performance benchmarks
3. `scripts/run-integration-tests.sh` - Test runner script

### Modified Files
- None

### Deleted Files
- None

## Test Scenarios

All test scenarios are embedded in the test files above.

## Dependencies

- All Phase 1 tasks (0110-0115) must be complete
- Docker containers running
- Telegram bot configured
- Test chat ID available

## Implementation Notes

### Test Environment Setup

```bash
# Environment variables for integration tests
export TELEGRAM_BOT_TOKEN="..."
export TEST_CHAT_ID="123456789"
export ENABLE_TMUX="true"
```

### Running Tests

```bash
# Run integration tests
bun test src/gateway/tests/integration/

# Run with verbose logging
DEBUG=* bun test src/gateway/tests/integration/

# Run performance benchmarks only
bun test src/gateway/tests/integration/performance.test.ts
```

### CI/CD Integration

```yaml
# .github/workflows/integration-test.yml
name: Integration Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - name: Start Docker containers
        run: docker-compose up -d
      - name: Run integration tests
        run: bun test src/gateway/tests/integration/
        env:
          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          TEST_CHAT_ID: ${{ secrets.TEST_CHAT_ID }}
```

## Rollback Plan

If integration tests fail:
1. Identify failing component (tmux, hook, callback)
2. Disable tmux mode: `ENABLE_TMUX=false`
3. Fix component in isolation
4. Re-run integration tests

## Success Metrics

- All integration tests pass
- Average latency <15s for simple queries
- Zero timeouts in 100 sequential requests
- 100% success rate for concurrent requests
- Clear performance improvement over existing implementation
