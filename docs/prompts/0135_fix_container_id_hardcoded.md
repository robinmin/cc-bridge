---
wbs: "0135"
title: "Fix Container ID Hardcoded in Agent HTTP Mode"
status: "completed"
priority: "high"
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

# Fix Container ID Hardcoded in Agent HTTP Mode

## Description

Replace hardcoded container ID `"claude-agent"` in `src/agent/index.ts:26` with an environment variable for flexibility across different deployment environments.

## Requirements

### Functional Requirements

1. Use environment variable for containerId instead of hardcoded value
2. Provide default fallback value
3. Update documentation to reflect new configuration option

### Non-Functional Requirements

- Backward compatible (works without env var set)
- Clear documentation for new environment variable

## Design

### Current State

**File**: `src/agent/index.ts:26`

```typescript
const containerId = "claude-agent";  // Hardcoded
```

### Solution

**File**: `src/agent/index.ts:26`

```typescript
const containerId = process.env.AGENT_CONTAINER_ID || "claude-agent";
```

**File**: `.env.example` (add)

```bash
# Agent container identification
AGENT_CONTAINER_ID=claude-agent
```

**File**: `README.md` (update documentation)

```markdown
## Environment Variables

### Agent Configuration

- `AGENT_CONTAINER_ID` - Container identifier for the agent (default: "claude-agent")
```

## Acceptance Criteria

- [ ] Container ID reads from environment variable
- [ ] Default value "claude-agent" used when env var not set
- [ ] Documentation updated with new environment variable
- [ ] All tests pass with default and custom values

## File Changes

### New Files
- None

### Modified Files
1. `src/agent/index.ts` - Use environment variable for containerId
2. `.env.example` - Add AGENT_CONTAINER_ID documentation
3. `README.md` - Document new environment variable

### Deleted Files
- None

## Test Scenarios

### Test 1: Default Value
```bash
# Without env var
bun run src/agent/index.ts
# Expected: Uses "claude-agent"
```

### Test 2: Custom Value
```bash
AGENT_CONTAINER_ID=my-custom-agent bun run src/agent/index.ts
# Expected: Uses "my-custom-agent"
```

### Test 3: Integration Test
```typescript
process.env.AGENT_CONTAINER_ID = 'test-container';
const agent = createAgent();
assert(agent.containerId === 'test-container');
```

## Dependencies

- None

## Implementation Notes

- Simple environment variable substitution
- Provide sensible default
- Document in README and .env.example

## Rollback Plan

Revert to hardcoded value if issues arise.

## Success Metrics

- Container ID configurable via environment
- Default behavior unchanged
- Documentation complete
