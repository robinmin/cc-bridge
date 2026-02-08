---
wbs: "0149"
title: "Add HTTP Mode Integration Tests"
status: "completed"
priority: "medium"
complexity: "medium"
estimated_hours: 4
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

# Add HTTP Mode Integration Tests

## Description

Add integration tests for HTTP API mode to fill coverage gap. Currently, HTTP mode lacks comprehensive integration tests compared to Telegram mode.

## Requirements

### Functional Requirements

1. Create integration test suite for HTTP API mode
2. Test all HTTP endpoints
3. Test authentication and authorization
4. Test error handling scenarios
5. Test concurrent requests

### Non-Functional Requirements

- Tests are reliable and deterministic
- Fast execution (<30 seconds for full suite)
- Clear test documentation

## Design

### Test Structure

**File**: `src/agent/tests/integration/http-api-mode.test.ts` (new)

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { AgentHttpServer } from '../api/server';
import { SessionPoolService } from '../../gateway/services/SessionPoolService';
import { TmuxManager } from '../../gateway/services/tmux-manager';
import { Logger } from 'pino';

describe('HTTP API Mode - Integration Tests', () => {
  let server: AgentHttpServer;
  let baseUrl: string;
  let apiKey: string;
  let logger: Logger;

  beforeAll(async () => {
    // Setup test environment
    apiKey = 'test-api-key';
    logger = createTestLogger();

    // Initialize services
    const sessionPool = new SessionPoolService(testConfig, logger);
    const tmuxManager = new TmuxManager(testConfig, logger);

    // Create server
    server = new AgentHttpServer(
      {
        port: 0, // Random port
        host: '127.0.0.1',
        apiKey,
        enableAuth: true,
      },
      sessionPool,
      new RequestCorrelationService(),
      tmuxManager,
      logger
    );

    await server.start();

    // Get actual port
    const address = server.server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    // Reset state before each test
  });

  describe('POST /execute', () => {
    it('should execute command successfully', async () => {
      const response = await fetch(`${baseUrl}/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify({
          workspace: 'test-workspace',
          command: 'echo "Hello, World!"',
        }),
      });

      expect(response.status).toBe(202);

      const data = await response.json();
      expect(data.requestId).toBeDefined();
      expect(data.status).toBe('queued');
    });

    it('should require authentication', async () => {
      const response = await fetch(`${baseUrl}/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          workspace: 'test-workspace',
          command: 'echo test',
        }),
      });

      expect(response.status).toBe(401);
    });

    it('should reject invalid API key', async () => {
      const response = await fetch(`${baseUrl}/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'invalid-key',
        },
        body: JSON.stringify({
          workspace: 'test-workspace',
          command: 'echo test',
        }),
      });

      expect(response.status).toBe(401);
    });

    it('should validate required fields', async () => {
      const response = await fetch(`${baseUrl}/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify({
          // Missing workspace
          command: 'echo test',
        }),
      });

      expect(response.status).toBe(400);
    });

    it('should handle priority parameter', async () => {
      const response = await fetch(`${baseUrl}/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify({
          workspace: 'test-workspace',
          command: 'echo test',
          priority: 'high',
        }),
      });

      expect(response.status).toBe(202);
    });
  });

  describe('GET /health', () => {
    it('should return healthy status', async () => {
      const response = await fetch(`${baseUrl}/health`, {
        headers: {
          'X-API-Key': apiKey,
        },
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.status).toBe('healthy');
      expect(data.checks).toBeDefined();
    });

    it('should include all health checks', async () => {
      const response = await fetch(`${baseUrl}/health`, {
        headers: {
          'X-API-Key': apiKey,
        },
      });

      const data = await response.json();

      expect(data.checks.tmuxServer).toBeDefined();
      expect(data.checks.sessions).toBeDefined();
      expect(data.checks.filesystem).toBeDefined();
      expect(data.checks.gateway).toBeDefined();
    });
  });

  describe('GET /sessions', () => {
    it('should list all sessions', async () => {
      const response = await fetch(`${baseUrl}/sessions`, {
        headers: {
          'X-API-Key': apiKey,
        },
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.sessions).toBeInstanceOf(Array);
      expect(data.total).toBeDefined();
    });

    it('should include session metadata', async () => {
      // Create a session first
      await fetch(`${baseUrl}/session/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify({ workspace: 'test-list' }),
      });

      const response = await fetch(`${baseUrl}/sessions`, {
        headers: {
          'X-API-Key': apiKey,
        },
      });

      const data = await response.json();
      const session = data.sessions.find((s: any) => s.workspace === 'test-list');

      expect(session).toBeDefined();
      expect(session.sessionName).toBeDefined();
      expect(session.status).toBeDefined();
      expect(session.createdAt).toBeDefined();
    });
  });

  describe('POST /session/create', () => {
    it('should create new session', async () => {
      const response = await fetch(`${baseUrl}/session/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify({ workspace: 'test-create' }),
      });

      expect(response.status).toBe(201);

      const data = await response.json();
      expect(data.workspace).toBe('test-create');
      expect(data.sessionName).toBeDefined();
    });

    it('should be idempotent', async () => {
      const workspace = 'test-idempotent';

      // Create first time
      const r1 = await fetch(`${baseUrl}/session/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify({ workspace }),
      });

      // Create second time
      const r2 = await fetch(`${baseUrl}/session/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify({ workspace }),
      });

      expect(r1.status).toBe(201);
      expect(r2.status).toBe(201);

      const d1 = await r1.json();
      const d2 = await r2.json();

      expect(d1.sessionName).toBe(d2.sessionName);
    });
  });

  describe('DELETE /session/:workspace', () => {
    it('should delete session', async () => {
      // Create session first
      await fetch(`${baseUrl}/session/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify({ workspace: 'test-delete' }),
      });

      // Delete session
      const response = await fetch(`${baseUrl}/session/test-delete`, {
        method: 'DELETE',
        headers: {
          'X-API-Key': apiKey,
        },
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.workspace).toBe('test-delete');
      expect(data.status).toBe('deleted');
    });

    it('should reject deletion with active requests', async () => {
      // This test requires mocking active requests
      // or actual long-running command

      // Implementation depends on how active requests
      // are tracked in SessionPoolService
    });

    it('should force delete when requested', async () => {
      const response = await fetch(`${baseUrl}/session/test-force?force=true`, {
        method: 'DELETE',
        headers: {
          'X-API-Key': apiKey,
        },
      });

      // Should succeed even with active requests
      expect(response.status).toBe(200);
    });
  });

  describe('GET /status/:requestId', () => {
    it('should return request status', async () => {
      // Execute command first
      const execResponse = await fetch(`${baseUrl}/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify({
          workspace: 'test-status',
          command: 'echo test',
        }),
      });

      const execData = await execResponse.json();
      const requestId = execData.requestId;

      // Query status
      const response = await fetch(`${baseUrl}/status/${requestId}`, {
        headers: {
          'X-API-Key': apiKey,
        },
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.requestId).toBe(requestId);
      expect(data.state).toBeDefined();
      expect(data.elapsed).toBeDefined();
    });

    it('should return 404 for unknown request', async () => {
      const response = await fetch(`${baseUrl}/status/unknown-request-id`, {
        headers: {
          'X-API-Key': apiKey,
        },
      });

      expect(response.status).toBe(404);
    });
  });

  describe('Concurrent Requests', () => {
    it('should handle multiple concurrent requests', async () => {
      const promises = Array.from({ length: 10 }, (_, i) =>
        fetch(`${baseUrl}/execute`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': apiKey,
          },
          body: JSON.stringify({
            workspace: `test-concurrent-${i}`,
            command: `echo "test ${i}"`,
          }),
        })
      );

      const responses = await Promise.all(promises);

      for (const response of responses) {
        expect(response.status).toBe(202);
      }
    });

    it('should enforce rate limiting', async () => {
      // Send many requests rapidly
      const promises = Array.from({ length: 150 }, (_, i) =>
        fetch(`${baseUrl}/health`, {
          headers: {
            'X-API-Key': apiKey,
          },
        }).then(r => r.status)
      );

      const statuses = await Promise.all(promises);

      // Some should be rate limited (429)
      const rateLimited = statuses.filter(s => s === 429);
      expect(rateLimited.length).toBeGreaterThan(0);
    });
  });

  describe('Error Handling', () => {
    it('should handle malformed JSON', async () => {
      const response = await fetch(`${baseUrl}/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: 'invalid json',
      });

      expect(response.status).toBe(400);
    });

    it('should handle internal errors gracefully', async () => {
      // This test requires mocking to cause internal error
      // or using invalid input that causes server error
    });

    it('should return proper error format', async () => {
      const response = await fetch(`${baseUrl}/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify({
          // Missing required fields
          command: 'test',
        }),
      });

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toBeDefined();
    });
  });

  describe('CORS', () => {
    it('should handle CORS preflight', async () => {
      const response = await fetch(`${baseUrl}/execute`, {
        method: 'OPTIONS',
        headers: {
          'Origin': 'http://example.com',
          'Access-Control-Request-Method': 'POST',
        },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBeTruthy();
    });
  });

  describe('OpenAPI Documentation', () => {
    it('should provide API documentation', async () => {
      const response = await fetch(`${baseUrl}/api-docs`, {
        headers: {
          'X-API-Key': apiKey,
        },
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.openapi).toBeDefined();
      expect(data.info).toBeDefined();
      expect(data.paths).toBeDefined();
    });
  });
});
```

## Acceptance Criteria

- [ ] Integration test suite created for HTTP API
- [ ] All endpoints tested
- [ ] Authentication tested
- [ ] Error handling tested
- [ ] Concurrent requests tested
- [ ] Tests execute in <30 seconds
- [ ] All tests pass reliably

## File Changes

### New Files
1. `src/agent/tests/integration/http-api-mode.test.ts` - HTTP API integration tests
2. `src/agent/tests/integration/test-setup.ts` - Test utilities and helpers

### Modified Files
- None (new test file)

### Deleted Files
- None

## Test Scenarios

See test cases above in the test file structure.

## Dependencies

- Vitest testing framework
- fetch API (or node-fetch)
- Existing HTTP server implementation

## Implementation Notes

- Use random port for test isolation
- Clean up sessions between tests
- Mock external dependencies (tmux, filesystem)
- Use test fixtures for common data
- Consider test database for isolation
- Add test for all documented endpoints
- Test edge cases and error conditions

## Rollback Plan

If tests are unstable:
1. Add retry logic for flaky tests
2. Increase timeouts where needed
3. Mark problematic tests as skipped
4. Add test isolation improvements

## Success Metrics

- All HTTP endpoints covered
- >80% code coverage for HTTP mode
- Tests execute in <30 seconds
- Zero flaky tests
