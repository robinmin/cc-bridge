---
wbs: "0151"
title: "Fix Inconsistent Import Ordering"
status: "completed"
priority: "low"
complexity: "low"
estimated_hours: 1
phase: "post-review-fixes"
dependencies: []
created: 2026-02-07
completed: 2026-02-07
impl_progress:
  planning: completed
  design: completed
  implementation: completed
  review: completed
  testing: completed
---

# Fix Inconsistent Import Ordering

## Description

Standardize import statement ordering across all TypeScript files using Biome's built-in import sorting. Currently files use inconsistent import ordering patterns (grouped by type vs alphabetical vs mixed).

## Requirements

### Functional Requirements

1. **Enable Biome Import Sorting**
   - Configure Biome to automatically sort imports
   - Use "standard" sorting kind (node.js builtins, external, internal)
   - Enable case-insensitive alphabetical ordering within groups

2. **Apply Import Sorting to All Files**
   - Run Biome formatter to fix existing files
   - Ensure no functional changes (only import reordering)

3. **Verify No Breaking Changes**
   - Run all tests after import sorting
   - Ensure no circular dependency issues introduced

### Non-Functional Requirements

- Zero functional code changes
- All tests must pass after import sorting
- No new dependencies added

## Design

### Biome Configuration

Update `biome.json` to enable import sorting:

```json
{
  "linter": {
    "rules": {
      "style": {
        "useImportSort": "error"
      }
    }
  },
  "javascript": {
    "formatter": {
      "importSorting": {
        "kind": "standard"
      }
    }
  }
}
```

### Import Order Pattern

Using "standard" kind, imports will be ordered as:
1. Node.js built-ins (`fs`, `path`, etc.)
2. External packages (`hono`, `zod`, etc.)
3. Internal imports (`@/` aliases)
4. Parent directory imports
5. Sibling directory imports
6. Same-directory imports

Within each group: alphabetically, case-insensitive.

## Acceptance Criteria

- [ ] Biome configuration updated with import sorting enabled
- [ ] `bun run lint` passes without import sorting errors
- [ ] All TypeScript files have consistent import ordering
- [ ] All tests pass after reordering
- [ ] No circular dependency errors

## File Changes

### Modified Files
1. `biome.json` - Add import sorting configuration

### Potentially Modified Files
- All `src/**/*.ts` files (import statements reordered only)

## Test Scenarios

### Test 1: Verify Lint Passes
```bash
bun run lint
# Expected: No errors, no import sorting warnings
```

### Test 2: Verify Formatter Passes
```bash
bun run format
# Expected: No errors, imports sorted correctly
```

### Test 3: Verify Tests Pass
```bash
bun test src
# Expected: All tests pass, no circular dependency errors
```

## Implementation Steps

1. **Update Biome Configuration**
   - Add `useImportSort` rule to linter
   - Enable `importSorting` in formatter

2. **Apply Import Sorting**
   - Run `bun run check` to auto-fix all files
   - Verify changes are import reordering only

3. **Verify Tests Pass**
   - Run full test suite
   - Fix any circular dependencies if discovered

4. **Update Task Status**
   - Mark task as completed
   - Commit changes with message "fix: standardize import ordering with biome"

## Dependencies

None

## Success Metrics

- Zero lint errors related to imports
- All tests passing
- Consistent import order across all TypeScript files
