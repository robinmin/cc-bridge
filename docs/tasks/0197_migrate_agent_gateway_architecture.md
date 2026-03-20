# Task 0197: Migrate Agent Package to Remove Gateway Dependencies

## Status

- **Created**: 2026-03-19
- **Status**: ✅ Completed
- **Priority**: High
- **Principle**: `src/packages/agent/` must NOT depend on `src/gateway/`

## Summary

Moved entire `src/gateway/memory/` to `src/packages/agent/memory/`

## Migration Steps Completed

1. ✅ Moved `src/gateway/memory/` → `src/packages/agent/memory/`
2. ✅ Updated 22 files to use new import path `@/packages/agent/memory/`
3. ✅ `src/packages/` has **zero** imports from `@/gateway/`

## New Structure

```
src/packages/agent/
├── core/           # embedded-agent, workspace, rag-*, etc.
├── memory/         # FULL memory system (moved from gateway)
│   ├── indexer/    # FTS5, vector, hybrid search
│   ├── compaction/ # Session summarization
│   ├── backend-*   # Storage implementations
│   ├── bank.ts     # Structured knowledge
│   ├── daily-log.ts # Time-based memory
│   └── ...
├── tools/          # bash, read/write, sandbox, permission, visibility
└── index.ts

src/gateway/       # HTTP server, routes, channels, pipeline, services
```

## Verification

- [x] `src/packages/agent/` has **ZERO** imports from `@/gateway/`
- [x] All 2054 tests pass
- [x] No breaking changes

## Files Updated (22 files)

All files that imported from `@/gateway/memory/` now use `@/packages/agent/memory/`
