---
wbs: "0143"
title: "Fix Inconsistent Error Status Code Casting"
status: "completed"
priority: "medium"
complexity: "simple"
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

# Fix Inconsistent Error Status Code Casting

## Description

Ensure consistent error handling patterns across all routes in `src/agent/routes/execute.ts:96`. Inconsistent error status code casting can lead to incorrect HTTP responses.

## Requirements

### Functional Requirements

1. Standardize error status code mapping
2. Ensure consistent error response format
3. Handle all error types appropriately
4. Document error handling patterns

### Non-Functional Requirements

- Predictable error responses
- Consistent HTTP status codes
- Clear error messages

## Design

### Current State Analysis

**File**: `src/agent/routes/execute.ts:96`

Potential inconsistency:
```typescript
// Inconsistent error status code handling
reply.code(err.statusCode || 500).send({ error: err.message });
```

### Solution Design

**File**: `src/shared/errors.ts` (new)

```typescript
/**
 * Standard error codes for HTTP responses
 */
export enum ErrorCode {
  // Client errors (4xx)
  BAD_REQUEST = 400,
  UNAUTHORIZED = 401,
  FORBIDDEN = 403,
  NOT_FOUND = 404,
  CONFLICT = 409,
  UNPROCESSABLE_ENTITY = 422,
  TOO_MANY_REQUESTS = 429,

  // Server errors (5xx)
  INTERNAL_SERVER_ERROR = 500,
  NOT_IMPLEMENTED = 501,
  BAD_GATEWAY = 502,
  SERVICE_UNAVAILABLE = 503,
  GATEWAY_TIMEOUT = 504,
}

/**
 * Get appropriate HTTP status code for error
 */
export function getStatusCode(error: unknown): ErrorCode {
  if (error instanceof HTTPError) {
    return error.statusCode as ErrorCode;
  }

  if (error instanceof ValidationError) {
    return ErrorCode.UNPROCESSABLE_ENTITY;
  }

  if (error instanceof AuthError) {
    return ErrorCode.UNAUTHORIZED;
  }

  if (error instanceof NotFoundError) {
    return ErrorCode.NOT_FOUND;
  }

  // Default to internal server error
  return ErrorCode.INTERNAL_SERVER_ERROR;
}

/**
 * Standard error response format
 */
export interface ErrorResponse {
  error: string;
  code?: string;
  details?: unknown;
  requestId?: string;
}

/**
 * Create standard error response
 */
export function createErrorResponse(
  error: unknown,
  requestId?: string
): ErrorResponse {
  const message = error instanceof Error ? error.message : 'Unknown error';
  const code = error instanceof Error ? error.name : 'UNKNOWN_ERROR';

  return {
    error: message,
    code,
    requestId,
  };
}
```

**File**: `src/agent/routes/execute.ts`

```typescript
import { ErrorCode, getStatusCode, createErrorResponse } from '../shared/errors';

// In route handler
try {
  // ... route logic ...
} catch (error) {
  const statusCode = getStatusCode(error);
  const response = createErrorResponse(error, requestId);

  reply.code(statusCode).send(response);
  return;
}
```

**File**: `src/shared/errors.ts` (custom error classes)

```typescript
/**
 * Base HTTP error class
 */
export class HTTPError extends Error {
  constructor(
    message: string,
    public statusCode: ErrorCode = ErrorCode.INTERNAL_SERVER_ERROR
  ) {
    super(message);
    this.name = 'HTTPError';
  }
}

/**
 * Validation error (400/422)
 */
export class ValidationError extends HTTPError {
  constructor(message: string, public details?: unknown) {
    super(message, ErrorCode.BAD_REQUEST);
    this.name = 'ValidationError';
  }
}

/**
 * Not found error (404)
 */
export class NotFoundError extends HTTPError {
  constructor(resource: string) {
    super(`${resource} not found`, ErrorCode.NOT_FOUND);
    this.name = 'NotFoundError';
  }
}

/**
 * Unauthorized error (401)
 */
export class AuthError extends HTTPError {
  constructor(message: string = 'Unauthorized') {
    super(message, ErrorCode.UNAUTHORIZED);
    this.name = 'AuthError';
  }
}

/**
 * Conflict error (409)
 */
export class ConflictError extends HTTPError {
  constructor(message: string) {
    super(message, ErrorCode.CONFLICT);
    this.name = 'ConflictError';
  }
}
```

## Acceptance Criteria

- [ ] Standardized error handling utilities created
- [ ] All routes use consistent error handling
- [ ] Error status codes are type-safe (enum)
- [ ] Error response format is consistent
- [ ] Custom error classes for common scenarios
- [ ] All tests pass

## File Changes

### New Files
1. `src/shared/errors.ts` - Error handling utilities
2. `src/agent/tests/error-handling.test.ts` - Error handling tests

### Modified Files
1. `src/agent/routes/execute.ts` - Use standardized error handling
2. `src/agent/routes/*.ts` - Update all route handlers for consistency
3. `src/gateway/routes/*.ts` - Update for consistency

### Deleted Files
- None

## Test Scenarios

### Test 1: Error Status Code Consistency
```typescript
import { getStatusCode, ValidationError, NotFoundError } from './errors';

assert(getStatusCode(new ValidationError('test')) === 400);
assert(getStatusCode(new NotFoundError('resource')) === 404);
assert(getStatusCode(new Error('unknown')) === 500);
```

### Test 2: Error Response Format
```typescript
const response = createErrorResponse(
  new ValidationError('Invalid input'),
  'req-123'
);

assert(response.error === 'Invalid input');
assert(response.code === 'ValidationError');
assert(response.requestId === 'req-123');
```

### Test 3: Route Error Handling
```typescript
// Test that routes return consistent error format
const response = await app.inject({
  method: 'POST',
  url: '/execute',
  body: { invalid: 'data' },
});

assert(response.statusCode === 400);
assert(response.json().error !== undefined);
assert(response.json().code !== undefined);
```

### Test 4: Custom Error Classes
```typescript
import { ConflictError, AuthError } from './errors';

const conflict = new ConflictError('Resource already exists');
assert(conflict.statusCode === 409);

const auth = new AuthError('Invalid token');
assert(auth.statusCode === 401);
```

## Dependencies

- All route files that handle errors

## Implementation Notes

- Create central error handling module
- Use enum for type-safe status codes
- Provide helper functions for common operations
- Document error handling patterns
- Update all routes to use new utilities
- Consider adding error logging middleware

## Rollback Plan

If new error handling causes issues:
1. Keep existing error handling as fallback
2. Gradually migrate routes
3. Add feature flag for new error handling

## Success Metrics

- All routes use consistent error handling
- Status codes are type-safe
- Error response format is consistent
- Zero unhandled errors in logs
