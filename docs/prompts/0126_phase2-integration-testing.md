---
wbs: "0126"
title: "Phase 2.7: Phase 2 Integration Testing"
status: "completed"
priority: "high"
complexity: "medium"
estimated_hours: 5
phase: "phase-2-filesystem-polish"
dependencies: ["0120", "0121", "0122", "0123"]
created: 2026-02-07
completed: 2026-02-07
impl_progress:
  planning: completed
  design: completed
  implementation: completed
  review: completed
  testing: completed
---

# Phase 2.7: Phase 2 Integration Testing

## Description

Comprehensive integration testing for Phase 2 features including file cleanup, Stop Hook retry logic, callback hardening, multi-workspace session pooling, request correlation tracking, and error recovery mechanisms. Validates all Phase 2 components working together in production-like scenarios.

## Requirements

### Functional Requirements

1. **Multi-Workspace Concurrent Testing**
   - Concurrent requests to different workspaces
   - Session isolation verification
   - No cross-workspace contamination
   - Workspace switching during active requests

2. **Large Output Handling**
   - Responses >10MB
   - Special character handling
   - JSON escaping verification
   - File write performance under load

3. **Network Failure Scenarios**
   - Gateway offline during callback
   - Stop Hook retry verification
   - Offline mode activation
   - Recovery when Gateway returns

4. **File System Stress Testing**
   - Disk full scenarios
   - Permission errors
   - Concurrent file writes
   - Cleanup under load

5. **End-to-End Request Flow**
   - Request creation → execution → callback → cleanup
   - State transition verification
   - Correlation tracking accuracy
   - Timeout handling

6. **Error Recovery Integration**
   - Circuit breaker activation
   - Automatic recovery verification
   - User notification delivery
   - Graceful degradation

### Non-Functional Requirements

- All tests must be automated and repeatable
- Test suite completes in <10 minutes
- 100% coverage of integration points
- Performance benchmarks established
- Stress tests validate production capacity

## Design

### Integration Test Suite

**File**: `tests/integration/phase2-integration.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { DockerComposeEnvironment, StartedDockerComposeEnvironment } from 'testcontainers';
import { promises as fs } from 'fs';
import path from 'path';

describe('Phase 2 Integration Tests', () => {
  let environment: StartedDockerComposeEnvironment;
  let gatewayUrl: string;
  let agentContainer: any;

  beforeAll(async () => {
    // Start Docker Compose environment
    environment = await new DockerComposeEnvironment(
      path.join(__dirname, '../../src/dockers'),
      'docker-compose.yml'
    ).up();

    agentContainer = environment.getContainer('claude-agent');
    gatewayUrl = 'http://localhost:8080';

    // Wait for services to be ready
    await waitForServices();
  }, 60000);

  afterAll(async () => {
    await environment.down();
  });

  describe('Multi-Workspace Concurrent Requests', () => {
    it('should handle concurrent requests to different workspaces', async () => {
      const workspaces = ['workspace-a', 'workspace-b', 'workspace-c'];
      const promises = workspaces.map(async (workspace) => {
        const response = await fetch(`${gatewayUrl}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chatId: '123',
            workspace,
            command: `echo "Hello from ${workspace}"`,
          }),
        });

        const data = await response.json();
        return { workspace, requestId: data.requestId };
      });

      const results = await Promise.all(promises);

      // Verify all requests completed
      expect(results).toHaveLength(3);

      // Verify responses are isolated
      for (const { workspace, requestId } of results) {
        const responsePath = `/ipc/${workspace}/responses/${requestId}.json`;
        const responseData = await fs.readFile(responsePath, 'utf-8');
        const response = JSON.parse(responseData);

        expect(response.workspace).toBe(workspace);
        expect(response.output).toContain(`Hello from ${workspace}`);
      }
    });

    it('should maintain session isolation between workspaces', async () => {
      // Set variable in workspace-a
      await executeCommand('workspace-a', 'export TEST_VAR=workspace_a_value');

      // Try to read variable in workspace-b
      const result = await executeCommand('workspace-b', 'echo $TEST_VAR');

      // workspace-b should not see workspace-a's variable
      expect(result.output.trim()).toBe('');
    });
  });

  describe('Large Output Handling', () => {
    it('should handle outputs >10MB', async () => {
      // Generate 15MB of data
      const largeCommand = 'head -c 15728640 /dev/urandom | base64';

      const { requestId, workspace } = await executeCommand('large-test', largeCommand);

      // Verify file was written
      const responsePath = `/ipc/${workspace}/responses/${requestId}.json`;
      const stats = await fs.stat(responsePath);

      expect(stats.size).toBeGreaterThan(10 * 1024 * 1024); // >10MB
    });

    it('should handle special characters in output', async () => {
      const command = 'echo "Test with \\"quotes\\", \\$variables, and \\nnewlines"';
      const result = await executeCommand('special-chars', command);

      // Verify JSON is valid
      const responsePath = `/ipc/special-chars/responses/${result.requestId}.json`;
      const responseData = await fs.readFile(responsePath, 'utf-8');

      expect(() => JSON.parse(responseData)).not.toThrow();
    });
  });

  describe('Network Failure Scenarios', () => {
    it('should retry callback on network failure', async () => {
      // Stop Gateway temporarily
      await stopGateway();

      // Execute command (callback will fail)
      const { requestId, workspace } = await executeCommand('network-test', 'echo "test"');

      // Wait for retries
      await sleep(10000);

      // Restart Gateway
      await startGateway();

      // Verify callback eventually succeeded
      const response = await fetch(`${gatewayUrl}/status/${requestId}`);
      const status = await response.json();

      expect(status.callback?.success).toBe(true);
      expect(status.callback?.attempts).toBeGreaterThan(1);
    });

    it('should enter offline mode when Gateway unavailable', async () => {
      await stopGateway();

      const { requestId, workspace } = await executeCommand('offline-test', 'echo "offline"');

      // Verify file was written despite callback failure
      const responsePath = `/ipc/${workspace}/responses/${requestId}.json`;
      const exists = await fs.access(responsePath).then(() => true).catch(() => false);

      expect(exists).toBe(true);

      await startGateway();
    });
  });

  describe('File System Stress Testing', () => {
    it('should handle disk full scenario', async () => {
      // Fill disk to near capacity
      await fillDisk(90); // 90% full

      const { requestId, workspace } = await executeCommand('disk-test', 'echo "test"');

      // Verify fallback directory was used
      const fallbackPath = `/tmp/ipc-fallback/${workspace}/responses/${requestId}.json`;
      const exists = await fs.access(fallbackPath).then(() => true).catch(() => false);

      expect(exists).toBe(true);

      // Cleanup
      await cleanupDisk();
    });

    it('should handle concurrent file writes', async () => {
      const promises = [];
      for (let i = 0; i < 50; i++) {
        promises.push(executeCommand(`concurrent-${i}`, `echo "Request ${i}"`));
      }

      const results = await Promise.all(promises);

      // Verify all files were written
      expect(results).toHaveLength(50);

      for (const { requestId, workspace } of results) {
        const responsePath = `/ipc/${workspace}/responses/${requestId}.json`;
        const exists = await fs.access(responsePath).then(() => true).catch(() => false);
        expect(exists).toBe(true);
      }
    });
  });

  describe('End-to-End Request Flow', () => {
    it('should track request through all states', async () => {
      const { requestId } = await executeCommand('e2e-test', 'echo "End-to-end test"');

      // Query request status
      const response = await fetch(`${gatewayUrl}/status/${requestId}`);
      const status = await response.json();

      // Verify state transitions
      expect(status.state).toBe('completed');
      expect(status.createdAt).toBeDefined();
      expect(status.queuedAt).toBeDefined();
      expect(status.processingAt).toBeDefined();
      expect(status.completedAt).toBeDefined();
    });

    it('should timeout long-running requests', async () => {
      // Execute long-running command (10 minutes)
      const { requestId } = await executeCommand('timeout-test', 'sleep 600', {
        timeoutMs: 5000, // 5 second timeout
      });

      // Wait for timeout
      await sleep(6000);

      // Verify request timed out
      const response = await fetch(`${gatewayUrl}/status/${requestId}`);
      const status = await response.json();

      expect(status.state).toBe('timeout');
    });
  });

  describe('File Cleanup Integration', () => {
    it('should clean up old response files', async () => {
      // Create old response files
      const workspace = 'cleanup-test';
      const oldRequestId = 'old-request-001';
      const oldFilePath = `/ipc/${workspace}/responses/${oldRequestId}.json`;

      await fs.mkdir(path.dirname(oldFilePath), { recursive: true });
      await fs.writeFile(oldFilePath, JSON.stringify({ test: true }));

      // Set file timestamp to 2 hours ago
      const twoHoursAgo = Date.now() / 1000 - 7200;
      await fs.utimes(oldFilePath, twoHoursAgo, twoHoursAgo);

      // Trigger cleanup
      await triggerCleanup();

      // Wait for cleanup
      await sleep(2000);

      // Verify old file was deleted
      const exists = await fs.access(oldFilePath).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });
  });

  describe('Error Recovery Integration', () => {
    it('should activate circuit breaker after repeated failures', async () => {
      // Cause repeated Stop Hook failures
      for (let i = 0; i < 5; i++) {
        await causeStopHookFailure();
      }

      // Verify circuit breaker opened
      const health = await fetch(`${gatewayUrl}/health`);
      const healthData = await health.json();

      expect(healthData.circuitBreakers.stopHook).toBe('open');
    });

    it('should recover from container restart', async () => {
      // Create pending request
      const { requestId } = await executeCommand('restart-test', 'echo "test"', {
        skipWait: true,
      });

      // Restart container
      await restartContainer();

      // Wait for recovery
      await sleep(10000);

      // Verify request was recovered
      const response = await fetch(`${gatewayUrl}/status/${requestId}`);
      const status = await response.json();

      expect(['completed', 'processing']).toContain(status.state);
    });
  });

  describe('Performance Benchmarks', () => {
    it('should handle 100 requests/minute', async () => {
      const startTime = Date.now();
      const promises = [];

      for (let i = 0; i < 100; i++) {
        promises.push(executeCommand(`perf-${i}`, 'echo "test"'));
      }

      await Promise.all(promises);
      const duration = Date.now() - startTime;

      // Should complete in <60 seconds
      expect(duration).toBeLessThan(60000);
    });

    it('should maintain <10s latency for simple queries', async () => {
      const startTime = Date.now();
      await executeCommand('latency-test', 'echo "simple query"');
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(10000);
    });
  });

  // Helper functions
  async function executeCommand(
    workspace: string,
    command: string,
    options: any = {}
  ): Promise<{ requestId: string; workspace: string }> {
    const response = await fetch(`${gatewayUrl}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatId: '123',
        workspace,
        command,
        ...options,
      }),
    });

    return response.json();
  }

  async function waitForServices(): Promise<void> {
    let retries = 0;
    while (retries < 30) {
      try {
        await fetch(`${gatewayUrl}/health`);
        return;
      } catch {
        retries++;
        await sleep(1000);
      }
    }
    throw new Error('Services failed to start');
  }

  async function stopGateway(): Promise<void> {
    // Implementation depends on your setup
  }

  async function startGateway(): Promise<void> {
    // Implementation depends on your setup
  }

  async function fillDisk(percentage: number): Promise<void> {
    // Create large file to fill disk
  }

  async function cleanupDisk(): Promise<void> {
    // Remove large file
  }

  async function triggerCleanup(): Promise<void> {
    await fetch(`${gatewayUrl}/cleanup/run`, { method: 'POST' });
  }

  async function causeStopHookFailure(): Promise<void> {
    // Trigger Stop Hook failure scenario
  }

  async function restartContainer(): Promise<void> {
    // Restart agent container
  }

  function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
});
```

### Test Configuration

**File**: `tests/integration/test-config.yml`

```yaml
# Docker Compose configuration for integration tests
version: '3.8'

services:
  claude-agent-test:
    build:
      context: ../../src/dockers
      dockerfile: Dockerfile.agent
    environment:
      - WORKSPACE_NAME=test
      - GATEWAY_CALLBACK_URL=http://gateway-test:8080/claude-callback
      - FILE_CLEANUP_TTL_MS=60000  # 1 minute for testing
      - ENABLE_ERROR_RECOVERY=true
    volumes:
      - test-ipc:/ipc
    networks:
      - test-network

  gateway-test:
    build:
      context: ../../src/gateway
      dockerfile: Dockerfile
    ports:
      - "8080:8080"
    environment:
      - IPC_BASE_PATH=/ipc
      - ENABLE_RATE_LIMITING=true
    volumes:
      - test-ipc:/ipc
    networks:
      - test-network

volumes:
  test-ipc:

networks:
  test-network:
```

## Acceptance Criteria

- [ ] All Phase 2 components tested together
- [ ] Multi-workspace concurrent requests work correctly
- [ ] Large outputs (>10MB) handled without errors
- [ ] Network failures trigger appropriate recovery
- [ ] Disk full scenarios use fallback directory
- [ ] 50 concurrent requests complete successfully
- [ ] Request state tracking accurate throughout lifecycle
- [ ] File cleanup removes old files automatically
- [ ] Circuit breaker activates after threshold failures
- [ ] Container restart recovers pending requests
- [ ] Performance benchmarks met (100 requests/min, <10s latency)
- [ ] All tests automated and repeatable
- [ ] Test suite completes in <10 minutes
- [ ] Zero failures in integration test suite

## File Changes

### New Files
1. `tests/integration/phase2-integration.test.ts` - Main integration test suite
2. `tests/integration/test-config.yml` - Test Docker Compose configuration
3. `tests/integration/helpers/test-helpers.ts` - Shared test utilities
4. `tests/integration/fixtures/` - Test data fixtures

### Modified Files
1. `package.json` - Add test scripts and dependencies
2. `.github/workflows/integration-tests.yml` - CI/CD integration

### Deleted Files
- None

## Test Scenarios

### Test 1: Full Phase 2 Workflow

```bash
# Run complete integration test suite
bun test tests/integration/phase2-integration.test.ts

# Expected: All tests pass
# Expected time: <10 minutes
```

### Test 2: Manual Multi-Workspace Test

```bash
# Terminal 1: Workspace A
curl -X POST http://localhost:8080/execute \
  -d '{"chatId":"123","workspace":"workspace-a","command":"export VAR=A && echo $VAR"}'

# Terminal 2: Workspace B
curl -X POST http://localhost:8080/execute \
  -d '{"chatId":"123","workspace":"workspace-b","command":"echo $VAR"}'

# Expected: Workspace B sees empty string (isolation confirmed)
```

### Test 3: Stress Test

```bash
# Send 100 concurrent requests
for i in {1..100}; do
  curl -X POST http://localhost:8080/execute \
    -d "{\"chatId\":\"123\",\"workspace\":\"stress-test\",\"command\":\"echo 'Request $i'\"}" &
done
wait

# Check all responses created
ls /ipc/stress-test/responses/ | wc -l
# Expected: 100
```

## Dependencies

- All Phase 2 tasks (0120-0125) must be complete
- Docker and Docker Compose
- Bun test framework
- testcontainers library

## Implementation Notes

### Test Environment Isolation

Each test run uses fresh Docker Compose environment:
- Isolated network
- Temporary volumes
- Clean state

### Test Data Cleanup

After each test:
```typescript
afterEach(async () => {
  // Clean up test data
  await fs.rm('/ipc/test', { recursive: true, force: true });
});
```

### Performance Baselines

Establish baseline metrics:
- Simple query: <10s
- Complex query: <30s
- 100 concurrent requests: <60s
- File cleanup: <5s for 1000 files

## Rollback Plan

If integration tests fail:

1. Identify failing component from test output
2. Disable specific feature via environment variable
3. Re-run tests to verify fix
4. Fix root cause before production deployment

## Success Metrics

- 100% test pass rate
- Zero flaky tests
- Test suite runtime: <10 minutes
- Code coverage: >80% for Phase 2 code
- Performance benchmarks met
- All acceptance criteria verified
- Production deployment confidence: HIGH

