---
wbs: "0141"
title: "Fix TEST_MODE Security Risk"
status: "completed"
priority: "medium"
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

# Fix TEST_MODE Security Risk

## Description

Rename TEST_MODE to TEST_MODE__INTERNAL_ONLY and add explicit test-only check in `src/agent/utils/path-utils.ts:15-16`. This prevents accidental use of test mode in production.

## Requirements

### Functional Requirements

1. Rename TEST_MODE to TEST_MODE__INTERNAL_ONLY
2. Add explicit check that ensures it's only used in test environment
3. Add warning/error if used in non-test environment

### Non-Functional Requirements

- Clear naming that indicates internal-only use
- Protection against production use

## Design

### Current State

**File**: `src/agent/utils/path-utils.ts:15-16`

```typescript
export const TEST_MODE = false;  // Generic name, could be used accidentally
```

### Solution

**File**: `src/agent/utils/path-utils.ts`

```typescript
/**
 * TEST MODE - INTERNAL USE ONLY
 *
 * This flag is exclusively for testing purposes and should NEVER be enabled
 * in production environments. Enabling this in production may cause:
 * - Security vulnerabilities
 * - Data corruption
 * - Unpredictable behavior
 *
 * @internal
 * @deprecated Only for automated testing
 */
export const TEST_MODE__INTERNAL_ONLY =
  process.env.TEST_MODE__INTERNAL_ONLY === 'true' &&
  process.env.NODE_ENV === 'test';

/**
 * Verify test mode is only used in test environment
 */
if (TEST_MODE__INTERNAL_ONLY && process.env.NODE_ENV !== 'test') {
  throw new Error(
    'TEST_MODE__INTERNAL_ONLY can only be enabled in test environment. ' +
    'Current environment: ' + (process.env.NODE_ENV || 'unknown')
  );
}
```

**File**: `.env.test` (for testing)

```bash
# Only enable in test environment
NODE_ENV=test
TEST_MODE__INTERNAL_ONLY=true
```

**File**: `.env.example` (document the danger)

```bash
# ⚠️ DANGER: NEVER SET THIS IN PRODUCTION ⚠️
# TEST_MODE__INTERNAL_ONLY enables testing shortcuts that bypass safety checks.
# Setting this in production will cause security vulnerabilities and data loss.
# NODE_ENV must be 'test' for this to have any effect.
# TEST_MODE__INTERNAL_ONLY=true
```

## Acceptance Criteria

- [ ] Constant renamed to TEST_MODE__INTERNAL_ONLY
- [ ] Check added to ensure NODE_ENV is 'test'
- [ ] Error thrown if used in non-test environment
- [ ] JSDoc warning added about dangers
- [ ] .env.example documents the risk
- [ ] All tests pass

## File Changes

### New Files
- None

### Modified Files
1. `src/agent/utils/path-utils.ts` - Rename constant, add safety check
2. `.env.example` - Add warning documentation
3. Any files using TEST_MODE - Update to use new name

### Deleted Files
- None

## Test Scenarios

### Test 1: Test Environment Works
```bash
NODE_ENV=test TEST_MODE__INTERNAL_ONLY=true bun test
# Expected: Test mode enabled, no errors
```

### Test 2: Production Environment Fails
```bash
NODE_ENV=production TEST_MODE__INTERNAL_ONLY=true bun run src/agent/index.ts
# Expected: Error thrown
```

### Test 3: Development Environment Fails
```bash
NODE_ENV=development TEST_MODE__INTERNAL_ONLY=true bun run src/agent/index.ts
# Expected: Error thrown
```

### Test 4: Default is Safe
```bash
# Without env var
NODE_ENV=test bun run src/agent/index.ts
# Expected: Test mode disabled, no errors
```

## Dependencies

- Any code using TEST_MODE constant

## Implementation Notes

- Use __INTERNAL_ONLY suffix to indicate restriction
- Double-check with NODE_ENV to prevent production use
- Throw error to prevent silent failures
- Document clearly in code and env files
- Search codebase for all usages of TEST_MODE

## Rollback Plan

If new name causes issues:
1. Keep both names during transition (alias old to new)
2. Add deprecation warning for old name
3. Migrate all usages over time

## Success Metrics

- Test mode only enabled in test environment
- Production use results in error
- Clear documentation of risks
- All tests pass
