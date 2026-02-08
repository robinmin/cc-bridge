---
wbs: "0133"
title: "Fix Wrong Parameter Passing to executeClaude"
status: "completed"
priority: "critical"
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

# Fix Wrong Parameter Passing to executeClaude

## Description

Fix incorrect function call in `src/gateway/services/claude-executor.ts:441`. The `executeClaude` function expects separate `containerId` and `instanceName` string parameters, but the call passes an object `{ containerId, name }`.

## Requirements

### Functional Requirements

1. Fix function call to pass parameters correctly
2. Ensure parameters are passed as separate strings, not as object
3. Verify all calls to executeClaude follow correct signature

### Non-Functional Requirements

- No breaking changes to function signature
- All existing functionality preserved

## Design

### Current State

**File**: `src/gateway/services/claude-executor.ts:441`

```typescript
// WRONG - passes object
await executeClaude({ containerId, name });
```

### Function Signature

```typescript
async function executeClaude(
  containerId: string,
  instanceName: string,
  options?: ExecuteOptions
): Promise<ClaudeResponse>
```

### Solution

**File**: `src/gateway/services/claude-executor.ts:441`

```typescript
// CORRECT - passes separate parameters
await executeClaude(containerId, name);
```

## Acceptance Criteria

- [ ] Function call passes parameters correctly as separate strings
- [ ] TypeScript compilation succeeds
- [ ] Runtime execution succeeds without errors
- [ ] All tests pass
- [ ] No other instances of incorrect parameter passing exist

## File Changes

### New Files
- None

### Modified Files
1. `src/gateway/services/claude-executor.ts` - Fix function call on line 441

### Deleted Files
- None

## Test Scenarios

### Test 1: TypeScript Compilation
```bash
bun run build
# Expected: No type errors
```

### Test 2: Runtime Execution
```bash
bun test src/gateway/tests/claude-executor.test.ts
# Expected: All tests pass, no runtime errors
```

### Test 3: Manual Verification
```typescript
// Verify correct call signature
const result = await executeClaude('container-123', 'instance-name', options);
assert(result !== undefined);
```

## Dependencies

- None

## Implementation Notes

- Simple parameter fix
- Verify there are no other calls with same issue
- Consider adding TypeScript ESLint rule to catch this pattern

## Rollback Plan

Revert the single line change if issues arise.

## Success Metrics

- TypeScript compilation succeeds
- All tests pass
- No runtime errors from incorrect parameter passing
