---
name: convert in-process execution engine as a full featured agent
description: Replace completeSimple with pi-agent-core Agent class, add tool calling, session management, and streaming
status: Done
created_at: 2026-03-08 23:42:56
updated_at: 2026-03-10 10:15:00
impl_progress:
  planning: done
  design: done
  implementation: done
  review: done
  testing: done
---

## 0162. Convert In-Process Execution Engine as a Full-Featured Agent

### Background

The current in-process execution engine (`src/gateway/engine/in-process.ts`, 272 lines) uses `@mariozechner/pi-ai`'s `completeSimple()` for single request-response text completion. It is feature-flagged disabled (`ENABLE_IN_PROCESS=true`) and lacks tool calling, agent loop, streaming, skills, and proper session management.

OpenClaw at `vendors/openclaw` provides a reference implementation built on `@mariozechner/pi-agent-core` (0.57.1) with a full-featured embedded agent (`src/agents/pi-embedded-runner/`). CC-Bridge already depends on both `pi-ai` (0.57.1) and `pi-agent-core` (0.57.1).

The key insight from code review is that **pi-agent-core's `Agent` class already provides ~80% of what's needed** (agent loop, event system, streaming, tool registration, context transformation hooks, abort handling). The work is primarily **integration and wiring**, not building agent infrastructure from scratch.

### Code Review Summary: OpenClaw vs CC-Bridge

#### What OpenClaw Has (Reference Architecture)

| Component | Key Files | Architecture |
|-----------|-----------|-------------|
| **Agent Execution** | `src/agents/pi-embedded-runner/run.ts` (48KB), `attempt.ts` (56KB) | `runEmbeddedPiAgent()` → retry loop (max 160 iters) → `createAgentSession()` from pi-coding-agent |
| **Event System** | `src/agents/pi-embedded-subscribe.ts`, `handlers.*.ts` | Event types: message_start/update/end, tool_execution_start/update/end, agent_start/end |
| **Session Management** | `src/agents/session-dirs.ts`, `session-write-lock.ts`, `session-file-repair.ts` | JSONL transcript files, write locks, compaction/summarization |
| **Tool Policy Pipeline** | `src/agents/pi-tools.ts`, `tool-policy-pipeline.ts`, `pi-tools.policy.ts` | 5-stage pipeline: profile → provider → global → agent → group → subagent |
| **Tool Wrapping** | `pi-tools.before-tool-call.ts`, tool-result-truncation.ts | Abort signal, before-hook, workspace guard, param normalization |
| **Skills System** | `src/agents/skills/workspace.ts` (760 LOC), `types.ts`, `config.ts` | SKILL.md with YAML frontmatter, 6 discovery sources, eligibility filtering, snapshot caching with file watcher |
| **Workspace Injection** | `src/agents/workspace.ts`, `bootstrap-files.ts` | Bootstrap files (AGENTS.md, SOUL.md, etc.), inode-based caching, boundary-safe reading |
| **Subagent Spawning** | `src/agents/subagent-spawn.ts`, `subagent-registry.ts` | Registry with depth limits, policy-controlled tool restrictions per depth |
| **Context Management** | `src/agents/context-window-guard.ts`, `compact.ts` (29KB) | Hard min 4096 tokens, automatic compaction with history summarization |

#### What CC-Bridge Has Today

| Component | Status | Notes |
|-----------|--------|-------|
| 3-layer orchestrator | Done | in-process / host-ipc / container with fallback |
| In-process engine | Basic | `completeSimple()` only, no tools, no agent loop |
| Session pool | Done | Per-workspace tmux sessions, sticky chat→instance mapping |
| Context strategy | Done | manual/turnLimit/idleTimeout/sizeLimit/hybrid strategies |
| Memory system | Unused | Markdown-canonical (SOUL.md, USER.md, MEMORY.md) — not actively used, to be replaced by workspace file injection |
| Tool system | Missing | Prompt-based only, no formal tool registration |
| Streaming | Missing | No streaming to chat platforms |
| Agent loop | Missing | No multi-turn tool use |

### Reuse / Customize / Build-from-Scratch Analysis

#### Reuse Directly from pi-agent-core (Import & Wire)

| Component | Source | Usage |
|-----------|--------|-------|
| `Agent` class | `@mariozechner/pi-agent-core` | Instantiate per-session, configure with model/tools/system prompt |
| `AgentEvent` system | `@mariozechner/pi-agent-core` | Subscribe to events, forward to chat platform |
| `AgentTool` interface | `@mariozechner/pi-agent-core` | Implement cc-bridge-specific tools |
| `convertToLlm` hook | `@mariozechner/pi-agent-core` | Transform cc-bridge's `{sender, text, timestamp}[]` to pi-ai's `Message[]` |
| `transformContext` hook | `@mariozechner/pi-agent-core` | Context window pruning |
| `getApiKey` callback | `@mariozechner/pi-agent-core` | Reuse existing `PROVIDER_CONFIGS` logic |
| `abort()` / `AbortController` | `@mariozechner/pi-agent-core` | Timeout handling (already in InProcessEngine) |
| `steer()` / `followUp()` | `@mariozechner/pi-agent-core` | User sends new messages while agent is running |

#### Customize (Take Pattern, Adapt for CC-Bridge)

| Component | OpenClaw Reference | CC-Bridge Adaptation |
|-----------|-------------------|---------------------|
| Tool registration | `createOpenClawCodingTools()` in `pi-tools.ts` | Simplified factory: 3-5 tools for messaging context (not full IDE tooling) |
| Tool policy | 5-stage pipeline with glob patterns | Simplified 2-stage: global allow/deny + per-chat restrictions |
| Session lifecycle | JSONL files + write locks + repair | SQLite-backed (cc-bridge already uses SQLite) + in-memory Agent map |
| Event handling | `subscribeEmbeddedPiSession()` with 10+ event handlers | Lightweight event bridge: collect into `ExecutionResult` + optional streaming callback |
| Context management | Auto-compaction with summarization (29KB compact.ts) | `transformContext` hook with simple window pruning (keep last N messages) |
| Workspace injection | Multi-file bootstrap (AGENTS.md, SOUL.md, etc.) with inode-based caching | Adopt OpenClaw's workspace file injection pattern (AGENTS.md, SOUL.md, IDENTITY.md, USER.md, MEMORY.md, TOOLS.md) to replace the unused memory system. Simplify: no inode caching initially, just file-read-on-boot with change detection |

#### Build from Scratch (CC-Bridge Specific)

| Component | Reason | Complexity |
|-----------|--------|-----------|
| Chat platform streaming adapter | Telegram `editMessageText` / Feishu API with rate limit debouncing (30 msg/sec) | Medium |
| Agent session manager | Map chatId → Agent instances with lifecycle (timeout, cleanup, max limit) | Medium |
| Tool implementations | `web_search`, `read_file`, `write_file`, `bash` (sandboxed) for messaging context | Medium-High |
| Event-to-ExecutionResult bridge | Collect agent events into existing `ExecutionResult` shape for backward compatibility | Low |
| Workspace file injection | Replace unused memory system with OpenClaw-style bootstrap files (AGENTS.md, SOUL.md, etc.) as system prompt source | Medium |

### Requirements

**Acceptance Criteria:**

1. **Agent Loop**: In-process engine uses `Agent` class from pi-agent-core for multi-turn tool-use conversations (not just single `completeSimple` calls)
2. **Tool Calling**: At minimum 3 tools registered and functional: `web_search`, `read_file`, `bash` (with workspace sandboxing)
3. **Session Management**: Agent instances mapped to chat sessions with configurable timeout cleanup, max concurrent session limit, context window pruning
4. **Backward Compatibility**: `IExecutionEngine.execute()` returns `ExecutionResult` as before; streaming is opt-in via optional `onEvent` callback
5. **Safety**: Tool execution is workspace-sandboxed; bash commands restricted via allowlist; max iteration guard on agent loop (configurable, default 50)
6. **Provider Support**: All existing providers work (Anthropic, OpenAI, Google/Gemini, OpenRouter, generic OpenAI-compatible)
7. **Feature Flag**: In-process agent mode controllable via `ENABLE_IN_PROCESS=true` (existing flag)
8. **Error Handling**: Graceful degradation on tool failures, context overflow triggers pruning, agent loop timeout via AbortController

### Q&A

**Q: Do we need the full OpenClaw skills system?**
A: No. Skills are nice-to-have for future. MVP focuses on hardcoded tool set. Skills can be added as a follow-up task.

**Q: Do we need subagent spawning (`sessions_spawn`)?**
A: No for MVP. CC-Bridge's gateway already handles routing. Subagent spawning is out of scope for this task.

**Q: Do we need workspace file injection (AGENTS.md, SOUL.md, etc.)?**
A: Yes. The current memory system is not actively used. Adopt OpenClaw's workspace file injection pattern as the system prompt source. Bootstrap files: AGENTS.md (agent config/behavior), SOUL.md (personality), IDENTITY.md (identity), USER.md (user context), MEMORY.md (long-term memory), TOOLS.md (tool documentation). Load from workspace directory on agent boot, inject into system prompt.

**Q: Should we implement EmbeddedAgent as a separate class?**
A: Yes. Implement `EmbeddedAgent` as a standalone class (independent of the execution engine layer) that encapsulates the full agent lifecycle: pi-agent-core Agent wrapping, workspace injection, tool registration, session management, and event handling. Then wire it into the in-process execution engine as a thin adapter. This separation gives us a reusable agent component that could be used outside the 3-layer engine if needed.

**Q: Do we need JSONL session persistence like OpenClaw?**
A: No. Use SQLite (cc-bridge already has it) or keep sessions in-memory with timeout cleanup. JSONL is OpenClaw-specific.

**Q: Do we need the full tool policy pipeline?**
A: No. A simplified 2-stage policy (global allow/deny + per-chat) is sufficient. The 5-stage pipeline is overkill for a messaging gateway.

**Q: What about streaming to Telegram/Feishu?**
A: Phase 3. MVP collects events into final `ExecutionResult`. Streaming adapter is a separate phase.

### Design

#### Architecture: EmbeddedAgent + Thin Engine Adapter

Implement `EmbeddedAgent` as a standalone, reusable class that encapsulates the full agent lifecycle. Then wire it into the in-process execution engine as a thin adapter.

**Layer separation:**
```
┌─────────────────────────────────────────────────────┐
│  InProcessEngine (IExecutionEngine adapter)         │
│  - Thin adapter: request → EmbeddedAgent → result   │
│  - Feature flag, health check, error mapping        │
├─────────────────────────────────────────────────────┤
│  EmbeddedAgent (standalone, reusable)               │
│  - pi-agent-core Agent wrapping                     │
│  - Workspace file injection (system prompt)         │
│  - Tool registration & policy                       │
│  - Session lifecycle (create/resume/cleanup)        │
│  - Event handling & streaming                       │
├─────────────────────────────────────────────────────┤
│  Workspace (bootstrap files)                        │
│  - AGENTS.md, SOUL.md, IDENTITY.md, USER.md         │
│  - MEMORY.md, TOOLS.md                              │
│  - Loaded on boot, injected into system prompt      │
├─────────────────────────────────────────────────────┤
│  pi-agent-core (Agent, AgentTool, AgentEvent)       │
│  pi-ai (LLM provider abstraction)                   │
└─────────────────────────────────────────────────────┘
```

**Execution flow:**
```
ExecutionRequest
       │
       ▼
InProcessEngine.execute()          ← thin adapter
       │
       ├── Get/create EmbeddedAgent for chatId
       │
       └── embeddedAgent.prompt(userMessage, options)
              │
              ├── Load workspace bootstrap files → system prompt
              │     └── AGENTS.md + SOUL.md + IDENTITY.md + USER.md + MEMORY.md + TOOLS.md
              │
              ├── pi-agent-core Agent.prompt(message)
              │     └── agentLoop runs internally
              │           ├── LLM call (streaming)
              │           ├── Tool execution (if tool_use)
              │           ├── LLM call (with tool results)
              │           └── ... until stop_reason="end_turn"
              │
              ├── Collect events → ExecutionResult
              │     ├── message_end → accumulate text
              │     ├── tool_execution_end → log tool usage
              │     └── agent_end → finalize result
              │
              └── Return ExecutionResult
```

#### EmbeddedAgent Class Interface

```typescript
// src/gateway/engine/embedded-agent.ts
class EmbeddedAgent {
  constructor(config: EmbeddedAgentConfig)

  // Core lifecycle
  prompt(message: string, options?: PromptOptions): Promise<AgentResult>
  steer(message: string): void          // Inject message during execution
  abort(): void                          // Cancel current execution

  // Session management
  getSessionId(): string
  getHistory(): AgentMessage[]
  clearHistory(): void

  // Configuration
  getTools(): AgentTool[]
  getSystemPrompt(): string             // Built from workspace files

  // Events
  on(event: string, handler: Function): void
}

interface EmbeddedAgentConfig {
  sessionId: string
  workspaceDir: string                   // Where bootstrap files live
  provider: string
  model: string
  tools?: AgentTool[]
  maxIterations?: number                 // Default: 50
  timeoutMs?: number                     // Default: 120000
  onEvent?: (event: AgentEvent) => void
}
```

#### Workspace File Injection

```typescript
// src/gateway/engine/workspace.ts
// Replaces the unused memory system

const BOOTSTRAP_FILES = [
  'AGENTS.md',      // Agent configuration, behavior rules
  'SOUL.md',        // Personality, communication style
  'IDENTITY.md',    // Identity, name, role
  'USER.md',        // User context, preferences
  'MEMORY.md',      // Long-term memory, facts
  'TOOLS.md',       // Tool documentation, usage hints
] as const;

function loadWorkspaceBootstrap(workspaceDir: string): string {
  // Read each file if exists, concatenate into system prompt
  // Skip missing files silently
  // Strip YAML frontmatter (---...---)
  // Return combined system prompt string
}
```

#### Key Interface Changes

```typescript
// contracts.ts - additive only (backward compatible)
interface ExecutionOptions {
  // ... existing fields ...
  onEvent?: (event: AgentEvent) => void;  // NEW: optional streaming callback
  agentMode?: boolean;                     // NEW: force agent mode (default: true when in-process)
  maxIterations?: number;                  // NEW: agent loop guard (default: 50)
}
```

#### New Files

```
src/gateway/engine/
├── embedded-agent.ts          ← NEW: EmbeddedAgent class (standalone, reusable)
├── workspace.ts               ← NEW: workspace bootstrap file loading (replaces memory system)
├── in-process.ts              ← REWRITE: thin adapter using EmbeddedAgent
├── agent-sessions.ts          ← NEW: chatId → EmbeddedAgent instance manager
├── event-bridge.ts            ← NEW: AgentEvent → ExecutionResult collector
└── tools/
    ├── index.ts               ← NEW: tool factory
    ├── web-search.ts          ← NEW: web search tool
    ├── read-file.ts           ← NEW: file read tool
    ├── write-file.ts          ← NEW: file write tool
    └── bash.ts                ← NEW: sandboxed bash tool
```

### Plan

#### Phase 1: EmbeddedAgent Core + Workspace Injection (Foundation) — Must Have

**Goal**: Create standalone `EmbeddedAgent` class with workspace file injection, achieving multi-turn text completion via pi-agent-core's agent loop.

1. Create `src/gateway/engine/workspace.ts`:
   - Load bootstrap files from workspace directory: AGENTS.md, SOUL.md, IDENTITY.md, USER.md, MEMORY.md, TOOLS.md
   - Strip YAML frontmatter, skip missing files silently
   - Concatenate into system prompt string
   - Provide default templates for new workspaces (reference: OpenClaw's `docs/reference/templates/`)
2. Create `src/gateway/engine/embedded-agent.ts`:
   - Import `Agent` from `@mariozechner/pi-agent-core`
   - Constructor: accept `EmbeddedAgentConfig` (sessionId, workspaceDir, provider, model, tools, maxIterations, timeoutMs, onEvent)
   - `prompt(message, options)`: run pi-agent-core agent loop, collect events, return `AgentResult`
   - `steer(message)`: inject message during execution
   - `abort()`: cancel via AbortController
   - Implement `convertToLlm()` to transform history format
   - Wire `getApiKey()` using existing `PROVIDER_CONFIGS`
   - Wire `transformContext` hook for context window pruning
   - Build system prompt from workspace bootstrap files
   - Add `maxIterations` guard (default 50)
3. Create `src/gateway/engine/event-bridge.ts`:
   - Subscribe to agent events, accumulate into `ExecutionResult`
   - Forward events to optional `onEvent` callback
4. Create `src/gateway/engine/agent-sessions.ts`:
   - `AgentSessionManager`: chatId → `EmbeddedAgent` instance map with TTL cleanup
   - Configurable max concurrent sessions, idle timeout
5. Rewrite `src/gateway/engine/in-process.ts` as thin adapter:
   - Use `AgentSessionManager` to get/create `EmbeddedAgent` for chatId
   - Delegate to `embeddedAgent.prompt()`, collect result into `ExecutionResult`
6. Update `src/gateway/engine/contracts.ts`:
   - Add `onEvent`, `agentMode`, `maxIterations` to `ExecutionOptions` (optional fields)
7. Verify all existing providers work (Anthropic, OpenAI, Gemini, OpenRouter)
8. Test: agent loop runs, workspace files injected into system prompt, produces text output, respects timeout

**Dependencies**: None
**Files**: New `embedded-agent.ts`, `workspace.ts`, `event-bridge.ts`, `agent-sessions.ts`; rewrite `in-process.ts`; update `contracts.ts`

#### Phase 2: Tool Registration — Must Have

**Goal**: Add 3-4 tools that make the agent useful for messaging users.

1. Create `src/gateway/engine/tools/` directory with tool implementations:
   - `read-file.ts`: Read file contents from workspace directory (path validation, size limit)
   - `write-file.ts`: Write/create files in workspace directory (path validation)
   - `bash.ts`: Execute shell commands with restrictions (command allowlist, workspace sandbox, timeout)
   - `web-search.ts`: Web search via existing infrastructure or simple fetch
2. Create `src/gateway/engine/tools/index.ts`: tool factory that returns `AgentTool[]`
3. Register tools on `EmbeddedAgent` instances via config
4. Add simplified tool policy: global allow/deny list from config (`data/config/gateway.jsonc`)
5. Update TOOLS.md workspace template with tool documentation
6. Test: agent calls tools, receives results, incorporates into response

**Dependencies**: Phase 1
**Files**: New `src/gateway/engine/tools/` directory (4-5 files)

#### Phase 3: Streaming Bridge — Should Have

**Goal**: Real-time streaming of agent responses to Telegram/Feishu.

1. Create chat platform streaming adapter:
   - Map `message_update` events to Telegram `editMessageText` (debounced, 500ms batching)
   - Map `tool_execution_start` to status messages ("Searching the web...", "Reading file...")
   - Respect Telegram rate limits (30 msg/sec per chat)
2. Wire `onEvent` callback from `EmbeddedAgent` through the pipeline
3. Update `agent-bot.ts` to pass streaming callback when available
4. Test: user sees progressive text updates in Telegram

**Dependencies**: Phase 1
**Files**: Extend `event-bridge.ts` (streaming mode), updates to `agent-bot.ts`

#### Phase 4: Session Persistence & Production Hardening — Should Have

**Goal**: Sessions survive process restarts, production-ready session management.

1. Persist `AgentMessage[]` history to SQLite (extend existing `persistence.ts`)
2. Load session history on `EmbeddedAgent` creation (warm start)
3. Implement `transformContext` hook: prune old messages when approaching context limit
4. Add session metrics: turn count, token usage estimation, last activity
5. Add max concurrent sessions limit with LRU eviction
6. Test: session survives restart, context doesn't overflow

**Dependencies**: Phases 1-2
**Files**: `agent-sessions.ts` (extend), `persistence.ts` (extend)

#### Phase 5: Advanced Features — Nice-to-Have (Future Tasks)

- Steering messages: `embeddedAgent.steer()` when user sends new message during execution
- Follow-up queue: batch user messages during agent execution
- Skills system: SKILL.md loading and injection into workspace
- Tool policy pipeline: multi-stage filtering
- Context compaction with LLM summarization
- Workspace file watching (hot reload on file change, reference: OpenClaw's `skills/refresh.ts`)

### Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|-----------|
| **Memory pressure** from Agent instances holding full message history | HIGH | Session timeout cleanup (reuse `context-strategy.ts`), max sessions limit, `transformContext` pruning |
| **Tool execution safety** — bash in messaging context is dangerous | HIGH | Workspace sandboxing, command allowlist, path validation, execution timeout |
| **Agent loop runaway** — tools trigger infinite loops | MEDIUM | `maxIterations` guard (default 50), `AbortController` timeout |
| **Streaming rate limits** — Telegram 30 msg/sec limit | MEDIUM | Debounce/throttle event bridge (batch updates every 500ms) |
| **Bun compatibility** with pi-agent-core | LOW | pi-ai 0.57.1 already works in cc-bridge; Agent class uses same APIs |
| **IExecutionEngine interface breaking** | LOW | All changes are additive (optional fields); non-streaming callers unaffected |

### Artifacts

| Type | Path | Generated By | Date |
|------|------|--------------|------|
| Code Review | (this document) | rd2:super-brain + 4 exploration agents | 2026-03-08 |

### References

#### OpenClaw Source (vendors/openclaw)
- Agent core: `src/agents/pi-embedded-runner/run.ts` (main loop), `attempt.ts` (per-attempt)
- Tools: `src/agents/pi-tools.ts` (registration), `tool-policy-pipeline.ts` (filtering)
- Skills: `src/agents/skills/workspace.ts` (760 LOC orchestrator)
- Sessions: `src/agents/session-dirs.ts`, `session-write-lock.ts`
- Workspace: `src/agents/workspace.ts`, `bootstrap-files.ts`
- Spawning: `src/agents/subagent-spawn.ts`, `subagent-registry.ts`
- Events: `src/infra/agent-events.ts`, `pi-embedded-subscribe.ts`

#### CC-Bridge Source
- Engine: `src/gateway/engine/in-process.ts` (current, 272 lines)
- Orchestrator: `src/gateway/engine/orchestrator.ts` (297 lines)
- Contracts: `src/gateway/engine/contracts.ts` (220 lines)
- Context: `src/gateway/engine/context-strategy.ts` (333 lines)
- Memory: `src/gateway/memory/manager.ts`
- Pipeline: `src/gateway/pipeline/agent-bot.ts`

#### pi-mono Packages
- [@mariozechner/pi-ai](https://github.com/badlogic/pi-mono/tree/main/packages/ai) — LLM API wrapper
- [@mariozechner/pi-agent-core](https://github.com/badlogic/pi-mono/tree/main/packages/agent) — Agent class, AgentTool, AgentEvent, agent loop

---

### Design Validation Report (Pre-Production Architect Review)

**Date**: 2026-03-09
**Reviewer**: super-architect (pre-production validation)
**Confidence**: HIGH (>90%) — API surface fully verified from type declarations

---

#### 1. Confirmed API Surface from pi-agent-core (0.57.1)

##### Agent Class (`@mariozechner/pi-agent-core`)

**Constructor:**
```typescript
new Agent(opts?: AgentOptions)
```

**AgentOptions (verified fields):**
```typescript
interface AgentOptions {
  initialState?: Partial<AgentState>;
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  streamFn?: StreamFn;  // Custom stream function (default: streamSimple)
  sessionId?: string;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  onPayload?: SimpleStreamOptions["onPayload"];
  thinkingBudgets?: ThinkingBudgets;
  transport?: Transport;
  maxRetryDelayMs?: number;
}
```

**Key Methods (verified):**
| Method | Signature | Task Assumption | Status |
|--------|-----------|-----------------|--------|
| `prompt` | `prompt(message: AgentMessage \| AgentMessage[]): Promise<void>` | Assumed returns result | CORRECTION NEEDED |
| `prompt` | `prompt(input: string, images?: ImageContent[]): Promise<void>` | String overload | CONFIRMED |
| `steer` | `steer(m: AgentMessage): void` | Assumed `steer(message: string)` | CORRECTION NEEDED |
| `abort` | `abort(): void` | As assumed | CONFIRMED |
| `subscribe` | `subscribe(fn: (e: AgentEvent) => void): () => void` | Not in task design | ADD TO DESIGN |
| `setSystemPrompt` | `setSystemPrompt(v: string): void` | Not in task, needed | ADD TO DESIGN |
| `setModel` | `setModel(m: Model<any>): void` | Not in task, needed | ADD TO DESIGN |
| `setTools` | `setTools(t: AgentTool<any>[]): void` | Not in task, needed | ADD TO DESIGN |
| `waitForIdle` | `waitForIdle(): Promise<void>` | Not in task, useful | ADD TO DESIGN |
| `followUp` | `followUp(m: AgentMessage): void` | Mentioned in Phase 5 | CONFIRMED |
| `clearMessages` | `clearMessages(): void` | Maps to `clearHistory()` | NAME CORRECTION |
| `replaceMessages` | `replaceMessages(ms: AgentMessage[]): void` | Not in task, useful for session restore | ADD TO DESIGN |
| `continue` | `continue(): Promise<void>` | Not in task, useful for retries | ADD TO DESIGN |
| `state` | `get state(): AgentState` | Not in task, provides messages/tools/model | ADD TO DESIGN |
| `reset` | `reset(): void` | Not in task, full reset | ADD TO DESIGN |

**CRITICAL FINDING: `prompt()` returns `Promise<void>`, NOT a result object.**
The task design assumes `prompt()` returns `Promise<AgentResult>`. In reality, the Agent class is event-driven:
- Call `agent.prompt(message)` to start the agent loop
- Subscribe via `agent.subscribe(fn)` to receive `AgentEvent` objects
- The promise resolves when the agent loop completes (all tool calls done)
- Text output must be collected from events or read from `agent.state.messages`

##### AgentEvent Types (verified)
```typescript
type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean }
```
All 10 event types confirmed. Task mentions `message_start/update/end` and `tool_execution_start/update/end` and `agent_start/end` -- all correct. Task was missing `turn_start` and `turn_end`.

##### AgentTool Interface (verified)
```typescript
interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
  label: string;  // Human-readable label for UI
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>
  ) => Promise<AgentToolResult<TDetails>>;
}

// Base Tool (from pi-ai):
interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters;  // TypeBox schema
}

interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[];
  details: T;
}
```
**Key note:** Parameters use `@sinclair/typebox` (TSchema/Static). This is available as a transitive dependency. Tool implementations need TypeBox schemas for parameter definitions.

##### AgentMessage Type (verified)
```typescript
type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];
// Where Message = UserMessage | AssistantMessage | ToolResultMessage
```
This is extensible via declaration merging. CC-Bridge does NOT need custom message types for MVP.

##### AgentState (verified)
```typescript
interface AgentState {
  systemPrompt: string;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool<any>[];
  messages: AgentMessage[];
  isStreaming: boolean;
  streamMessage: AgentMessage | null;
  pendingToolCalls: Set<string>;
  error?: string;
}
```
Useful for reading current messages, checking streaming status, and error state.

##### Model Type (from pi-ai, verified)
```typescript
interface Model<TApi extends Api> {
  id: string;
  name: string;
  api: TApi;
  provider: Provider;
  baseUrl: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: ...;  // Provider-specific compat settings
}
```
The existing `buildModel()` in `in-process.ts` already constructs this correctly.

---

#### 2. Design Corrections Required

##### CORRECTION 1: EmbeddedAgent.prompt() Must Be Event-Driven (HIGH IMPACT)

**Problem:** The task design has `prompt(message, options): Promise<AgentResult>` but the underlying `Agent.prompt()` returns `Promise<void>`. Results come via events.

**Correction:** The `EmbeddedAgent` class must:
1. Subscribe to events via `agent.subscribe(fn)` BEFORE calling `agent.prompt()`
2. Collect events into an `AgentResult` within the subscription callback
3. Wait for `agent_end` event to know when to resolve
4. Return the collected result after the prompt promise resolves

```typescript
// Corrected flow:
async prompt(message: string): Promise<AgentResult> {
  const collector = new EventCollector();
  const unsub = this.agent.subscribe((event) => {
    collector.handleEvent(event);
    this.config.onEvent?.(event);  // Forward to optional callback
  });

  try {
    await this.agent.prompt(message);  // Returns void when loop completes
    return collector.toResult();       // Build result from collected events
  } finally {
    unsub();
  }
}
```

##### CORRECTION 2: steer() Takes AgentMessage, Not String

**Problem:** Task design has `steer(message: string): void` but actual API is `steer(m: AgentMessage): void`.

**Correction:** `EmbeddedAgent.steer()` must wrap the string into a `UserMessage`:
```typescript
steer(message: string): void {
  this.agent.steer({
    role: "user",
    content: message,
    timestamp: Date.now(),
  });
}
```

##### CORRECTION 3: Agent Configuration Uses Setter Methods, Not Constructor Config

**Problem:** The task design implies model/system-prompt/tools are set via constructor options.

**Correction:** The Agent class uses setter methods after construction:
```typescript
const agent = new Agent({
  convertToLlm: ...,
  transformContext: ...,
  getApiKey: ...,
});
agent.setSystemPrompt(systemPrompt);
agent.setModel(model);
agent.setTools(tools);
```

The `initialState` option in `AgentOptions` could set these via `Partial<AgentState>`, but the setter approach is cleaner and is what OpenClaw uses.

##### CORRECTION 4: clearHistory() Should Be clearMessages()

**Problem:** Task design mentions `clearHistory()` method.

**Correction:** The actual API method is `agent.clearMessages()`.

##### CORRECTION 5: getHistory() Should Use agent.state.messages

**Problem:** Task design mentions `getHistory(): AgentMessage[]`.

**Correction:** Use `agent.state.messages` property getter instead.

---

#### 3. Design Gaps Identified

##### GAP 1: No maxIterations Guard in pi-agent-core

**Finding:** The `Agent` class has NO built-in `maxIterations` limit. The agent loop continues until the LLM stops calling tools (returns `stop` stop reason) or is aborted.

**Mitigation:** The `EmbeddedAgent` must implement its own iteration guard:
```typescript
// In the event subscription:
let turnCount = 0;
const unsub = this.agent.subscribe((event) => {
  if (event.type === "turn_end") {
    turnCount++;
    if (turnCount >= this.config.maxIterations) {
      this.agent.abort();
    }
  }
});
```

##### GAP 2: TypeBox Dependency for Tool Parameters

**Finding:** `AgentTool.parameters` requires `@sinclair/typebox` TSchema objects. TypeBox IS available as a transitive dependency (`node_modules/@sinclair/typebox` exists), but not as a direct dependency in `package.json`.

**Recommendation:** Add `@sinclair/typebox` as a direct dependency, or import `Type` and `TSchema` from `@mariozechner/pi-ai` which re-exports them:
```typescript
import { Type, type TSchema } from "@mariozechner/pi-ai";
```
This is confirmed by pi-ai's index.d.ts: `export type { Static, TSchema } from "@sinclair/typebox"; export { Type } from "@sinclair/typebox";`

##### GAP 3: convertToLlm Implementation Required

**Finding:** The Agent requires a `convertToLlm` function to transform `AgentMessage[]` to `Message[]`. For CC-Bridge, the existing history format is `{sender, text, timestamp}[]` which needs conversion to pi-ai `Message[]`.

**Two conversion layers needed:**
1. **CC-Bridge history to AgentMessage[]** — On session create/restore, convert persisted `{sender, text, timestamp}` to `UserMessage`/`AssistantMessage` via `agent.replaceMessages()`.
2. **AgentMessage[] to LLM Message[]** — The default `convertToLlm` in Agent handles this for standard message types. Custom conversion only needed if CC-Bridge adds custom `AgentMessage` types (not planned for MVP).

**Recommendation:** Use the default `convertToLlm` (do NOT pass it in constructor). The default filters to user/assistant/toolResult messages and converts attachments, which is exactly what's needed.

##### GAP 4: Orchestrator Constructor Change Required

**Finding:** The `ExecutionOrchestrator.initializeEngines()` creates `InProcessEngine` with `(enabled, provider, model)` constructor args. When `InProcessEngine` is rewritten to use `EmbeddedAgent`, its constructor will need additional config (workspace dir, tool list, etc.).

**Recommendation:** Keep the `InProcessEngine` constructor backward compatible. Add a separate config object parameter:
```typescript
constructor(
  enabled: boolean = false,
  defaultProvider?: string,
  defaultModel?: string,
  agentConfig?: { workspaceDir?: string; maxIterations?: number; }
)
```
Or better: accept a full config object with backward-compatible defaults.

##### GAP 5: Workspace Directory Resolution

**Finding:** The `agent-bot.ts` constructs workspace paths as `path.join(this.projectsRoot, workspace)`. The `InProcessEngine` currently does NOT receive the workspace path — it only gets the prompt string and options.

**However:** The `ExecutionOptions` interface already has `workspace?: string` field, and `GATEWAY_CONSTANTS.CONFIG.PROJECTS_ROOT` is accessible. The `EmbeddedAgent` can resolve the full workspace path from these.

##### GAP 6: Missing streamFn Configuration

**Finding:** The `Agent` class defaults to using `streamSimple` from pi-ai. This is correct for direct API calls. No custom `streamFn` is needed for MVP unless proxy support is required.

**Recommendation:** Use default (no streamFn in constructor). This will use `streamSimple` which calls LLM providers directly with the API key from `getApiKey`.

---

#### 4. Recommended Implementation Order for Phase 1

```
Step 1: event-bridge.ts (EventCollector)
  - Implement event collection logic
  - Map AgentEvent → ExecutionResult
  - This is pure logic, no dependencies on Agent
  - Can be unit tested immediately

Step 2: workspace.ts (Workspace Bootstrap)
  - Load bootstrap files
  - Build system prompt string
  - Pure file I/O, independent of Agent
  - Can be unit tested with fixture files

Step 3: embedded-agent.ts (EmbeddedAgent Core)
  - Import Agent from pi-agent-core
  - Wire: constructor → Agent setup (setModel, setSystemPrompt, setTools)
  - Wire: getApiKey using PROVIDER_CONFIGS
  - Wire: prompt() → subscribe + agent.prompt + EventCollector
  - Wire: steer() → agent.steer(UserMessage)
  - Wire: abort() → agent.abort()
  - Wire: maxIterations guard via turn_end counting
  - Depends on Steps 1, 2

Step 4: agent-sessions.ts (Session Manager)
  - chatId → EmbeddedAgent instance map
  - TTL cleanup, max concurrent limit
  - Session restore from persisted history → agent.replaceMessages()
  - Depends on Step 3

Step 5: in-process.ts (Rewrite as Thin Adapter)
  - Replace completeSimple with EmbeddedAgent
  - Get/create EmbeddedAgent via AgentSessionManager
  - Call embeddedAgent.prompt(), return ExecutionResult
  - Depends on Steps 3, 4

Step 6: contracts.ts (Additive Changes)
  - Add onEvent, agentMode, maxIterations to ExecutionOptions
  - Pure type additions, no breaking changes
  - Can be done at any point

Step 7: Integration Testing
  - Verify agent loop runs with real LLM call
  - Verify workspace injection
  - Verify timeout/abort
  - Verify all providers
```

---

#### 5. Additional Files That Need Reading/Modification

| File | Action | Reason |
|------|--------|--------|
| `src/gateway/engine/index.ts` | READ | Check re-exports, may need to export new modules |
| `src/gateway/consts.ts` | READ | `GATEWAY_CONSTANTS.CONFIG.PROJECTS_ROOT` for workspace path resolution |
| `src/gateway/pipeline/agent-bot.ts` | MODIFY (Phase 3) | Wire `onEvent` callback for streaming |
| `package.json` | READ | Verify no missing dependencies for TypeBox |

---

#### 6. Risk Updates

| Risk | Severity | Status | Notes |
|------|----------|--------|-------|
| **prompt() returns void, not result** | HIGH | MITIGATED | Event-driven collection pattern documented above |
| **No built-in maxIterations** | MEDIUM | MITIGATED | turn_end counting + abort() pattern documented |
| **TypeBox dependency** | LOW | MITIGATED | Re-exported from pi-ai, no new dependency needed |
| **convertToLlm not needed** | LOW | RESOLVED | Default handles standard message types |
| **Orchestrator constructor change** | LOW | MITIGATED | Backward-compatible extension approach documented |
| **Memory pressure from Agent instances** | HIGH | UNCHANGED | Session timeout + clearMessages() |
| **Tool execution safety** | HIGH | UNCHANGED | Workspace sandboxing needed in Phase 2 |

---

#### 7. Verdict

**DESIGN IS SOUND WITH CORRECTIONS.** The fundamental architecture (EmbeddedAgent wrapping pi-agent-core Agent, thin InProcessEngine adapter, workspace injection replacing memory system) is validated. The 5 corrections above are implementation-level adjustments, not architectural changes.

The most important correction is that `prompt()` is event-driven (returns void, results via subscribe). This changes the internal implementation of `EmbeddedAgent.prompt()` but does NOT change its external API — it can still return `Promise<AgentResult>` by collecting events internally.

**Ready for implementation: YES, after incorporating the corrections above.**
