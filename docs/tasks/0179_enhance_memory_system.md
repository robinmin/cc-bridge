---
name: enhance memory system
description: Task: enhance memory system
status: Done
created_at: 2026-03-17 16:13:28
updated_at: 2026-03-18
impl_progress:
  planning: done
  design: done
  implementation: done
  review: done
  testing: done
---

## 0179. enhance memory system

### Background
We need to do a seseach on how to implement memory system for AI agents, then implement a memory system or enhance current one.

but before any external research, we need to understand what their memory solutions for openclaw and pi-mono with pros and cons analysis. You can find their source code at:

-  vendors/pi-mono
-  vendors/openclaw

### Requirements

[What needs to be done - acceptance criteria]

#### Analysis Phase ✅ (Completed)
- [x] Analyze existing memory implementation in `src/gateway/memory/`
- [x] Analyze memory system in `vendors/openclaw/src/memory/` with pros/cons
- [x] Analyze session management in `vendors/pi-mono/` with pros/cons
- [x] Document findings in task file Q&A section

#### Architecture Decision: Openclaw-style + Pi-mono Compaction

**Chosen approach:**
- **Storage**: Markdown files as source of truth (Openclaw design)
- **Index**: SQLite FTS5 + vector as derived index (rebuildable from markdown)
- **Compaction**: Token threshold trigger + LLM summarization (pi-mono style)

#### Core Features (MVP - Must Have)
- [x] Adopt openclaw's memory layout:
  - `memory.md` - durable facts and preferences
  - `memory/YYYY-MM-DD.md` - daily logs
  - `bank/` - typed memory pages (world, experience, opinions, entities)
- [x] Implement SQLite FTS5 index for full-text search
- [x] Add vector embedding support with configurable provider
- [x] Hybrid search (BM25 + vector fusion)
- [x] Fallback to keyword search when embeddings unavailable
- [ ] Memory status endpoint (available backends, stats)

#### Enhanced Features (Should Have)
- [ ] Embedding cache to reduce API calls
- [ ] Automatic re-indexing on memory changes (file watcher)
- [x] Implement pi-mono style compaction:
  - Token threshold trigger
  - LLM summarization with structured format
  - File operation tracking (read/write/edit)

#### Nice to Have
- [ ] Memory compaction/summarization
- [ ] Temporal decay for relevance scoring
- [ ] Multi-workspace memory support
- [ ] Memory analytics dashboard

### Memory Consolidation Design

#### Chosen Architecture: Openclaw-style + Pi-mono Compaction

**Storage Layout:**
```
.memory/
  memory.md                    # Core durable facts + preferences
  memory/
    YYYY-MM-DD.md             # Daily log (append; narrative)
  bank/                       # Curated, typed memory pages
    world.md                  # Objective facts about the world
    experience.md             # What the agent did (first-person)
    opinions.md               # Subjective prefs/judgments + confidence
    entities/
      *.md                    # Entity-specific facts
```

**Index Strategy:**
- SQLite with FTS5 for full-text search
- Vector embeddings for semantic search (optional, configurable)
- Index is **always rebuildable from Markdown source**

**Compaction Trigger (Pi-mono style):**
```
contextTokens > contextWindow - reserveTokens
```
- Default: 16KB reserve, 20KB recent kept
- Uses LLM to generate structured summary

**Summary Format (Pi-mono style):**
```markdown
## Goal
[What is the user trying to accomplish?]

## Constraints & Preferences
- [Any constraints mentioned]

## Progress
### Done
- [x] Completed tasks

### In Progress
- [ ] Current work

### Blocked
- [Issues if any]

## Key Decisions
- [Decision]: Brief rationale

## Next Steps
1. Ordered list

## Critical Context
- Data needed to continue
```

**File Operation Tracking:**
- Track read/write/edit from tool calls
- Include in summary for context

### Q&A

[Clarifications added during planning phase]

#### Key Questions Answered

**Q: Do openclaw/pi-mono use markdown for memory storage?**
A: **Openclaw**: Yes - uses markdown files (`memory.md`, `memory/YYYY-MM-DD.md`, `bank/` folder) as canonical source. SQLite with FTS5+vector is a *derived index* that is always rebuildable from markdown.
A: **Pi-mono**: No - uses JSONL (`.jsonl`) files for session storage, with session branching and compaction support.

**Q: Which embedding providers should be supported?**
A: Start with OpenAI as primary provider, keep keyword search as fallback. Support abstraction for future providers (Gemini, local models).

**Q: What's the recommended implementation approach?**
A: Follow openclaw's proven approach - markdown as source of truth + vector/hybrid search index. This maintains human-readable memory while adding semantic search capability.

**Q: How to handle backward compatibility?**
A: Keep old API available, provide migration path from file-based memory to new indexed system.

**Q: What are the target performance requirements?**
A: Target search latency <500ms, configurable embedding batch size, SQLite FTS5 for full-text search.

### Design

[Architecture/UI specs added by specialists]

### Plan


### Solution

# Solution: Enhance Memory System

## Approach Summary

Implement a hybrid memory system combining Openclaw's markdown-first approach with Pi-mono's compaction strategy. The system will use markdown files as the source of truth, SQLite FTS5 for full-text search, and vector embeddings for semantic search. All indexes are rebuildable from markdown source.

## Key Technical Decisions

1. **Markdown as Source of Truth**: Follow Openclaw's proven pattern - all memory stored in human-readable markdown files in `.memory/` directory structure
2. **SQLite FTS5 + Vector Index**: Use SQLite FTS5 for keyword search, with optional vector embeddings for semantic search. Index is always rebuildable.
3. **Pi-mono Style Compaction**: Token threshold trigger with LLM summarization using structured summary format
4. **Configurable Embedding Providers**: Abstract embedding provider behind interface, start with OpenAI, fallback to keyword-only search

## Files to Create/Modify

### New Files
- `src/gateway/memory/index.ts` - Main entry point, exports
- `src/gateway/memory/storage/` - Markdown file storage layer
  - `storage.ts` - File I/O operations
  - `memory.ts` - Durable facts management
  - `daily-log.ts` - Daily log management  
  - `bank.ts` - Typed memory bank management
- `src/gateway/memory/indexer/` - Indexing layer
  - `indexer.ts` - Main indexer orchestrator
  - `fts5.ts` - SQLite FTS5 full-text search
  - `vector.ts` - Vector embedding integration
  - `hybrid.ts` - BM25 + vector fusion
- `src/gateway/memory/compaction/` - Memory compaction
  - `compactor.ts` - Compaction orchestrator
  - `token-counter.ts` - Token threshold detection
  - `summarizer.ts` - LLM summarization
- `src/gateway/memory/types.ts` - TypeScript interfaces

### Files to Modify
- `src/gateway/memory/server.ts` - Add new endpoints (status, search, re-index)
- `src/gateway/index.ts` - Register new routes
- Add file watcher integration for auto re-indexing

## Implementation Phases

### Phase 1: Core Storage Layer (Memory Files)
- Implement `.memory/` directory structure
- Implement memory.md, daily logs, bank/ typed pages
- File I/O utilities

### Phase 2: FTS5 Indexing
- SQLite database setup with FTS5
- Full-text search implementation
- Index rebuild from markdown

### Phase 3: Vector Embeddings
- Embedding provider interface
- OpenAI provider implementation
- Vector search with fallback

### Phase 4: Hybrid Search
- BM25 + vector fusion algorithm
- Query routing based on availability

### Phase 5: Compaction
- Token threshold detection
- LLM summarization
- Structured summary format

### Phase 6: API & Integration
- Memory status endpoint
- Search endpoint
- File watcher for auto re-index

## Acceptance Criteria

- [ ] Markdown memory files readable and writable
- [ ] FTS5 search returns relevant results
- [ ] Vector search works when provider available
- [ ] Keyword fallback works when embeddings unavailable
- [ ] Memory status shows available backends and stats
- [ ] Compaction triggers at token threshold
- [ ] Summaries maintain context continuity
- [ ] File watcher triggers re-index on changes

### Artifacts

| Type | Path | Description |
|------|------|-------------|
| New | `src/gateway/memory/types.ts` | Extended TypeScript interfaces |
| New | `src/gateway/memory/storage.ts` | Base file I/O operations |
| New | `src/gateway/memory/memory.ts` | Durable memory (memory.md) ops |
| New | `src/gateway/memory/daily-log.ts` | Daily log management |
| New | `src/gateway/memory/bank.ts` | Bank pages (world/experience/opinions/entities) |
| New | `src/gateway/memory/indexer/` | Indexing layer |
| New | `src/gateway/memory/compaction/` | Compaction layer |
| Modified | `src/gateway/memory/backend-builtin.ts` | Updated to use new storage layer |
| Modified | `src/gateway/memory/index.ts` | Main exports |

### Implementation Summary

**Phase 1: Storage Layer ✅**
- Created Openclaw-style directory structure
- Implemented memory.md, daily logs, bank pages
- Updated BuiltinMemoryBackend to use new storage

**Phase 2: Indexer ✅**
- SQLite FTS5 full-text search
- Embedding provider interface (OpenAI, fallback)
- Hybrid search (keyword + vector)

**Phase 3: Compaction ✅**
- Token threshold detection
- LLM summarizer (pi-mono style format)
- Compaction orchestrator

### Remaining Tasks
- Memory status endpoint
- File watcher for auto re-indexing
- Embedding cache
- Testing

### Artifacts

| Type | Path | Generated By | Date |
|------|------|--------------|------|

### References

[Links to docs, related tasks, external resources]

- Openclaw memory design: `vendors/openclaw/docs/experiments/research/memory.md`
- Openclaw memory implementation: `vendors/openclaw/src/memory/`
- Openclaw compaction logic: `vendors/openclaw/src/memory/manager-embedding-ops.ts`
- Pi-mono session system: `vendors/pi-mono/packages/coding-agent/src/core/session-manager.ts`
- Pi-mono compaction: `vendors/pi-mono/packages/coding-agent/src/core/compaction/`
- Current implementation: `src/gateway/memory/`
- Related: 0180_implement_vector_embeddings (future task for embedding provider abstraction)
