# Task 0196 Implementation: Selective Hybrid RAG Pipeline

## Summary

Implementation of a **Selective Hybrid RAG Pipeline** that retrieves relevant documents from the memory index on every prompt and selectively injects them into the agent's system prompt when relevance exceeds a configurable threshold.

## Overview

| Property | Value |
|----------|-------|
| **Task** | 0196 - Selective Hybrid RAG Pipeline |
| **Phase** | Implementation |
| **Priority** | High (Section 14 of EmbeddedAgent Spec) |
| **Confidence** | HIGH - All foundational components (0188, 0189, 0195) are complete |
| **Methodology** | super-coder with TDD |

---

## 1. Implementation Order and Dependencies

The following order respects natural dependencies between steps:

```
0196.1 (Config) 
    -> 0196.2 (Cache) 
        -> 0196.3 (Formatter) 
            -> 0196.4 (Retrieval Method) 
                -> 0196.5 (Integration into prompt)
                    -> 0196.6 (Indexer Wiring)
                        -> 0196.7 (Engine Wiring)
                            -> 0196.9 (Observability)
                                -> 0196.8 (Tests)
```

**Critical Path**: Steps 0196.1-0196.5 form the core RAG logic. Steps 0196.6-0196.7 wire the MemoryIndexer into the system. Tests and observability can be added after core logic is complete.

---

## 2. Step-by-Step Implementation Plan

### 2.1 Step 0196.1: Add RAG Config Types

**File**: `src/packages/agent/core/embedded-agent.ts`

**Sub-tasks**:
1. Add `RagConfig` interface to the file
2. Add `rag?: RagConfig` optional field to `EmbeddedAgentConfig`
3. Add `ragCache: RagContextCache` private field to `EmbeddedAgent` class
4. Initialize `ragCache` in constructor
5. Add `ragEnabled`, `ragThreshold`, `ragMaxResults`, `ragMode` private fields with defaults from config

**Acceptance Criteria**:
- `RagConfig` interface has: `enabled?: boolean`, `threshold?: number`, `maxResults?: number`, `mode?: "keyword" | "vector" | "hybrid"`
- `EmbeddedAgentConfig` accepts optional `rag?: RagConfig`
- Default values: `enabled=true`, `threshold=0.3`, `maxResults=5`, `mode="hybrid"`
- TypeScript compiles without errors

**Dependencies**: None (prerequisite for all other steps)

---

### 2.2 Step 0196.2: Create RAG Cache

**File**: `src/packages/agent/core/rag-cache.ts` (NEW)

**Sub-tasks**:
1. Create `CacheEntry` interface with `context: string` and `timestamp: number`
2. Create `RagContextCache` class with internal `Map<string, CacheEntry>`
3. Implement `get(query: string): string | undefined` - cache lookup with eviction check
4. Implement `set(query: string, context: string): void` - cache store with current timestamp
5. Implement `evictOlderThan(maxAgeMs: number): void` - cleanup expired entries
6. Implement `clear(): void` - full cache clear
7. Add private helper `normalizeQuery(query: string): string` for consistent cache keys

**Acceptance Criteria**:
- Cache stores and retrieves formatted RAG context strings
- Entries older than 5 minutes are evicted on `get()` (lazy eviction)
- `clear()` empties the cache
- `normalizeQuery()` produces consistent keys (lowercase, trimmed)
- Thread-safe for single-threaded Node.js use

**Implementation Notes**:
- Use `Date.now()` for timestamps
- Eviction is lazy (on access) to avoid blocking `get()` calls
- Consider using a `Set` for tracking keys with timestamps to avoid Map iteration on eviction

**Dependencies**: None (standalone module)

---

### 2.3 Step 0196.3: Create RAG Context Formatter

**File**: `src/packages/agent/core/rag-context.ts` (NEW)

**Sub-tasks**:
1. Import `SearchResult` type from `@/gateway/memory/types`
2. Implement `formatRagContext(results: SearchResult[]): string`:
   - Return empty string if results array is empty
   - Wrap results in `<rag-context>\n## Retrieved Context\n\n` header
   - Format each result as blockquote: `> [{path}]\n> {snippet}`
   - Close with `</rag-context>`
3. Implement `buildRagPrompt(query: string, results: SearchResult[]): string`:
   - Call `formatRagContext(results)`
   - Return combined prompt string

**Acceptance Criteria**:
- Output matches the specified format exactly:
  ```
  <rag-context>
  ## Retrieved Context
  
  > [path/to/memory.md]
  > Snippet text here...
  
  > [path/to/daily/2026-03-18.md]
  > Another snippet...
  </rag-context>
  ```
- Empty results return empty string (not the wrapper tags)
- `buildRagPrompt()` is the public API used by `retrieveRagContext()`

**Dependencies**: None (standalone module)

---

### 2.4 Step 0196.4: Add retrieveRagContext() Method

**File**: `src/packages/agent/core/embedded-agent.ts`

**Sub-tasks**:
1. Add `retrieveRagContext(message: string): Promise<string | undefined>` method
2. Check if `rag.enabled === false` - return undefined immediately
3. Check if `memoryIndexer` is null/unavailable - log warning and return undefined
4. Compute normalized cache key from message
5. Check cache for existing entry - if valid (not expired), return cached context
6. Call `memoryIndexer.search(message, { mode: rag.mode, limit: rag.maxResults })`
7. Filter results by threshold (score >= rag.threshold)
8. If no results above threshold, return undefined
9. Format results using `buildRagPrompt()`
10. Store in cache with current timestamp
11. Return formatted context

**Acceptance Criteria**:
- Method returns `string | undefined` (never throws)
- Cache hit returns immediately without search
- Below-threshold results are filtered out
- Empty results return `undefined`
- All error cases log and return `undefined` (graceful degradation)

**Dependencies**: 0196.1, 0196.2, 0196.3

---

### 2.5 Step 0196.5: Integrate RAG into prompt() Method

**File**: `src/packages/agent/core/embedded-agent.ts`

**Sub-tasks**:
1. In `prompt()` method, after initialization check and before `agent.prompt()` call:
   - Call `retrieveRagContext(message)` and capture result
2. If RAG context is returned:
   - Save original system prompt (or store reference to restore)
   - Prepend RAG context to system prompt
   - Call `agent.setSystemPrompt(effectiveSystemPrompt)`
3. After `agent.prompt()` completes (in finally block):
   - Restore original system prompt via `agent.setSystemPrompt(this.systemPrompt)`
4. The RAG context is NOT stored in `this.systemPrompt` - it's a per-prompt overlay

**Acceptance Criteria**:
- RAG context is prepended to system prompt before each `agent.prompt()` call
- Original system prompt is always restored after `agent.prompt()` completes
- Works correctly with concurrent prompt() calls (this is already guarded)
- The RAG context is computed once per `prompt()` call, not per turn

**Dependencies**: 0196.4

**Edge Cases**:
- If `setSystemPrompt()` is called by another part of the code during `prompt()`, the restore will overwrite it. This is acceptable as the RAG overlay should dominate for that call.
- The workspace hot reload mechanism (`this.watcher`) should continue to work independently.

---

### 2.6 Step 0196.6: Wire MemoryIndexer into EmbeddedAgent

**Files**: 
- `src/packages/agent/core/embedded-agent.ts`
- `src/packages/agent/core/index.ts` (exports)

**Sub-tasks**:
1. Add `memoryIndexer?: MemoryIndexer` field to `EmbeddedAgentConfig`
2. Add `private memoryIndexer: MemoryIndexer | null` field to `EmbeddedAgent`
3. Store indexer reference in constructor from config
4. Export `RagConfig`, `RagContextCache`, `formatRagContext`, `buildRagPrompt` from appropriate modules

**Acceptance Criteria**:
- `EmbeddedAgentConfig` accepts optional `memoryIndexer?: MemoryIndexer`
- Indexer is stored but NOT initialized by EmbeddedAgent (initialization happens at gateway level)
- `retrieveRagContext()` handles null/undefined indexer gracefully

**Dependencies**: 0196.4

---

### 2.7 Step 0196.7: Update InProcessEngine and AgentSessionManager

**Files**:
- `src/gateway/engine/in-process.ts`
- `src/gateway/engine/agent-sessions.ts`

**Sub-tasks**:

**In InProcessEngine**:
1. Accept `memoryIndexer: MemoryIndexer` as constructor parameter or via config
2. Pass `memoryIndexer` to `EmbeddedAgentConfig` when creating agent
3. Handle case where `memoryIndexer` is not available (log warning, continue without RAG)

**In AgentSessionManager**:
1. Update `AgentSessionManagerConfig` to accept `memoryIndexer?: MemoryIndexer`
2. Store indexer reference
3. Pass to `getOrCreate()` when building `EmbeddedAgentConfig`
4. If indexer is null, `EmbeddedAgentConfig.memoryIndexer` is undefined (graceful degradation)

**Acceptance Criteria**:
- MemoryIndexer is passed through the config chain: InProcessEngine -> AgentSessionManager -> EmbeddedAgent
- If indexer is not available, RAG is silently disabled (no errors)
- All existing functionality (workspace bootstrap, tools, etc.) continues to work

**Dependencies**: 0196.6

---

### 2.8 Step 0196.9: Add RAG Observability

**File**: `src/packages/agent/core/embedded-agent.ts` (modify prompt() method)

**Sub-tasks**:
1. Add RAG-related fields to `AgentRunObservability` interface in observability.ts:
   - `ragResultsCount?: number`
   - `ragCacheHit?: boolean`
   - `ragThreshold?: number`
   - `ragRetrievalDurationMs?: number`
2. In `prompt()`, collect RAG stats:
   - Start timer before `retrieveRagContext()`
   - Record results count, cache hit/miss, threshold used
   - Add to observability run after completion
3. Log RAG retrieval stats at debug/info level:
   - `rag retrieval: {cacheHit: bool, resultsCount: N, threshold: 0.3, durationMs: N}`

**Acceptance Criteria**:
- RAG retrieval stats appear in observability snapshots
- Stats are included in the run's observability data
- Logging is consistent with existing logger pattern

**Dependencies**: 0196.5

---

### 2.9 Step 0196.8: Add RAG Pipeline Tests

**File**: `src/packages/agent/core/rag.test.ts` (NEW)

**Sub-tasks**:

**Unit Tests - rag-cache.ts**:
1. Test `RagContextCache.get()` returns undefined for empty cache
2. Test `RagContextCache.set()` followed by `get()` returns the context
3. Test `evictOlderThan()` removes stale entries
4. Test `clear()` empties the cache
5. Test `normalizeQuery()` produces consistent keys

**Unit Tests - rag-context.ts**:
1. Test `formatRagContext([])` returns empty string
2. Test `formatRagContext([singleResult])` formats correctly
3. Test `formatRagContext([multipleResults])` formats all results
4. Test `buildRagPrompt()` combines query and results
5. Test that output matches exact format specification

**Integration Tests - embedded-agent.ts modifications**:
1. Test `retrieveRagContext()` returns undefined when indexer unavailable
2. Test `retrieveRagContext()` returns undefined when RAG disabled
3. Test threshold filtering - results below threshold are not included
4. Test cache hit returns cached result without search
5. Test cache miss triggers search and stores result
6. Test graceful degradation when `search()` throws

**Acceptance Criteria**:
- All unit tests pass
- Tests mock `MemoryIndexer` (do not use real indexer)
- Tests verify exact output format
- Cache eviction is tested with fake timers or real short timeouts

**Dependencies**: 0196.1-0196.7

---

## 3. Cross-Cutting Concerns

### 3.1 Error Handling

| Scenario | Handling |
|----------|----------|
| MemoryIndexer is null | Log `warn("RAG index not available, skipping retrieval")`, return undefined |
| `search()` throws | Log `warn("RAG search failed: {error}")`, return undefined |
| `search()` returns empty array | Treat as below threshold, return undefined |
| Cache entry expired | Evict and return undefined (cache miss) |
| Concurrent prompts | Already guarded by `promptRunning` flag |

**Design Principle**: RAG is best-effort enhancement. Do NOT throw, do NOT fail the prompt.

### 3.2 TypeScript Typing

**Key Types**:
```typescript
interface RagConfig {
  enabled?: boolean;       // default: true
  threshold?: number;      // default: 0.3, range: 0-1
  maxResults?: number;     // default: 5
  mode?: "keyword" | "vector" | "hybrid"; // default: "hybrid"
}

interface RagContextCache {
  get(query: string): string | undefined;
  set(query: string, context: string): void;
  evictOlderThan(maxAgeMs: number): void;
  clear(): void;
}
```

**Import Strategy**:
- `SearchResult` from `@/gateway/memory/types`
- `MemoryIndexer` from `@/gateway/memory/indexer/indexer`
- `logger` from `@/packages/logger`

### 3.3 Observability Integration

RAG observability should be additive to existing observability:
- Add RAG stats to the existing `AgentRunObservability` interface
- Log at `debug` level for cache hits (low volume)
- Log at `info` level for cache misses with results (informational)
- Include in observability snapshot for monitoring dashboards

---

## 4. Potential Failure Points and Mitigations

### 4.1 MemoryIndexer Not Wired

**Risk**: If `memoryIndexer` is not passed through the config chain, RAG silently does nothing.

**Mitigation**: 
- Log a debug message when RAG is skipped due to missing indexer
- The task spec explicitly requires steps 0196.6 and 0196.7 to wire this

### 4.2 Slow Index Search

**Risk**: If `memoryIndexer.search()` is slow (large index, network issues), it blocks the prompt response.

**Mitigation**:
- Consider adding a timeout wrapper (5 second max) around `search()`
- Log warning if search takes longer than 2 seconds
- RAG is best-effort - a slow search should not block the prompt indefinitely

**RESOLVED**: 5 second timeout with warning log. Timeout is implemented as a Promise.race() wrapper around `memoryIndexer.search()`.

### 4.3 Threshold Tuning

**Risk**: Default threshold 0.3 may be too strict or too loose for different use cases.

**Mitigation**:
- All threshold values are configurable via `RagConfig`
- Log the threshold used and number of results returned for debugging
- Consider adding to observability data to help tune thresholds

### 4.4 Cache Memory Growth

**Risk**: If many unique queries are made, the cache Map could grow unbounded.

**Mitigation**:
- 5-minute eviction on access keeps cache bounded
- Session-scoped (cleared on `dispose()`)
- Consider adding max cache size limit if memory becomes a concern

### 4.5 System Prompt Size

**Risk**: If RAG retrieves many high-scoring results, the system prompt could become very large.

**Mitigation**:
- `maxResults` default is 5 (reasonable limit)
- LLM context window should handle this
- Consider warning if combined prompt exceeds context window (observability)

---

## 5. Testing Strategy

### 5.1 Test Types

| Test Type | Scope | Mock/Real |
|-----------|-------|-----------|
| Unit - Cache | `rag-cache.ts` | Real (no dependencies) |
| Unit - Formatter | `rag-context.ts` | Real (no dependencies) |
| Unit - Retrieval | `embedded-agent.ts` | Mock `MemoryIndexer` |
| Integration | Full RAG flow | Mock `MemoryIndexer`, Real `EmbeddedAgent` |

### 5.2 What to Mock

**Mock `MemoryIndexer`**:
```typescript
const mockIndexer = {
  search: vi.fn().mockResolvedValue([
    { id: 1, path: "test.md", snippet: "test content", source: { type: "memory" } }
  ]),
  isInitialized: vi.fn().mockReturnValue(true),
} as unknown as MemoryIndexer;
```

**Mock `search()` behavior**:
- Return empty array (no results)
- Return array below threshold
- Return array above threshold
- Throw error (degradation test)

### 5.3 Test File Structure

```
src/packages/agent/core/
  rag-cache.ts       # Implementation
  rag-context.ts     # Implementation
  rag.test.ts        # Unit + integration tests
```

---

## 6. Gaps and Clarifications Needed

### 6.1 Questions for User

1. **Timeout for search()**: Should there be a hard timeout (e.g., 5 seconds) on `memoryIndexer.search()`? If it times out, should we skip RAG silently or log a warning?

2. **Score source**: **RESOLVED - Option A**. Modify `HybridSearchManager` to add `score?: number` to `SearchResult` and populate it in `mergeResults()`. The combined score is already calculated internally.

3. **Cache key normalization**: **RESOLVED - Similar queries**. Implement query normalization in `rag-cache.ts` that collapses common variations (lowercase, trim, remove excess whitespace, optionally remove stop words).

4. **Observability granularity**: Should RAG stats be per-call or aggregated in the session snapshot? Currently designed as per-call with session totals.

### 6.2 Spec Ambiguities

1. **Score threshold not in SearchResult**: The `hybrid.ts` `mergeResults()` method calculates scores but does not expose them. The `SearchResult` type only has `id`, `path`, `snippet`, `source`. Need to clarify if we should add a `score?: number` field.

2. **Vector search fallback**: The spec says "fall back to `mode: "keyword"` if vector search is unavailable". This should happen automatically if `HybridSearchManager.vectorEnabled === false`, but we need to ensure `MemoryIndexer.search()` propagates this correctly.

3. **Workspace bootstrap vs RAG context**: The spec says RAG is "separate from workspace bootstrap" but doesn't specify what happens if both are enabled and both have content. The design prepends RAG to system prompt, then system prompt is set. This seems correct.

---

## 7. Implementation Checklist

### Pre-Implementation
- [ ] Clarify: timeout for search()
- [ ] Clarify: score threshold availability in SearchResult
- [ ] Review: RAG config interface design

### Step 0196.1 - Config
- [ ] Add `RagConfig` interface
- [ ] Add `rag?: RagConfig` to `EmbeddedAgentConfig`
- [ ] Initialize `ragCache` in constructor

### Step 0196.2 - Cache
- [ ] Create `rag-cache.ts`
- [ ] Implement `RagContextCache` class
- [ ] Write unit tests for cache

### Step 0196.3 - Formatter
- [ ] Create `rag-context.ts`
- [ ] Implement `formatRagContext()`
- [ ] Implement `buildRagPrompt()`
- [ ] Write unit tests for formatter

### Step 0196.4 - Retrieval Method
- [ ] Add `retrieveRagContext()` method
- [ ] Integrate cache check/store
- [ ] Add threshold filtering
- [ ] Test graceful degradation

### Step 0196.5 - Integration
- [ ] Modify `prompt()` to call `retrieveRagContext()`
- [ ] Prepend RAG context to system prompt
- [ ] Restore system prompt in finally block

### Step 0196.6 - Indexer Wiring
- [ ] Add `memoryIndexer` to `EmbeddedAgentConfig`
- [ ] Store indexer reference in `EmbeddedAgent`
- [ ] Handle null indexer gracefully

### Step 0196.7 - Engine Wiring
- [ ] Update `InProcessEngine` to pass indexer
- [ ] Update `AgentSessionManager` to pass indexer
- [ ] Verify end-to-end flow

### Step 0196.9 - Observability
- [ ] Add RAG stats to `AgentRunObservability`
- [ ] Log RAG retrieval stats
- [ ] Include in observability snapshot

### Step 0196.8 - Tests
- [ ] Write cache unit tests
- [ ] Write formatter unit tests
- [ ] Write integration tests
- [ ] All tests pass

### Post-Implementation
- [ ] TypeScript compiles without errors
- [ ] Manual verification with real indexer
- [ ] Performance check (search latency impact)

---

## 8. Files to Create/Modify

### New Files
| File | Purpose |
|------|---------|
| `src/packages/agent/core/rag-cache.ts` | RAG context cache implementation |
| `src/packages/agent/core/rag-context.ts` | RAG context formatter |
| `src/packages/agent/core/rag.test.ts` | Unit and integration tests |

### Modified Files
| File | Changes |
|------|---------|
| `src/packages/agent/core/embedded-agent.ts` | Add RagConfig, retrieveRagContext(), integrate into prompt() |
| `src/gateway/engine/in-process.ts` | Pass MemoryIndexer to EmbeddedAgent |
| `src/gateway/engine/agent-sessions.ts` | Pass MemoryIndexer through config |
| `src/packages/agent/core/observability.ts` | Add RAG stats to observability interface |
| `src/packages/agent/index.ts` | Export new types if needed |

---

## 9. Verification Commands

```bash
# Type check
npx tsc --noEmit

# Run RAG tests (when implemented)
npx vitest run src/packages/agent/core/rag.test.ts

# Run all agent tests
npx vitest run src/packages/agent

# Manual test with real indexer (requires running memory system)
# 1. Start gateway with memory system
# 2. Create some memory entries
# 3. Send prompts and check logs for RAG retrieval stats
```

---

## 10. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Score not available in SearchResult | HIGH | HIGH | Add score field to SearchResult type |
| Slow search blocks prompt | MEDIUM | MEDIUM | Add 5s timeout wrapper |
| Cache memory growth | LOW | LOW | 5-min eviction limits growth |
| Threshold tuning difficulty | MEDIUM | LOW | Make configurable, add observability |
| Indexer not wired | MEDIUM | HIGH | Ensure 0196.6-0196.7 are implemented |

---

**Generated by**: super-planner
**Date**: 2026-03-18
**Task**: 0196 - Selective Hybrid RAG Pipeline
**Status**: Implementation Plan Ready
