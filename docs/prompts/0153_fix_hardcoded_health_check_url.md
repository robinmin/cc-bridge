---
wbs: "0153"
title: "Fix Hardcoded Health Check URL"
status: "completed"
priority: "low"
complexity: "trivial"
estimated_hours: 0.5
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

# Fix Hardcoded Health Check URL

## Description

Make gateway URL configurable via environment variable instead of hardcoded value in `src/agent/api/server.ts:541`.

## Requirements

### Functional Requirements

1. Replace hardcoded gateway URL with environment variable
2. Provide default fallback value
3. Update configuration documentation

### Non-Functional Requirements

- Backward compatible (works without env var set)
- Clear documentation

## Design

### Current State

**File**: `src/agent/api/server.ts:541`

```typescript
const gatewayUrl = 'http://host.docker.internal:8080';  // Hardcoded
```

### Solution

**File**: `src/agent/api/server.ts:541`

```typescript
const gatewayUrl = process.env.GATEWAY_URL || 'http://host.docker.internal:8080';
```

**File**: `.env.example`

```bash
# Gateway URL for health checks and callbacks
GATEWAY_URL=http://host.docker.internal:8080
```

**File**: `README.md` (update)

```markdown
## Environment Variables

### Agent Configuration

- `GATEWAY_URL` - URL of the gateway service (default: `http://host.docker.internal:8080`)
  - Used for health checks and callbacks
  - For Docker Desktop: `http://host.docker.internal:8080`
  - For Linux: `http://172.17.0.1:8080`
  - For custom: Use your gateway's actual URL
```

## Acceptance Criteria

- [ ] Gateway URL reads from environment variable
- [ ] Default value used when env var not set
- [ ] Documentation updated
- [ ] All tests pass

## File Changes

### New Files
- None

### Modified Files
1. `src/agent/api/server.ts` - Use environment variable
2. `.env.example` - Add GATEWAY_URL documentation
3. `README.md` - Document configuration option

### Deleted Files
- None

## Test Scenarios

### Test 1: Default Value
```bash
# Without env var
bun run src/agent/index.ts
# Expected: Uses default URL
```

### Test 2: Custom Value
```bash
GATEWAY_URL=http://custom-gateway:9090 bun run src/agent/index.ts
# Expected: Uses custom URL
```

### Test 3: Health Check Uses URL
```typescript
process.env.GATEWAY_URL = 'http://test-gateway:8000';
const server = new AgentHttpServer(config);
assert(server.gatewayUrl === 'http://test-gateway:8000');
```

## Dependencies

- None

## Implementation Notes

- Simple environment variable substitution
- Provide sensible default for Docker
- Document different values for different platforms

## Rollback Plan

Revert to hardcoded value if issues arise.

## Success Metrics

- Gateway URL configurable via environment
- Default behavior unchanged
- Documentation complete
