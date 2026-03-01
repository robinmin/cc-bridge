# ARCHITECTURE_SPEC_RFC

## 1. Purpose
This RFC defines the target architecture for `cc-bridge` to:
1. Introduce a first-class memory system (`.memory/SOUL.md`, `.memory/USER.md`, `.memory/MEMORY.md`, `.memory/daily/YYYY-MM-DD.md`).
2. Add a pluggable memory backend model.
3. Reuse mature embedded-agent framework patterns (pi-mono style) without coupling core gateway logic to a single runtime.
4. Keep current behavior stable while migrating incrementally.

This document is the implementation blueprint for follow-up changes.

## 2. Scope and Non-Goals
### In scope
- Memory contract, loading rules, write rules, retrieval tools.
- Memory backend abstraction and default implementation.
- Prompt/bootstrap integration points in gateway flow.
- Migration phases with acceptance gates and rollback strategy.

### Out of scope (for this RFC)
- Full replacement of current execution engine.
- Full nanoclaw-style skills rebase engine.
- UI redesign.

## 3. Current State Summary
- `src/gateway/persistence.ts` provides SQLite persistence for messages/tasks/session metadata.
- No unified memory contract for durable agent memory files.
- No memory plugin slot (`none | builtin | external`).
- Prompt context relies on current routing/pipeline flows and does not consistently enforce memory loading policy by context type.

## 4. Target Architecture

### 4.1 Memory Layers (Source of Truth = Markdown)
Workspace-level files:
- `.memory/SOUL.md`: agent identity, boundaries, communication style.
- `.memory/USER.md`: user profile, stable preferences, collaboration rules.
- `.memory/MEMORY.md`: durable long-term facts/decisions.
- `.memory/daily/YYYY-MM-DD.md`: daily operational memory log.

Rules:
- Markdown files are canonical. Derived indexes are rebuildable artifacts.
- Missing files are valid state (must not hard-fail runtime).
- Memory access must degrade gracefully when files are absent.

### 4.2 Memory Loading Policy
- Private/direct contexts:
  - Load `.memory/SOUL.md`, `.memory/USER.md`, `.memory/MEMORY.md`, and `today/yesterday` daily memory files.
- Group/shared contexts:
  - Load `.memory/SOUL.md` and minimal safe user context.
  - Do **not** load full `.memory/MEMORY.md` by default.
  - Allow explicit per-workspace override later (config gated).

### 4.3 Memory Write Policy
Write memory on:
- Explicit user intent: “remember this”.
- Durable preference updates.
- Stable project decisions (naming, workflow, tool policy, env conventions).
- Significant state transitions (workspace/session routing policy changes).

Do not write memory for:
- Ephemeral command outputs.
- Sensitive secrets unless explicitly approved and encrypted handling exists.

### 4.4 Memory Backend Abstraction
Define a backend interface:
- `status(): MemoryStatus`
- `get(pathOrRef): MemoryDocument`
- `appendDaily(entry): WriteResult`
- `upsertLongTerm(entry): WriteResult`
- `search(query, options): SearchResult[]`
- `reindex(): ReindexResult`

Initial backend:
- `builtin` backend = markdown + local index (SQLite/FTS/vector optional).

Future-ready backends:
- `none` backend (disabled behavior).
- `qmd`/external backend via adapter.

### 4.5 Agent Runtime Integration Pattern
Adopt embedded runtime integration pattern:
- Keep session lifecycle, channel routing, webhook processing, and policy wiring in `cc-bridge`.
- Treat runtime (pi-mono derived or equivalent) as embedded engine, not orchestration owner.
- Inject memory/tooling via gateway-owned adapters.

### 4.6 Plugin Slot Model
Add config-level slot:
- `memory.slot = "builtin" | "none" | "external"`
- Optional `memory.external.provider` and provider-specific config.

Behavior:
- Slot unavailable -> runtime degrades with clear diagnostics; no fatal crash.

### 4.7 Observability and Safety
Must expose:
- memory load decisions (which files loaded/skipped).
- memory write events (type, destination, reason, redaction status).
- backend status and index health.
- compaction-triggered flush attempts.

## 5. Required New Components

### 5.1 New modules
- `src/gateway/memory/contracts.ts`
- `src/gateway/memory/backend-builtin.ts`
- `src/gateway/memory/backend-none.ts`
- `src/gateway/memory/manager.ts`
- `src/gateway/memory/policy.ts`
- `src/gateway/memory/tools.ts`

### 5.2 Integration points (initial)
- `src/gateway/routes/webhook.ts`: attach memory context decision input.
- `src/gateway/pipeline/agent-bot.ts`: memory read/write tool exposure.
- `src/gateway/services/execution-engine.ts`: injected context payload and memory tool wiring.
- `src/gateway/persistence.ts`: keep DB as metadata/event store, not memory source-of-truth.

## 6. Data and Config Contract

### 6.1 Filesystem contract
Under workspace root:
- `.memory/SOUL.md`
- `.memory/USER.md`
- `.memory/MEMORY.md`
- `.memory/daily/YYYY-MM-DD.md`

### 6.2 Config contract (proposed)
```jsonc
{
  "memory": {
    "slot": "builtin",
    "citations": "auto", // auto|on|off
    "loadPolicy": {
      "groupLoadLongTerm": false
    },
    "flush": {
      "enabled": true,
      "softThresholdTokens": 4000
    },
    "builtin": {
      "index": {
        "enabled": true
      }
    }
  }
}
```

## 7. Migration Plan (Clean, Incremental)

### Phase 0: Guardrails and Baseline
Deliverables:
- Add coverage gates for new memory modules and touched files (>=90% file line coverage).
- Add architecture tests for load policy behavior.

Exit criteria:
- `make test` and `make test-coverage` pass.
- No behavior change in existing request execution path.

Rollback:
- Revert new memory wiring behind feature flag default-off.

### Phase 1: Introduce Memory Contract + `none` Backend
Deliverables:
- Add `memory/contracts.ts`, `backend-none.ts`, `manager.ts` skeleton.
- Add config parsing for `memory.slot`.

Exit criteria:
- System runs with `memory.slot=none` and identical behavior to today.

Rollback:
- Set `memory.slot=none` globally.

### Phase 2: Implement Builtin Markdown Backend
Deliverables:
- File IO for `SOUL.md`, `USER.md`, `MEMORY.md`, daily memory.
- Graceful missing-file behavior.
- Basic search (`grep/FTS`) and direct get.

Exit criteria:
- Unit tests cover missing/malformed/empty file cases.
- No webhook or execution regressions.

Rollback:
- Flip `memory.slot=none`.

### Phase 3: Policy-Driven Prompt Loading
Deliverables:
- Load policy engine (private vs group).
- Integration in webhook/pipeline/execution path.
- Add explicit telemetry events for load decisions.

Exit criteria:
- Group contexts verified not to ingest long-term memory by default.
- Private contexts ingest expected files.

Rollback:
- Disable policy injection and keep backend active only for explicit tool calls.

### Phase 4: Memory Write Triggers + Flush
Deliverables:
- Write decision policy implementation.
- Triggered writes for explicit remember/preference/decision events.
- Pre-compaction flush ping (silent path).

Exit criteria:
- Idempotent writes.
- No duplicate noisy memory entries in standard runs.

Rollback:
- Disable flush and auto-write; keep manual memory tools only.

### Phase 5: Pluggable External Backend Adapter
Deliverables:
- External adapter interface and one stub provider.
- Health/status fallback to builtin/none.

Exit criteria:
- Hard failure in external backend does not break message processing.

Rollback:
- Switch slot to `builtin` or `none`.

### Phase 6: Stabilization and Hardening
Deliverables:
- Performance tests for search/get/write.
- Concurrency and race-condition tests.
- Security review (redaction and secret handling policy).

Exit criteria:
- Per-file coverage >=90% for all changed/new files.
- 100% test pass.
- No P0/P1 regressions in webhook + callback routes.

## 8. Testing Strategy (Mandatory)
- Unit: backend contracts, policy decisions, file edge cases, tool behavior.
- Integration: webhook -> routing -> execution with memory on/off and group/private variants.
- Regression: ensure legacy flows unaffected with `memory.slot=none`.
- Coverage gate: file-level threshold >=90% for touched files.

## 9. Operational Rollout
- Step 1: deploy with `memory.slot=none`.
- Step 2: enable `memory.slot=builtin` in canary workspace.
- Step 3: enable write triggers for selected chats only.
- Step 4: full rollout after 7-day error-free window.

## 10. Decision Log
- Chosen canonical memory format: Markdown files.
- Chosen orchestration owner: `cc-bridge` gateway remains owner.
- Chosen extensibility: slot-based memory backend.
- Chosen migration style: feature-flagged phases with explicit rollback at each phase.
