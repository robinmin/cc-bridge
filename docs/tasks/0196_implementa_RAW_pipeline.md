---
name: implementa RAW pipeline
description: Task: implementa RAW pipeline
status: Backlog
created_at: 2026-03-18 15:17:12
updated_at: 2026-03-18
impl_progress:
  planning: done
  design: done
  implementation: in_progress
  review: pending
  testing: pending
resolved_decisions:
  timeout: "5s hard timeout on memoryIndexer.search(), log warning on timeout"
  score_source: "Option A - add score?: number to SearchResult, modify HybridSearchManager to populate it"
  cache_normalization: "Similar queries collapsed (stemming/stop-word aware, not exact match)"
---

## 0196. implementa RAW pipeline

### Background

The memory system (Phase 5) built hybrid search combining FTS5 BM25 + vector cosine similarity in `src/gateway/memory/indexer/hybrid.ts`. The `MemoryIndexer.search()` API already returns ranked `SearchResult[]` with `id`, `path`, `snippet`, `source`. However, this search capability is not yet connected to the agent execution flow.

Section 14 of the embedded-agent spec lists **RAG pipeline** as High Priority: "Retrieve relevant docs from workspace + memory bank, rank them together, and inject top-K results into the agent's prompt context."

The chosen approach is **Selective Hybrid RAG**:
- Always run hybrid search on every prompt (low cost, local index)
- Only prepend context if relevance score exceeds a threshold
- This avoids the complexity of keyword heuristics (option B) and the noise of always injecting context (option A)

**Existing components to integrate with:**
- `MemoryIndexer.search(query, options?)` - already implemented, returns `SearchResult[]`
- `HybridSearchManager.search()` - supports `keyword`, `vector`, `hybrid` modes with weighted fusion scoring
- `EmbeddedAgent.prompt(message, options?)` - agent execution entry point
- `EmbeddedAgent.getSystemPrompt()` / `getMessages()` - introspection APIs
- Workspace bootstrap files loaded once at `initialize()` via `loadWorkspaceBootstrap()`

**What RAG adds:** Per-prompt retrieval from the memory index, selecting and injecting relevant context into the agent's prompt context, separate from the one-time workspace bootstrap loading.

### Requirements

1. **RAG Retrieval on Every Prompt**: Before calling `agent.prompt(message)`, invoke `MemoryIndexer.search()` with the user message as query to retrieve relevant docs.

2. **Selective Injection**: Only inject retrieved context if the relevance score exceeds a configurable threshold (default: 0.3). If no results exceed threshold, proceed without context injection.

3. **Hybrid Search Default**: Use `mode: "hybrid"` (the default in `HybridSearchManager`) which combines FTS5 BM25 + vector similarity. Fall back to `mode: "keyword"` if vector search is unavailable.

4. **Top-K Limiting**: Limit retrieval to top 5 results (configurable via `ragMaxResults`). Format each result as a markdown blockquote with path and snippet.

5. **Context Injection via System Prompt Prepend**: Inject context by prepending to the system prompt (not modifying user message). Format:
   ```
   <rag-context>
   ## Retrieved Context

   > [path/to/memory.md]
   > Snippet text here...

   > [path/to/daily/2026-03-18.md]
   > Another snippet...
   </rag-context>
   ```

6. **Separate from Workspace Bootstrap**: RAG context is per-prompt and computed dynamically. Workspace bootstrap files (`.workspace/*.md`) are loaded once at `initialize()` and do not change per prompt.

7. **Graceful Degradation**: If `MemoryIndexer` is unavailable or not initialized, log a warning and proceed without RAG (no context injection). Do not fail the prompt.

8. **Session-Level Caching**: Cache RAG results for the same query within a session to avoid redundant index lookups for repeated queries in follow-up turns.

9. **Configuration**: Add RAG config to `EmbeddedAgentConfig`:
   - `ragEnabled?: boolean` (default: true)
   - `ragThreshold?: number` (default: 0.3)
   - `ragMaxResults?: number` (default: 5)
   - `ragMode?: "keyword" | "vector" | "hybrid"` (default: "hybrid")

### Q&A

**1. Where in the execution flow does retrieval happen?**

Retrieval happens in `EmbeddedAgent.prompt()` before calling `agent.prompt(message)`. Specifically:
```
async prompt(message: string, options?: PromptOptions): Promise<AgentResult> {
  // 1. Guard against concurrent prompts
  // 2. Initialize if needed
  // 3. [NEW] Retrieve RAG context if enabled
  const ragContext = await this.retrieveRagContext(message);
  // 4. Build effective system prompt with RAG context prepended
  // 5. Call agent.prompt(message) with updated system prompt
  // 6. Return result
}
```

This approach keeps retrieval outside the event-collection loop and avoids modifying pi-agent-core internals. The RAG context is computed once per prompt call.

**2. How is the retrieved context formatted and injected?**

Context is formatted as a markdown block and **prepended to the system prompt** (not the user message), using a `<rag-context>` wrapper tag:

```
<rag-context>
## Retrieved Context

> [memory/bank/experience/project-x.md]
> The project uses a hybrid search architecture combining FTS5 and vector embeddings...

> [memory/daily/2026-03-17.md]
> Discussed RAG pipeline design. User prefers selective injection over always-on...

</rag-context>

[s original system prompt from workspace bootstrap files ]
```

**Rationale**: Injecting via system prompt (not user message) ensures:
- The context survives across turns in the session
- The LLM sees it as authoritative background knowledge
- It does not pollute the user's actual message history
- The `<rag-context>` tag allows the agent to potentially ignore or weight the section

**3. What is the relevance threshold and how is it determined?**

The threshold is a **score-based cutoff** (default: 0.3) applied to the combined relevance score from `HybridSearchManager`. The score comes from weighted fusion of BM25 keyword rank + cosine similarity vector rank, normalized to a 0-1 range in `hybrid.ts mergeResults()`.

**Determination rationale**:
- Threshold 0.3 means the result ranked in the top ~30% of the fused score range
- This is conservative by default -- only clearly relevant docs are injected
- Configurable via `ragThreshold` to allow tuning per use case
- The threshold is applied AFTER retrieval but BEFORE formatting/injection

**4. What happens to workspace docs vs memory bank entries -- same retrieval or separate?**

Both use the **same retrieval** via `MemoryIndexer.search()`. The `SearchResult` returned already includes a `source` field indicating `type: "memory" | "daily" | "bank"`. The RAG pipeline does not differentiate during retrieval -- both workspace docs and memory bank entries are retrieved together and ranked by the same hybrid scoring.

The rationale is that for RAG purposes, the distinction between "workspace" and "memory bank" is not meaningful -- what matters is relevance to the query.

Note: This is separate from **workspace bootstrap file loading** (`.workspace/*.md` files loaded at `initialize()`). Those are static files injected as the base system prompt. RAG retrieves dynamically from the memory index which includes both memory bank files and daily logs.

**5. How does this interact with the existing workspace bootstrap file loading?**

They are **independent and additive**:
- **Workspace bootstrap** (`loadWorkspaceBootstrap()`): Loaded once in `initialize()`, concatenated into `this.systemPrompt`, set on the agent via `agent.setSystemPrompt()`. Represents static project context (instructions, conventions, bootstrap data).
- **RAG context**: Computed per-prompt in `prompt()`, prepended to the system prompt before calling `agent.prompt()`. Represents dynamic retrieved knowledge.

The execution flow:
```
initialize():
  systemPrompt = loadWorkspaceBootstrap(workspaceDir)  // Static
  agent.setSystemPrompt(systemPrompt)

prompt(message):
  ragContext = retrieveRagContext(message)             // Dynamic
  if (ragContext) {
    effectiveSystemPrompt = formatRagContext(ragContext) + "\n\n" + systemPrompt
    agent.setSystemPrompt(effectiveSystemPrompt)        // Update for this prompt
  }
  agent.prompt(message)
```

**6. Should retrieved context be cached in the session for follow-up turns?**

**Yes, within a session**. Cache RAG results using a `Map<string, { context: string, timestamp: number }>` keyed by normalized query string. This provides two benefits:
- **Follow-up turns**: If the user asks a follow-up question with the same or similar query, the cached context is reused without re-running the index search.
- **Token efficiency**: Avoids re-injecting the same context if the conversation revisits a topic.

**Cache invalidation**: The cache is session-scoped (cleared when the agent is disposed or `clearMessages()` is called). Per-turn cache entries older than 5 minutes are evicted to keep context fresh.

**7. Error handling -- what if the index is unavailable?**

Graceful degradation:
- If `MemoryIndexer` is null or not initialized: log `warn("RAG index not available, skipping retrieval")` and proceed without context injection
- If `search()` throws: catch the error, log `warn("RAG search failed: {error}")`, proceed without context injection
- If the index returns zero results: treat as below threshold, proceed without context injection

**Do NOT**: Fail the prompt, throw an error to the caller, or attempt to retry. RAG is best-effort enhancement, not a hard requirement for agent execution.

### Design

#### Architecture

```
EmbeddedAgent
  ├── prompt(message, options?)
  │     ├── retrieveRagContext(query)         [NEW - RAG retrieval]
  │     │     └── MemoryIndexer.search()       (hybrid mode)
  │     │           └── HybridSearchManager       (FTS5 + vector fusion)
  │     ├── formatRagContext(results)         [NEW - formatting]
  │     ├── prepend to systemPrompt           (if above threshold)
  │     ├── agent.prompt(message)             (existing)
  │     └── return AgentResult
  └── initialize()
        └── loadWorkspaceBootstrap()           (existing - static context)
```

#### New Components

**1. RAG Config Interface** (added to `embedded-agent.ts`):
```typescript
interface RagConfig {
  /** Enable RAG retrieval on every prompt */
  enabled: boolean;
  /** Minimum relevance score to inject context (0-1) */
  threshold: number;
  /** Maximum number of results to retrieve */
  maxResults: number;
  /** Search mode */
  mode: "keyword" | "vector" | "hybrid";
}
```

**2. RAG Context Formatter** (new file `src/packages/agent/core/rag-context.ts`):
```typescript
export function formatRagContext(results: SearchResult[]): string {
  // Wraps results in <rag-context> markdown block
  // Each result formatted as blockquote with path and snippet
}
```

**3. RagContextCache** (new file `src/packages/agent/core/rag-cache.ts`):
```typescript
interface CacheEntry {
  context: string;
  timestamp: number;
}
// Map<normalizedQuery, CacheEntry>
// Eviction: entries older than 5 minutes, or on dispose()
```

#### Integration Points

1. **`EmbeddedAgent.prompt()`**: Add RAG retrieval step before `agent.prompt()` call
2. **`EmbeddedAgentConfig`**: Add optional `rag?: RagConfig` field
3. **`EmbeddedAgent.initialize()`**: No changes to workspace bootstrap loading
4. **`EmbeddedAgent.dispose()`**: Clear RAG cache

#### Data Flow

```
User message
    │
    ▼
┌─────────────────────────────────────┐
│ EmbeddedAgent.prompt(message)      │
│                                     │
│ 1. Check ragEnabled flag           │
│ 2. Compute cache key (norm query)  │
│ 3. Check RAG cache ─────────────┐  │
│    │                             │  │
│    │ (cache hit)                 │  │
│    ▼                             │  │
│ 4. MemoryIndexer.search()        │  │
│    │ (query, { mode, limit })    │  │
│    ▼                             │  │
│ 5. Filter by threshold           │  │
│    │                             │  │
│    │ (below threshold = skip)    │  │
│    ▼                             │  │
│ 6. Format as markdown block       │  │
│    │                             │  │
│    ▼                             │  │
│ 7. Prepend to systemPrompt ───────┘  │
│    │                             │  │
│    ▼                             │  │
│ 8. agent.prompt(message)         │
│    │                             │  │
└────│─────────────────────────────┘
     │
     ▼
AgentResult
```

#### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|------------|
| Retrieval location | Before `agent.prompt()` in `prompt()` method | Keeps retrieval outside event loop; no pi-agent-core modifications |
| Injection method | System prompt prepend with `<rag-context>` tag | LLM sees it as authoritative background; survives across turns; identifiable tag |
| Threshold | Score-based cutoff (default 0.3) | Simple, tunable, grounded in actual relevance scores |
| Caching | Session-level Map, 5-min eviction | Avoids redundant searches for follow-up questions |
| Degradation | Log warning, skip RAG, proceed | RAG is best-effort; do not fail prompt for RAG errors |
| Workspace vs Memory | Same retrieval, no distinction | Relevance is what matters for RAG |

### Plan

**WBS 0196: Selective Hybrid RAG Pipeline**

| Step | Task | Dependencies | File(s) |
|------|------|-------------|---------|
| **0196.1** | **Add RAG config types to EmbeddedAgentConfig** | None | `src/packages/agent/core/embedded-agent.ts` |
| | - Add `RagConfig` interface (enabled, threshold, maxResults, mode) | | |
| | - Add `rag?: RagConfig` to `EmbeddedAgentConfig` | | |
| | - Initialize RAG cache in constructor | | |
| **0196.2** | **Create `rag-cache.ts`** | None | `src/packages/agent/core/rag-cache.ts` |
| | - Implement `RagContextCache` class with Map-based storage | | |
| | - `get(query): string \| undefined` - cache lookup | | |
| | - `set(query, context): void` - cache store | | |
| | - `evictOlderThan(maxAgeMs): void` - cleanup | | |
| | - `clear(): void` - full clear on dispose | | |
| **0196.3** | **Create `rag-context.ts`** | None | `src/packages/agent/core/rag-context.ts` |
| | - `formatRagContext(results: SearchResult[]): string` | | |
| | - Format as `<rag-context>` markdown with blockquotes | | |
| | - Include path as reference label | | |
| | - `buildRagPrompt(query: string, results: SearchResult[]): string` | | |
| **0196.4** | **Add `retrieveRagContext()` method to EmbeddedAgent** | 0196.1, 0196.2, 0196.3 | `src/packages/agent/core/embedded-agent.ts` |
| | - Accept `message: string` as query | | |
| | - Compute normalized cache key | | |
| | - Check cache for hit (return cached if valid) | | |
| | - Call `MemoryIndexer.search()` via injected indexer (or gateway) | | |
| | - Filter results by threshold | | |
| | - Format and cache result | | |
| | - Return formatted string or undefined | | |
| **0196.5** | **Integrate RAG retrieval into `prompt()` method** | 0196.4 | `src/packages/agent/core/embedded-agent.ts` |
| | - Before `agent.prompt(message)`: call `retrieveRagContext(message)` | | |
| | - If context returned and ragEnabled: prepend to system prompt | | |
| | - Use `agent.setSystemPrompt()` to update temporarily | | |
| | - Restore original system prompt after prompt completes | | |
| **0196.6** | **Wire up MemoryIndexer access in EmbeddedAgent** | 0189 (hybrid search) | `src/packages/agent/core/embedded-agent.ts`, `src/gateway/engine/in-process.ts` |
| | - Pass `MemoryIndexer` instance to `EmbeddedAgent` via config | | |
| | - Store indexer reference for RAG retrieval | | |
| | - Handle null/unavailable indexer gracefully | | |
| **0196.7** | **Update InProcessEngine and AgentSessionManager to pass MemoryIndexer** | 0196.6 | `src/gateway/engine/in-process.ts`, `src/gateway/engine/agent-sessions.ts` |
| | - Include `memoryIndexer` in config passed to EmbeddedAgent | | |
| **0196.8** | **Add tests for RAG pipeline** | 0196.1-0196.7 | `src/packages/agent/core/rag.test.ts` |
| | - Test `formatRagContext()` formatting | | |
| | - Test `RagContextCache` get/set/eviction | | |
| | - Test threshold filtering | | |
| | - Test graceful degradation when indexer unavailable | | |
| | - Test integration with EmbeddedAgent.prompt() | | |
| **0196.9** | **Add RAG observability logging** | 0196.5 | `src/packages/agent/core/embedded-agent.ts` |
| | - Log RAG retrieval stats: results count, threshold, cache hit/miss | | |
| | - Include in observability snapshot | | |

**Implementation Order**: 0196.1 (config) -> 0196.2 (cache) -> 0196.3 (formatter) -> 0196.4 (retrieval method) -> 0196.5 (integration into prompt) -> 0196.6 (indexer wiring) -> 0196.7 (engine wiring) -> 0196.8 (tests) -> 0196.9 (observability)

**Related Tasks**:
- **0188** (`vector-storage-search.md`): Vector storage and search - completed
- **0189** (`hybrid-search-fusion.md`): Hybrid search fusion - completed
- **0195** (`file-watcher-auto-index.md`): Auto-indexing - completed

### Artifacts

| Type | Path | Generated By | Date |
|------|------|--------------|------|
| Implementation | `src/packages/agent/core/rag-context.ts` | TBD | TBD |
| Implementation | `src/packages/agent/core/rag-cache.ts` | TBD | TBD |
| Implementation | `src/packages/agent/core/embedded-agent.ts` (modified) | TBD | TBD |
| Tests | `src/packages/agent/core/rag.test.ts` | TBD | TBD |

### References

- `src/packages/agent/core/embedded-agent.ts` - EmbeddedAgent class to be modified
- `src/gateway/memory/indexer/indexer.ts` - MemoryIndexer.search() API
- `src/gateway/memory/indexer/hybrid.ts` - HybridSearchManager with weighted fusion scoring
- `src/gateway/memory/indexer/types.ts` - SearchResult, SearchOptions types
- `src/gateway/memory/types.ts` - MemorySource, SearchResult interfaces
- `src/packages/agent/core/event-bridge.ts` - EventCollector (for reference on event handling)
- `docs/06_EMBEDDED_AGENT_SPEC.md` Section 14 - RAG pipeline listed as High Priority
- Task 0188 (`docs/tasks/0188_vector-storage-search.md`) - Vector search implementation
- Task 0189 (`docs/tasks/0189_hybrid-search-fusion.md`) - Hybrid search fusion
- Task 0195 (`docs/tasks/0195_file-watcher-auto-index.md`) - Auto-indexing

---

**Approach Summary**: Selective Hybrid RAG retrieves relevant docs via the existing hybrid search index on every prompt, but only injects them into the system prompt if the relevance score exceeds a configurable threshold (default 0.3). This balances retrieval quality against noise injection, without requiring complex keyword heuristics or always-on context that degrades signal.
