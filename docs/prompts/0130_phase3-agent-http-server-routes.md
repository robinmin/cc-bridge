---
wbs: "0130"
title: "Phase 3.1: Agent HTTP Server Routes Implementation"
status: "completed"
priority: "high"
complexity: "medium"
estimated_hours: 5
phase: "phase-3-http-api-scheduler"
dependencies: ["0126"]
created: 2026-02-07
completed: 2026-02-07
impl_progress:
  planning: completed
  design: completed
  implementation: completed
  review: completed
  testing: completed
---

# Phase 3.1: Agent HTTP Server Routes Implementation

## Description

Implement HTTP API server within the Agent container to enable programmatic access to Claude sessions. Provides endpoints for executing commands, querying session status, managing sessions, and health checks. Enables scheduled tasks and external integrations beyond Telegram.

## Requirements

### Functional Requirements

1. **POST /execute - Execute Command**
   - Accept JSON payload with workspace, command, timeout
   - Queue command for execution in tmux session
   - Return requestId immediately (async execution)
   - Support request prioritization (normal, high)

2. **GET /health - Health Check**
   - Container health status (running, degraded, unhealthy)
   - Tmux server status
   - Session count and details
   - Filesystem health (IPC directory)
   - Gateway connectivity status

3. **GET /sessions - List Sessions**
   - All active tmux sessions
   - Session metadata (workspace, age, request count)
   - Current session states
   - Resource usage per session (optional)

4. **POST /session/create - Create Session**
   - Explicitly create session for workspace
   - Return session name and status
   - Idempotent (returns existing if already created)

5. **DELETE /session/{workspace} - Kill Session**
   - Gracefully terminate session
   - Reject if active requests pending
   - Force flag for emergency termination
   - Return termination status

6. **GET /status/{requestId} - Query Request Status**
   - Request state and progress
   - Elapsed time and estimated completion
   - Error information if failed
   - Output availability

### Non-Functional Requirements

- API must respond in <100ms (excluding execution time)
- Support 100 concurrent API requests
- RESTful design with proper HTTP status codes
- Request authentication via API key
- Request rate limiting (100 requests/min per API key)
- OpenAPI/Swagger documentation

## Design

### HTTP Server Implementation

**File**: `src/agent/api/server.ts`

```typescript
import Fastify, { FastifyInstance } from 'fastify';
import { Logger } from 'pino';
import { SessionPoolService } from '../services/SessionPoolService';
import { RequestCorrelationService } from '../../gateway/services/RequestCorrelationService';
import { TmuxManager } from '../services/TmuxManager';

interface ServerConfig {
  port: number;
  host: string;
  apiKey: string;
  enableAuth: boolean;
}

export class AgentHttpServer {
  private app: FastifyInstance;
  private logger: Logger;
  private config: ServerConfig;
  private sessionPool: SessionPoolService;
  private correlation: RequestCorrelationService;
  private tmuxManager: TmuxManager;

  constructor(
    config: ServerConfig,
    sessionPool: SessionPoolService,
    correlation: RequestCorrelationService,
    tmuxManager: TmuxManager,
    logger: Logger
  ) {
    this.logger = logger.child({ component: 'AgentHttpServer' });
    this.config = config;
    this.sessionPool = sessionPool;
    this.correlation = correlation;
    this.tmuxManager = tmuxManager;

    this.app = Fastify({
      logger: this.logger,
      requestIdLogLabel: 'reqId',
    });

    this.registerMiddleware();
    this.registerRoutes();
  }

  /**
   * Start HTTP server
   */
  async start(): Promise<void> {
    try {
      await this.app.listen({
        port: this.config.port,
        host: this.config.host,
      });

      this.logger.info(
        {
          port: this.config.port,
          host: this.config.host,
        },
        'Agent HTTP server started'
      );
    } catch (err) {
      this.logger.error({ err }, 'Failed to start HTTP server');
      throw err;
    }
  }

  /**
   * Stop HTTP server
   */
  async stop(): Promise<void> {
    try {
      await this.app.close();
      this.logger.info('Agent HTTP server stopped');
    } catch (err) {
      this.logger.error({ err }, 'Failed to stop HTTP server');
      throw err;
    }
  }

  /**
   * Register middleware
   */
  private registerMiddleware(): void {
    // Authentication
    if (this.config.enableAuth) {
      this.app.addHook('preHandler', async (request, reply) => {
        const apiKey = request.headers['x-api-key'];

        if (!apiKey || apiKey !== this.config.apiKey) {
          reply.code(401).send({ error: 'Unauthorized' });
          return;
        }
      });
    }

    // Rate limiting
    this.app.register(require('@fastify/rate-limit'), {
      max: 100,
      timeWindow: '1 minute',
    });

    // CORS
    this.app.register(require('@fastify/cors'), {
      origin: true,
    });
  }

  /**
   * Register API routes
   */
  private registerRoutes(): void {
    // POST /execute - Execute command
    this.app.post<{
      Body: {
        workspace: string;
        command: string;
        chatId?: string;
        timeoutMs?: number;
        priority?: 'normal' | 'high';
      };
    }>('/execute', async (request, reply) => {
      const { workspace, command, chatId, timeoutMs, priority } = request.body;

      // Validation
      if (!workspace || !command) {
        return reply.code(400).send({
          error: 'Missing required fields: workspace, command',
        });
      }

      try {
        // Generate requestId
        const requestId = this.generateRequestId();

        // Track request
        this.correlation.trackRequest(
          requestId,
          chatId || 'http-api',
          workspace,
          command,
          { timeoutMs }
        );

        // Get or create session
        const session = await this.sessionPool.getOrCreateSession(workspace);

        // Queue command for execution
        this.tmuxManager.sendCommand(command, {
          requestId,
          workspace,
          sessionName: session.sessionName,
          priority: priority || 'normal',
        }).catch((err) => {
          this.logger.error({ err, requestId }, 'Command execution failed');
          this.correlation.updateState(requestId, 'failed', err.message);
        });

        // Update state
        this.correlation.updateState(requestId, 'queued');

        return reply.code(202).send({
          requestId,
          workspace,
          status: 'queued',
          message: 'Command queued for execution',
        });
      } catch (err) {
        this.logger.error({ err }, 'Execute endpoint failed');
        return reply.code(500).send({
          error: 'Internal server error',
          message: err.message,
        });
      }
    });

    // GET /health - Health check
    this.app.get('/health', async (request, reply) => {
      try {
        const health = await this.getHealthStatus();
        const statusCode = health.status === 'healthy' ? 200 : 503;

        return reply.code(statusCode).send(health);
      } catch (err) {
        this.logger.error({ err }, 'Health check failed');
        return reply.code(500).send({
          status: 'unhealthy',
          error: err.message,
        });
      }
    });

    // GET /sessions - List sessions
    this.app.get('/sessions', async (request, reply) => {
      try {
        const sessions = this.sessionPool.listSessions();

        const sessionsData = sessions.map((s) => ({
          workspace: s.workspace,
          sessionName: s.sessionName,
          status: s.status,
          createdAt: s.createdAt,
          lastActivityAt: s.lastActivityAt,
          activeRequests: s.activeRequests,
          totalRequests: s.totalRequests,
          age: Date.now() - s.createdAt,
        }));

        return reply.send({
          sessions: sessionsData,
          total: sessionsData.length,
        });
      } catch (err) {
        this.logger.error({ err }, 'List sessions failed');
        return reply.code(500).send({ error: err.message });
      }
    });

    // POST /session/create - Create session
    this.app.post<{
      Body: { workspace: string };
    }>('/session/create', async (request, reply) => {
      const { workspace } = request.body;

      if (!workspace) {
        return reply.code(400).send({ error: 'Missing workspace' });
      }

      try {
        const session = await this.sessionPool.getOrCreateSession(workspace);

        return reply.code(201).send({
          workspace: session.workspace,
          sessionName: session.sessionName,
          status: session.status,
          createdAt: session.createdAt,
        });
      } catch (err) {
        this.logger.error({ err, workspace }, 'Create session failed');
        return reply.code(500).send({ error: err.message });
      }
    });

    // DELETE /session/:workspace - Delete session
    this.app.delete<{
      Params: { workspace: string };
      Querystring: { force?: boolean };
    }>('/session/:workspace', async (request, reply) => {
      const { workspace } = request.params;
      const { force } = request.query;

      try {
        const session = this.sessionPool.getSession(workspace);

        if (!session) {
          return reply.code(404).send({
            error: `Session not found: ${workspace}`,
          });
        }

        // Check for active requests
        if (session.activeRequests > 0 && !force) {
          return reply.code(409).send({
            error: `Session has ${session.activeRequests} active requests`,
            message: 'Use ?force=true to terminate anyway',
          });
        }

        await this.sessionPool.deleteSession(workspace);

        return reply.send({
          workspace,
          status: 'deleted',
        });
      } catch (err) {
        this.logger.error({ err, workspace }, 'Delete session failed');
        return reply.code(500).send({ error: err.message });
      }
    });

    // GET /status/:requestId - Query request status
    this.app.get<{
      Params: { requestId: string };
    }>('/status/:requestId', async (request, reply) => {
      const { requestId } = request.params;

      try {
        const requestData = this.correlation.getRequest(requestId);

        if (!requestData) {
          return reply.code(404).send({
            error: `Request not found: ${requestId}`,
          });
        }

        const elapsed = Date.now() - requestData.createdAt;
        const duration = requestData.completedAt
          ? requestData.completedAt - requestData.createdAt
          : elapsed;

        return reply.send({
          requestId: requestData.requestId,
          workspace: requestData.workspace,
          state: requestData.state,
          createdAt: requestData.createdAt,
          completedAt: requestData.completedAt,
          elapsed,
          duration,
          error: requestData.error,
          retries: requestData.retries,
        });
      } catch (err) {
        this.logger.error({ err, requestId }, 'Status query failed');
        return reply.code(500).send({ error: err.message });
      }
    });

    // GET /api-docs - OpenAPI documentation
    this.app.get('/api-docs', async (request, reply) => {
      return reply.send(this.getOpenApiSpec());
    });
  }

  /**
   * Get health status
   */
  private async getHealthStatus(): Promise<any> {
    const checks = {
      tmuxServer: await this.checkTmuxServer(),
      sessions: await this.checkSessions(),
      filesystem: await this.checkFilesystem(),
      gateway: await this.checkGateway(),
    };

    const allHealthy = Object.values(checks).every((c: any) => c.healthy);

    return {
      status: allHealthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      checks,
    };
  }

  private async checkTmuxServer(): Promise<any> {
    try {
      const sessions = await this.tmuxManager.listSessions();
      return {
        healthy: true,
        sessionsCount: sessions.length,
      };
    } catch (err) {
      return {
        healthy: false,
        error: err.message,
      };
    }
  }

  private async checkSessions(): Promise<any> {
    const stats = this.sessionPool.getStats();
    return {
      healthy: true,
      ...stats,
    };
  }

  private async checkFilesystem(): Promise<any> {
    try {
      // Check if IPC directory is writable
      const testFile = '/ipc/.health-check';
      await require('fs').promises.writeFile(testFile, 'ok');
      await require('fs').promises.unlink(testFile);

      return { healthy: true };
    } catch (err) {
      return {
        healthy: false,
        error: err.message,
      };
    }
  }

  private async checkGateway(): Promise<any> {
    // Placeholder - implement actual Gateway check
    return { healthy: true };
  }

  private generateRequestId(): string {
    return `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private getOpenApiSpec(): any {
    return {
      openapi: '3.0.0',
      info: {
        title: 'Claude Agent HTTP API',
        version: '1.0.0',
        description: 'HTTP API for Claude Agent container',
      },
      paths: {
        '/execute': {
          post: {
            summary: 'Execute command in Claude session',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['workspace', 'command'],
                    properties: {
                      workspace: { type: 'string' },
                      command: { type: 'string' },
                      chatId: { type: 'string' },
                      timeoutMs: { type: 'number' },
                      priority: { type: 'string', enum: ['normal', 'high'] },
                    },
                  },
                },
              },
            },
            responses: {
              '202': { description: 'Command queued' },
              '400': { description: 'Invalid request' },
              '401': { description: 'Unauthorized' },
              '500': { description: 'Server error' },
            },
          },
        },
        // ... other endpoints
      },
    };
  }
}
```

### Configuration

**File**: `src/agent/config.ts` (add HTTP server config)

```typescript
export const httpServerConfig = {
  enabled: process.env.HTTP_API_ENABLED === 'true',
  port: parseInt(process.env.HTTP_API_PORT || '3000', 10),
  host: process.env.HTTP_API_HOST || '0.0.0.0',
  apiKey: process.env.HTTP_API_KEY || 'default-api-key-change-in-production',
  enableAuth: process.env.HTTP_API_AUTH_ENABLED !== 'false',
};
```

### Integration with Agent Index

**File**: `src/agent/index.ts` (modifications)

```typescript
import { AgentHttpServer } from './api/server';

// ... existing initialization ...

if (httpServerConfig.enabled) {
  const httpServer = new AgentHttpServer(
    httpServerConfig,
    sessionPool,
    correlation,
    tmuxManager,
    logger
  );

  await httpServer.start();

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    await httpServer.stop();
    process.exit(0);
  });
}
```

## Acceptance Criteria

- [ ] POST /execute accepts commands and returns requestId
- [ ] GET /health returns comprehensive health status
- [ ] GET /sessions lists all active sessions with metadata
- [ ] POST /session/create creates new session (idempotent)
- [ ] DELETE /session/{workspace} terminates session
- [ ] GET /status/{requestId} returns request state
- [ ] API authentication via X-API-Key header works
- [ ] Rate limiting enforces 100 requests/min
- [ ] All endpoints respond in <100ms (excluding execution)
- [ ] OpenAPI documentation available at /api-docs
- [ ] Proper HTTP status codes used (200, 201, 400, 401, 404, 500, 503)
- [ ] CORS enabled for cross-origin requests
- [ ] Server starts on configured port
- [ ] Graceful shutdown on SIGTERM

## File Changes

### New Files
1. `src/agent/api/server.ts` - HTTP server implementation
2. `src/agent/api/routes/` - Route handlers (optional organization)
3. `tests/unit/AgentHttpServer.test.ts` - Unit tests
4. `tests/integration/http-api.test.ts` - Integration tests

### Modified Files
1. `src/agent/config.ts` - Add HTTP server configuration
2. `src/agent/index.ts` - Initialize and start HTTP server
3. `src/dockers/docker-compose.yml` - Expose HTTP port
4. `package.json` - Add Fastify dependencies

### Deleted Files
- None

## Test Scenarios

### Test 1: Execute Command

```bash
curl -X POST http://localhost:3000/execute \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "workspace": "test",
    "command": "echo '\''Hello from HTTP API'\''"
  }'

# Expected response (202):
# {
#   "requestId": "req-1234567890-abc123",
#   "workspace": "test",
#   "status": "queued"
# }
```

### Test 2: Health Check

```bash
curl http://localhost:3000/health \
  -H "X-API-Key: your-api-key"

# Expected response (200):
# {
#   "status": "healthy",
#   "timestamp": "2026-02-07T10:30:00Z",
#   "checks": {
#     "tmuxServer": { "healthy": true, "sessionsCount": 3 },
#     "sessions": { "healthy": true, "total": 3, "active": 2 },
#     "filesystem": { "healthy": true },
#     "gateway": { "healthy": true }
#   }
# }
```

### Test 3: List Sessions

```bash
curl http://localhost:3000/sessions \
  -H "X-API-Key: your-api-key"

# Expected response:
# {
#   "sessions": [
#     {
#       "workspace": "project-a",
#       "sessionName": "claude-project-a",
#       "status": "active",
#       "activeRequests": 2,
#       "totalRequests": 15
#     }
#   ],
#   "total": 1
# }
```

### Test 4: Authentication

```bash
# Without API key
curl http://localhost:3000/health

# Expected: 401 Unauthorized

# With invalid API key
curl http://localhost:3000/health \
  -H "X-API-Key: wrong-key"

# Expected: 401 Unauthorized

# With valid API key
curl http://localhost:3000/health \
  -H "X-API-Key: correct-key"

# Expected: 200 OK
```

### Test 5: Rate Limiting

```bash
# Send 101 requests rapidly
for i in {1..101}; do
  curl http://localhost:3000/health -H "X-API-Key: your-api-key" &
done
wait

# Expected: First 100 succeed, 101st returns 429 Too Many Requests
```

### Test 6: Delete Session

```bash
# Try to delete session with active requests
curl -X DELETE http://localhost:3000/session/project-a \
  -H "X-API-Key: your-api-key"

# Expected: 409 Conflict (active requests)

# Force delete
curl -X DELETE "http://localhost:3000/session/project-a?force=true" \
  -H "X-API-Key: your-api-key"

# Expected: 200 OK
```

### Test 7: OpenAPI Documentation

```bash
curl http://localhost:3000/api-docs \
  -H "X-API-Key: your-api-key"

# Expected: OpenAPI 3.0 specification JSON
```

## Dependencies

- Task 0126 (Phase 2 Integration Testing) must be complete
- Fastify framework
- @fastify/rate-limit
- @fastify/cors
- Existing SessionPoolService, RequestCorrelationService

## Implementation Notes

### Port Configuration

Default port: 3000 (agent HTTP API)
Gateway port: 8080 (existing)

Docker Compose:
```yaml
services:
  claude-agent:
    ports:
      - "3000:3000"  # HTTP API
```

### API Key Management

Production:
```bash
HTTP_API_KEY=$(openssl rand -base64 32)
export HTTP_API_KEY
```

### Request Priority

High priority requests jump to front of queue:
```typescript
if (priority === 'high') {
  await tmuxManager.sendCommandHighPriority(command, context);
} else {
  await tmuxManager.sendCommand(command, context);
}
```

## Rollback Plan

If HTTP API causes issues:

1. Disable HTTP server:
   ```bash
   HTTP_API_ENABLED=false
   docker-compose restart claude-agent
   ```

2. System continues working via Telegram

3. No data loss, only feature unavailable

## Success Metrics

- API endpoint response time: <100ms (p95)
- Throughput: 100 requests/min sustained
- Zero authentication bypasses
- 100% OpenAPI spec accuracy
- Health check accuracy: 100%
- All test scenarios pass
- Production deployment successful

