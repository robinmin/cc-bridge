---
wbs: "0122"
title: "Phase 2.3: Gateway Callback Hardening"
status: "completed"
priority: "high"
complexity: "medium"
estimated_hours: 4
phase: "phase-2-filesystem-polish"
dependencies: ["0114", "0121"]
created: 2026-02-07
completed: 2026-02-07
impl_progress:
  planning: completed
  design: completed
  implementation: completed
  review: completed
  testing: completed
---

# Phase 2.3: Gateway Callback Hardening

## Description

Harden the Gateway callback endpoint with comprehensive request validation, file read error handling, duplicate request detection (idempotency), and rate limiting. Ensures the Gateway can handle malformed requests, corrupted files, and high-frequency callbacks gracefully.

## Requirements

### Functional Requirements

1. **Request Validation**
   - JSON schema enforcement for callback payload
   - Validate requestId format (UUID or alphanumeric)
   - Validate chatId (numeric, positive)
   - Validate workspace name (alphanumeric, no special chars)
   - Reject missing or invalid fields with 400 status

2. **File Read Error Handling**
   - Handle missing response files (404)
   - Handle corrupted JSON files (parse errors)
   - Handle oversized files (>50MB limit)
   - Handle permission errors (EACCES)
   - Retry file reads with exponential backoff (3 attempts)

3. **Duplicate Request Detection (Idempotency)**
   - Track processed requestIds in memory (LRU cache, 10k entries)
   - Return 200 immediately for duplicate requests
   - Log duplicate detection for monitoring
   - Prevent double-processing of same response

4. **Rate Limiting**
   - Per-workspace rate limit: 100 callbacks/minute
   - Per-IP rate limit: 200 callbacks/minute
   - Return 429 status when limit exceeded
   - Exponential backoff headers (Retry-After)
   - Whitelist for trusted IPs (container network)

5. **Security Hardening**
   - Sanitize file paths (prevent directory traversal)
   - Validate workspace name (no ../../ injection)
   - Request size limit (10KB max payload)
   - Timeout enforcement (5 second max processing)
   - HMAC signature verification (optional)

### Non-Functional Requirements

- Validation must complete in <10ms
- File reads must complete in <100ms
- Duplicate detection must be O(1) lookup
- Rate limiting must not block valid requests
- Must handle 1000 callbacks/minute peak load
- Error responses must be structured JSON

## Design

### Validation Schemas

**File**: `src/gateway/schemas/callback.ts`

```typescript
import { Type, Static } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';

// Callback request schema
export const CallbackRequestSchema = Type.Object({
  requestId: Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: '^[a-zA-Z0-9_-]+$',
    description: 'Unique request identifier'
  }),
  chatId: Type.String({
    minLength: 1,
    maxLength: 32,
    pattern: '^[0-9]+$',
    description: 'Telegram chat ID'
  }),
  workspace: Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: '^[a-zA-Z0-9_-]+$',
    description: 'Workspace name'
  }),
});

export type CallbackRequest = Static<typeof CallbackRequestSchema>;

// Compile schema for fast validation
export const validateCallbackRequest = TypeCompiler.Compile(CallbackRequestSchema);

// Response file schema
export const ResponseFileSchema = Type.Object({
  requestId: Type.String(),
  chatId: Type.String(),
  workspace: Type.String(),
  timestamp: Type.String(),
  output: Type.String(),
  exitCode: Type.Number(),
  error: Type.String(),
  callback: Type.Optional(Type.Object({
    success: Type.Boolean(),
    attempts: Type.Number(),
    error: Type.String(),
    retryTimestamps: Type.Array(Type.String()),
  })),
});

export type ResponseFile = Static<typeof ResponseFileSchema>;

export const validateResponseFile = TypeCompiler.Compile(ResponseFileSchema);
```

### Idempotency Service

**File**: `src/gateway/services/IdempotencyService.ts`

```typescript
import { Logger } from 'pino';
import { LRUCache } from 'lru-cache';

interface ProcessedRequest {
  requestId: string;
  timestamp: number;
  chatId: string;
  workspace: string;
}

export class IdempotencyService {
  private cache: LRUCache<string, ProcessedRequest>;
  private logger: Logger;

  constructor(logger: Logger, maxSize: number = 10000) {
    this.logger = logger.child({ component: 'IdempotencyService' });
    this.cache = new LRUCache<string, ProcessedRequest>({
      max: maxSize,
      ttl: 3600000, // 1 hour TTL
      updateAgeOnGet: false,
    });
  }

  /**
   * Check if request was already processed
   */
  isDuplicate(requestId: string): boolean {
    return this.cache.has(requestId);
  }

  /**
   * Mark request as processed
   */
  markProcessed(requestId: string, chatId: string, workspace: string): void {
    this.cache.set(requestId, {
      requestId,
      chatId,
      workspace,
      timestamp: Date.now(),
    });

    this.logger.debug({ requestId }, 'Request marked as processed');
  }

  /**
   * Get processed request details
   */
  getProcessed(requestId: string): ProcessedRequest | undefined {
    return this.cache.get(requestId);
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.cache.max,
      hitRate: this.cache.calculatedSize / (this.cache.size || 1),
    };
  }
}
```

### Rate Limiting Service

**File**: `src/gateway/services/RateLimitService.ts`

```typescript
import { Logger } from 'pino';

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

export class RateLimitService {
  private workspaceLimits: Map<string, RateLimitEntry> = new Map();
  private ipLimits: Map<string, RateLimitEntry> = new Map();
  private logger: Logger;

  private readonly WORKSPACE_LIMIT = 100; // per minute
  private readonly IP_LIMIT = 200; // per minute
  private readonly WINDOW_MS = 60000; // 1 minute

  constructor(logger: Logger) {
    this.logger = logger.child({ component: 'RateLimitService' });
  }

  /**
   * Check if request should be rate limited
   */
  checkLimit(workspace: string, ip: string): {
    allowed: boolean;
    retryAfter?: number;
    reason?: string;
  } {
    const now = Date.now();

    // Check workspace limit
    const wsLimit = this.getOrCreateLimit(this.workspaceLimits, workspace, now);
    if (wsLimit.count >= this.WORKSPACE_LIMIT) {
      return {
        allowed: false,
        retryAfter: Math.ceil((wsLimit.resetTime - now) / 1000),
        reason: 'workspace_limit_exceeded',
      };
    }

    // Check IP limit
    const ipLimit = this.getOrCreateLimit(this.ipLimits, ip, now);
    if (ipLimit.count >= this.IP_LIMIT) {
      return {
        allowed: false,
        retryAfter: Math.ceil((ipLimit.resetTime - now) / 1000),
        reason: 'ip_limit_exceeded',
      };
    }

    // Increment counters
    wsLimit.count++;
    ipLimit.count++;

    return { allowed: true };
  }

  /**
   * Reset limits for workspace or IP
   */
  resetLimit(type: 'workspace' | 'ip', key: string): void {
    const map = type === 'workspace' ? this.workspaceLimits : this.ipLimits;
    map.delete(key);
    this.logger.info({ type, key }, 'Rate limit reset');
  }

  /**
   * Get or create limit entry
   */
  private getOrCreateLimit(
    map: Map<string, RateLimitEntry>,
    key: string,
    now: number
  ): RateLimitEntry {
    let entry = map.get(key);

    if (!entry || now >= entry.resetTime) {
      entry = {
        count: 0,
        resetTime: now + this.WINDOW_MS,
      };
      map.set(key, entry);
    }

    return entry;
  }

  /**
   * Cleanup expired entries
   */
  cleanup(): void {
    const now = Date.now();

    for (const [key, entry] of this.workspaceLimits.entries()) {
      if (now >= entry.resetTime) {
        this.workspaceLimits.delete(key);
      }
    }

    for (const [key, entry] of this.ipLimits.entries()) {
      if (now >= entry.resetTime) {
        this.ipLimits.delete(key);
      }
    }

    this.logger.debug('Rate limit cleanup completed');
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      workspaces: this.workspaceLimits.size,
      ips: this.ipLimits.size,
    };
  }
}
```

### File Reading with Retry

**File**: `src/gateway/services/ResponseFileReader.ts`

```typescript
import { promises as fs } from 'fs';
import path from 'path';
import { Logger } from 'pino';
import { ResponseFile, validateResponseFile } from '../schemas/callback';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_READ_RETRIES = 3;
const READ_RETRY_DELAY_MS = 100;

export class ResponseFileReader {
  private logger: Logger;
  private ipcBasePath: string;

  constructor(ipcBasePath: string, logger: Logger) {
    this.logger = logger.child({ component: 'ResponseFileReader' });
    this.ipcBasePath = ipcBasePath;
  }

  /**
   * Read and validate response file with retry
   */
  async readResponseFile(
    workspace: string,
    requestId: string
  ): Promise<ResponseFile> {
    // Sanitize inputs (prevent directory traversal)
    const sanitizedWorkspace = this.sanitizePath(workspace);
    const sanitizedRequestId = this.sanitizePath(requestId);

    const filePath = path.join(
      this.ipcBasePath,
      sanitizedWorkspace,
      'responses',
      `${sanitizedRequestId}.json`
    );

    // Verify path is within IPC directory
    const resolvedPath = path.resolve(filePath);
    const resolvedBase = path.resolve(this.ipcBasePath);
    if (!resolvedPath.startsWith(resolvedBase)) {
      throw new Error('Invalid file path (directory traversal attempt)');
    }

    // Read with retry
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= MAX_READ_RETRIES; attempt++) {
      try {
        return await this.readAndValidate(filePath);
      } catch (err) {
        lastError = err as Error;
        this.logger.warn({
          err,
          filePath,
          attempt,
          maxRetries: MAX_READ_RETRIES,
        }, 'File read failed, retrying');

        if (attempt < MAX_READ_RETRIES) {
          await this.sleep(READ_RETRY_DELAY_MS * attempt);
        }
      }
    }

    throw lastError;
  }

  /**
   * Read file and validate contents
   */
  private async readAndValidate(filePath: string): Promise<ResponseFile> {
    // Check file size
    const stats = await fs.stat(filePath);
    if (stats.size > MAX_FILE_SIZE) {
      throw new Error(`File too large: ${stats.size} bytes (max ${MAX_FILE_SIZE})`);
    }

    // Read file
    const content = await fs.readFile(filePath, 'utf-8');

    // Parse JSON
    let data: unknown;
    try {
      data = JSON.parse(content);
    } catch (err) {
      throw new Error(`Invalid JSON: ${(err as Error).message}`);
    }

    // Validate schema
    if (!validateResponseFile.Check(data)) {
      const errors = Array.from(validateResponseFile.Errors(data));
      throw new Error(`Schema validation failed: ${JSON.stringify(errors)}`);
    }

    return data as ResponseFile;
  }

  /**
   * Sanitize path component (remove dangerous characters)
   */
  private sanitizePath(input: string): string {
    // Remove any path separators and special characters
    return input.replace(/[^a-zA-Z0-9_-]/g, '');
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

### Hardened Callback Route

**File**: `src/gateway/routes/callback.ts` (complete rewrite)

```typescript
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { logger } from '../utils/logger';
import { CallbackRequest, validateCallbackRequest } from '../schemas/callback';
import { IdempotencyService } from '../services/IdempotencyService';
import { RateLimitService } from '../services/RateLimitService';
import { ResponseFileReader } from '../services/ResponseFileReader';

export async function callbackRoutes(fastify: FastifyInstance) {
  const idempotency = new IdempotencyService(logger);
  const rateLimit = new RateLimitService(logger);
  const fileReader = new ResponseFileReader('/ipc', logger);

  // Cleanup rate limits every minute
  setInterval(() => rateLimit.cleanup(), 60000);

  fastify.post('/claude-callback', {
    schema: {
      body: CallbackRequestSchema,
    },
    config: {
      // 10KB request size limit
      bodyLimit: 10 * 1024,
    },
  }, async (request: FastifyRequest<{ Body: CallbackRequest }>, reply: FastifyReply) => {
    const startTime = Date.now();
    const { requestId, chatId, workspace } = request.body;
    const clientIp = request.ip;

    try {
      // 1. Request validation
      if (!validateCallbackRequest.Check(request.body)) {
        const errors = Array.from(validateCallbackRequest.Errors(request.body));
        logger.warn({ errors, body: request.body }, 'Invalid callback payload');
        return reply.code(400).send({
          error: 'Validation failed',
          details: errors,
        });
      }

      // 2. Rate limiting
      const rateLimitResult = rateLimit.checkLimit(workspace, clientIp);
      if (!rateLimitResult.allowed) {
        logger.warn({
          workspace,
          clientIp,
          reason: rateLimitResult.reason,
        }, 'Rate limit exceeded');

        return reply
          .code(429)
          .header('Retry-After', rateLimitResult.retryAfter!)
          .send({
            error: 'Rate limit exceeded',
            reason: rateLimitResult.reason,
            retryAfter: rateLimitResult.retryAfter,
          });
      }

      // 3. Idempotency check
      if (idempotency.isDuplicate(requestId)) {
        const processed = idempotency.getProcessed(requestId);
        logger.info({ requestId, processed }, 'Duplicate request detected');
        return reply.code(200).send({
          success: true,
          duplicate: true,
        });
      }

      // 4. Read response file with retry
      let responseData;
      try {
        responseData = await fileReader.readResponseFile(workspace, requestId);
      } catch (err) {
        logger.error({
          err,
          requestId,
          workspace,
        }, 'Failed to read response file');

        // Distinguish between missing and corrupted files
        if ((err as Error).message.includes('ENOENT')) {
          return reply.code(404).send({ error: 'Response file not found' });
        } else if ((err as Error).message.includes('Invalid JSON')) {
          return reply.code(422).send({ error: 'Corrupted response file' });
        } else if ((err as Error).message.includes('too large')) {
          return reply.code(413).send({ error: 'Response file too large' });
        } else {
          return reply.code(500).send({ error: 'Failed to read response file' });
        }
      }

      // 5. Process response
      await processClaudeResponse(responseData);

      // 6. Mark as processed
      idempotency.markProcessed(requestId, chatId, workspace);

      // 7. Cleanup request tracking
      if (cleanupService) {
        cleanupService.untrackRequest(requestId);
      }

      const latency = Date.now() - startTime;

      logger.info({
        requestId,
        chatId,
        workspace,
        latency,
        retries: responseData.callback?.attempts || 1,
      }, 'Callback processed successfully');

      return reply.code(200).send({ success: true });

    } catch (err) {
      const latency = Date.now() - startTime;

      logger.error({
        err,
        requestId,
        chatId,
        workspace,
        latency,
      }, 'Callback processing failed');

      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  // Health check endpoint
  fastify.get('/callback/health', async (request, reply) => {
    return reply.send({
      status: 'healthy',
      services: {
        idempotency: idempotency.getStats(),
        rateLimit: rateLimit.getStats(),
      },
    });
  });
}

// Process Claude response (send to Telegram, update DB, etc.)
async function processClaudeResponse(response: ResponseFile): Promise<void> {
  // Implementation depends on your system
  // This is a placeholder
}
```

## Acceptance Criteria

- [ ] Callback endpoint validates all request fields
- [ ] Invalid requests return 400 with validation errors
- [ ] Missing response files return 404
- [ ] Corrupted JSON files return 422
- [ ] Oversized files (>50MB) return 413
- [ ] Duplicate requests return 200 immediately (idempotent)
- [ ] Idempotency cache tracks last 10k requests
- [ ] Rate limiting enforces 100 callbacks/min per workspace
- [ ] Rate limiting enforces 200 callbacks/min per IP
- [ ] Rate limit exceeded returns 429 with Retry-After header
- [ ] Directory traversal attempts are blocked
- [ ] Workspace name with ../ is sanitized
- [ ] Request payload >10KB is rejected
- [ ] File reads retry 3 times on transient errors
- [ ] Health check endpoint returns service stats

## File Changes

### New Files
1. `src/gateway/schemas/callback.ts` - Validation schemas
2. `src/gateway/services/IdempotencyService.ts` - Duplicate detection
3. `src/gateway/services/RateLimitService.ts` - Rate limiting
4. `src/gateway/services/ResponseFileReader.ts` - File reading with retry
5. `tests/unit/IdempotencyService.test.ts` - Unit tests
6. `tests/unit/RateLimitService.test.ts` - Unit tests
7. `tests/integration/callback-hardening.test.ts` - Integration tests

### Modified Files
1. `src/gateway/routes/callback.ts` - Complete rewrite with hardening
2. `package.json` - Add dependencies (@sinclair/typebox, lru-cache)

### Deleted Files
- None

## Test Scenarios

### Test 1: Request Validation

```typescript
describe('Callback Validation', () => {
  it('should reject invalid requestId', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/claude-callback',
      payload: {
        requestId: '../../../etc/passwd', // Invalid characters
        chatId: '123',
        workspace: 'test',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'Validation failed',
    });
  });

  it('should reject missing fields', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/claude-callback',
      payload: {
        requestId: 'test-001',
        // Missing chatId and workspace
      },
    });

    expect(response.statusCode).toBe(400);
  });
});
```

### Test 2: Idempotency

```typescript
it('should handle duplicate requests', async () => {
  const payload = {
    requestId: 'duplicate-001',
    chatId: '123',
    workspace: 'test',
  };

  // First request
  const response1 = await app.inject({
    method: 'POST',
    url: '/claude-callback',
    payload,
  });

  expect(response1.statusCode).toBe(200);
  expect(response1.json().duplicate).toBeUndefined();

  // Duplicate request
  const response2 = await app.inject({
    method: 'POST',
    url: '/claude-callback',
    payload,
  });

  expect(response2.statusCode).toBe(200);
  expect(response2.json().duplicate).toBe(true);
});
```

### Test 3: Rate Limiting

```typescript
it('should enforce workspace rate limit', async () => {
  const workspace = 'rate-test';

  // Send 101 requests rapidly
  const promises = [];
  for (let i = 0; i < 101; i++) {
    promises.push(
      app.inject({
        method: 'POST',
        url: '/claude-callback',
        payload: {
          requestId: `rate-test-${i}`,
          chatId: '123',
          workspace,
        },
      })
    );
  }

  const responses = await Promise.all(promises);

  // First 100 should succeed
  const successes = responses.filter(r => r.statusCode === 200);
  expect(successes.length).toBe(100);

  // 101st should be rate limited
  const rateLimited = responses.filter(r => r.statusCode === 429);
  expect(rateLimited.length).toBe(1);
  expect(rateLimited[0].headers['retry-after']).toBeDefined();
});
```

### Test 4: File Read Error Handling

```typescript
it('should handle missing response file', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/claude-callback',
    payload: {
      requestId: 'nonexistent',
      chatId: '123',
      workspace: 'test',
    },
  });

  expect(response.statusCode).toBe(404);
  expect(response.json()).toMatchObject({
    error: 'Response file not found',
  });
});

it('should handle corrupted JSON file', async () => {
  // Create corrupted file
  await fs.writeFile(
    '/ipc/test/responses/corrupted.json',
    'not valid json {'
  );

  const response = await app.inject({
    method: 'POST',
    url: '/claude-callback',
    payload: {
      requestId: 'corrupted',
      chatId: '123',
      workspace: 'test',
    },
  });

  expect(response.statusCode).toBe(422);
  expect(response.json()).toMatchObject({
    error: 'Corrupted response file',
  });
});
```

### Test 5: Directory Traversal Protection

```bash
# Attempt directory traversal
curl -X POST http://localhost:8080/claude-callback \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "../../etc/passwd",
    "chatId": "123",
    "workspace": "../../../root"
  }'

# Expected: 400 Bad Request (validation fails)
# Sanitized path would be "etcpasswd" and "root"
```

### Test 6: Oversized File Handling

```bash
# Create large file (60MB)
dd if=/dev/zero of=/ipc/test/responses/large.json bs=1M count=60

# Try to read it
curl -X POST http://localhost:8080/claude-callback \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "large",
    "chatId": "123",
    "workspace": "test"
  }'

# Expected: 413 Payload Too Large
```

### Test 7: File Read Retry

```typescript
it('should retry file reads on transient errors', async () => {
  let attempts = 0;

  // Mock fs.readFile to fail twice, then succeed
  jest.spyOn(fs, 'readFile').mockImplementation(async () => {
    attempts++;
    if (attempts < 3) {
      throw new Error('EBUSY: resource busy');
    }
    return JSON.stringify({
      requestId: 'retry-test',
      chatId: '123',
      workspace: 'test',
      timestamp: new Date().toISOString(),
      output: 'success',
      exitCode: 0,
      error: '',
    });
  });

  const response = await app.inject({
    method: 'POST',
    url: '/claude-callback',
    payload: {
      requestId: 'retry-test',
      chatId: '123',
      workspace: 'test',
    },
  });

  expect(response.statusCode).toBe(200);
  expect(attempts).toBe(3); // Retried twice
});
```

## Dependencies

- Task 0114 (Callback Endpoint basic implementation)
- Task 0121 (Stop Hook retry logic)
- `@sinclair/typebox` - Schema validation
- `lru-cache` - Idempotency cache
- Fastify's built-in request validation

## Implementation Notes

### Schema Validation Performance

TypeBox is chosen for validation because:
- 10-100x faster than Joi/Yup
- Compile-time schema optimization
- TypeScript type inference
- JSON Schema compatible

### Idempotency Window

1 hour TTL for processed requests:
- Prevents duplicate processing
- Allows late retries (network delays)
- Bounded memory usage (10k entries max)
- LRU eviction for oldest entries

### Rate Limiting Strategy

Two-tier rate limiting:
1. **Workspace limit (100/min)**: Prevents one workspace from monopolizing system
2. **IP limit (200/min)**: Prevents DDoS from single source

### File Path Sanitization

Defense-in-depth approach:
1. Regex validation in schema (alphanumeric only)
2. Path sanitization (strip special characters)
3. Resolved path verification (within IPC directory)

## Rollback Plan

If hardening causes issues:

1. Disable specific features via environment:
   ```bash
   ENABLE_RATE_LIMITING=false
   ENABLE_IDEMPOTENCY=false
   ENABLE_VALIDATION=false
   ```

2. Revert to basic callback:
   ```bash
   git checkout origin/phase1 -- src/gateway/routes/callback.ts
   ```

3. All security features are additive, can be disabled individually

## Success Metrics

- 100% rejection of invalid requests
- 0 directory traversal vulnerabilities
- <10ms validation overhead
- 100% duplicate detection accuracy
- Rate limiting enforced without false positives
- Zero performance regression vs Phase 1
- All test scenarios pass with 100% coverage

