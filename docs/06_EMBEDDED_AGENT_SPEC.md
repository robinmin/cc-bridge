# EmbeddedAgent Specification

**Version**: 1.3.0
**Last Updated**: 2026-03-15
**Status**: Production Ready
**Module**: `src/packages/agent/core` (core), `src/gateway/engine/agent.ts` (gateway entry)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
   2.1.1 [Package Architecture](#211-package-architecture)
3. [Core Components](#3-core-components)
4. [API Reference](#4-api-reference)
5. [Provider Support](#5-provider-support)
6. [Tool System](#6-tool-system)
7. [Workspace System](#7-workspace-system)
8. [Session Management](#8-session-management)
9. [Event Handling](#9-event-handling)
10. [Configuration](#10-configuration)
11. [What's Next](#11-whats-next)

---

## 1. Overview

### 1.1 Purpose

The `EmbeddedAgent` is a standalone, reusable component that wraps the `pi-agent-core` Agent class. It provides a high-level abstraction for embedding AI agents into applications with features including:

- Workspace bootstrap file injection as system prompt
- Event collection and result aggregation
- Max iterations guard to prevent infinite loops
- Timeout handling
- Multi-provider API key resolution
- Workspace file watching for hot reload
- Observability with OpenTelemetry integration (traces, metrics, cost tracking)

### 1.2 Design Philosophy

The EmbeddedAgent was designed with the following corrections from architectural review:

1. **Agent.prompt() returns Promise<void>** - Results are collected via subscribe() + EventCollector
2. **steer() takes AgentMessage, not string** - Wraps string into UserMessage format
3. **Agent uses setter methods** - setSystemPrompt, setModel, setTools instead of constructor config
4. **clearHistory() -> clearMessages()** - API alignment with pi-agent-core
5. **No built-in maxIterations** - Implemented via turn_end event counting + abort()

### 1.3 Position in Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    CC-Bridge Gateway                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              InProcessEngine                              │   │
│  │         (implements IExecutionEngine)                     │   │
│  └──────────────────────┬──────────────────────────────────┘   │
│                         │                                       │
│  ┌──────────────────────▼──────────────────────────────────┐   │
│  │           AgentSessionManager                            │   │
│  │      (per-chat agent instances, persistence)             │   │
│  └──────────────────────┬──────────────────────────────────┘   │
│                         │                                       │
│  ┌──────────────────────▼──────────────────────────────────┐   │
│  │              EmbeddedAgent                                │   │
│  │    (core agent wrapper with workspace + events)          │   │
│  └──────────────────────┬──────────────────────────────────┘   │
│                         │                                       │
│  ┌──────────────────────▼──────────────────────────────────┐   │
│  │            pi-agent-core (Agent)                         │   │
│  │        (LLM provider abstraction)                        │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Architecture

### 2.1 Component Diagram

```
┌────────────────────────────────────────────────────────────────────────┐
│                         EmbeddedAgent                                   │
├────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────────┐  │
│  │ EmbeddedAgent   │    │ EventCollector │    │ WorkspaceWatcher    │  │
│  │                 │    │                 │    │                     │  │
│  │ - config        │───▶│ - turnCount    │    │ - debounceMs        │  │
│  │ - agent         │    │ - toolCalls    │    │ - onReload callback │  │
│  │ - systemPrompt  │    │ - output       │    │ - fs.watch          │  │
│  │ - initialized   │    │ - aborted      │    │                     │  │
│  │ - promptRunning │    │                │    │                     │  │
│  │ - observability │    │                │    │                     │  │
│  │ - otelService  │    │                │    │                     │  │
│  └────────┬────────┘    └────────┬────────┘    └──────────┬────────┘  │
│           │                       │                       │            │
│           ▼                       ▼                       ▼            │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    pi-agent-core Agent                            │   │
│  │  - subscribe(event)    - prompt(message)    - steer(message)   │   │
│  │  - abort()             - setSystemPrompt()  - setTools()       │   │
│  │  - setModel()         - clearMessages()    - waitForIdle()    │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─────────────────┐    ┌─────────────────────────────────────────┐    │
│  │ Observability   │    │ OTEL Service (optional)                 │    │
│  │                 │    │                                         │    │
│  │ - run tracking  │──▶│ - Traces: spans for runs/tools/LLM    │    │
│  │ - usage stats   │    │ - Metrics: tokens, cost, duration     │    │
│  │ - error categor │    │ - OTLP export to collector            │    │
│  └─────────────────┘    └─────────────────────────────────────────┘    │
│                                                                         │
└────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Data Flow

```
User Request
    │
    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  prompt(message, options)                                           │
│  ├── Validate: Check if already running (throw if yes)              │
│  ├── Initialize: Load workspace bootstrap if not initialized         │
│  ├── Create EventCollector with maxIterations guard                  │
│  ├── Subscribe to agent events                                       │
│  ├── Set up timeout via AbortController                              │
│  ├── Call agent.prompt(message)                                     │
│  │    └── Agent loops: LLM → Tool Execution → LLM → ...            │
│  │        └── Events emitted: turn_end, message_end, tool_*, etc.  │
│  │        └── EventCollector handles each event                      │
│  │        └── If turnCount >= maxIterations → abort()               │
│  ├── Collect result from EventCollector                              │
│  └── Return AgentResult                                             │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2.1.1 Package Architecture

The agent functionality is organized into two layers:

```
src/packages/agent/           # Reusable agent package
├── core/                    # Core agent functionality
│   ├── embedded-agent.ts    # Core EmbeddedAgent class
│   ├── event-bridge.ts      # EventCollector
│   ├── observability.ts     # Run tracking, usage stats, error categorization
│   ├── otel.ts             # OpenTelemetry service integration
│   ├── session-manager.ts  # Generic session lifecycle management
│   ├── workspace.ts         # Workspace loading & watching
│   └── context-compaction.ts # LLM-powered compaction
└── tools/                   # Built-in tools & policies

src/gateway/engine/           # Gateway integration
├── agent.ts                 # Consolidated entry point (re-exports from packages/agent)
└── agent-sessions.ts        # Gateway-specific session management (uses SessionManager)
```

**Design Principles:**
1. **`src/packages/agent`** - Standalone, reusable package that can be used independently
2. **`src/gateway/engine/agent.ts`** - Gateway's unified entry point, re-exports from the package
3. Gateway code imports from `./agent` (gateway path) or `@/packages/agent` (direct)

---

## 3. Core Components

### 3.1 EmbeddedAgent Class

The main class that wraps pi-agent-core Agent.

**File**: `src/packages/agent/core/embedded-agent.ts`

**Key Properties**:
| Property | Type | Description |
|----------|------|-------------|
| `agent` | `Agent` | The underlying pi-agent-core Agent instance |
| `config` | `EmbeddedAgentConfig` | Configuration for this agent instance |
| `systemPrompt` | `string` | Current system prompt (from workspace files) |
| `initialized` | `boolean` | Whether initialize() has been called |
| `promptRunning` | `boolean` | Whether a prompt is currently executing |
| `followUpQueue` | `string[]` | Queued messages for next execution |
| `watcher` | `WorkspaceWatcher \| null` | File watcher for hot reload |
| `observability` | `EmbeddedAgentObservabilitySnapshot` | Internal observability state |
| `observabilityConfig` | `EmbeddedAgentObservabilityConfig` | Observability configuration |
| `otelService` | `AgentOtelService \| null` | OpenTelemetry service (if configured) |

### 3.2 EventCollector Class

Collects agent events into a structured result.

**File**: `src/packages/agent/core/event-bridge.ts`

**Collected Events**:
| Event Type | Action |
|------------|--------|
| `turn_end` | Increment turnCount; check maxIterations |
| `message_end` | Extract text and append to output |
| `tool_execution_end` | Record tool call in toolCalls array |
| `agent_end` | Capture final messages |

### 3.3 WorkspaceWatcher Class

Watches workspace bootstrap files for changes and triggers hot reload.

**File**: `src/packages/agent/core/workspace.ts`

**Features**:
- Debounced reload (default 500ms)
- Watches both individual files and directory
- Handles file creation/deletion

### 3.4 Observability System

The observability system provides detailed tracking of agent runs with OpenTelemetry integration.

**Files**:
- `src/packages/agent/core/observability.ts` - Core observability functions
- `src/packages/agent/core/otel.ts` - OpenTelemetry service

**Features**:
- **Run Tracking**: Unique run IDs, start/end timestamps, prompt length
- **Usage Statistics**: Input/output tokens, cache read/write, estimated cost
- **Error Categorization**: timeout, max_iterations, api_error, tool_error, aborted
- **OpenTelemetry**: Spans for agent runs, tool executions, LLM calls; metrics for tokens/cost/duration

**Configuration**:
```typescript
interface EmbeddedAgentConfig {
  // ... other fields
  observability?: EmbeddedAgentObservabilityConfig;
  otel?: AgentOtelConfig;
}
```

**OTEL Configuration**:
```typescript
interface AgentOtelConfig {
  enabled?: boolean;           // Default: false
  endpoint?: string;          // OTLP endpoint (e.g., http://localhost:4318)
  protocol?: "http/protobuf"; // Default: http/protobuf
  serviceName?: string;       // Default: cc-bridge-agent
  sampleRate?: number;        // 0-1, Default: 1.0
  traces?: boolean;          // Default: true
  metrics?: boolean;          // Default: true
  flushIntervalMs?: number;   // Default: 60000
  headers?: Record<string, string>;
}
```

**Environment Variables**:
| Variable | Description |
|----------|-------------|
| `OTEL_ENABLED` | Enable OTEL (set to "true") |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP endpoint URL |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | Protocol (http/protobuf) |
| `OTEL_SERVICE_NAME` | Service name for traces |
| `OTEL_SAMPLE_RATE` | Sample rate (0-1) |

---

## 4. API Reference

### 4.1 EmbeddedAgent Methods

```typescript
class EmbeddedAgent {
  // === Lifecycle ===

  constructor(config: EmbeddedAgentConfig)
  // Creates a new EmbeddedAgent instance
  // Note: Does NOT initialize - call initialize() explicitly

  async initialize(): Promise<void>
  // Initializes the agent by:
  // - Validating API key availability
  // - Loading workspace bootstrap files
  // - Setting system prompt
  // - Starting workspace file watcher
  // Idempotent - safe to call multiple times

  dispose(): void
  // Clean up resources (watchers, etc.)

  // === Execution ===

  async prompt(message: string, options?: PromptOptions): Promise<AgentResult>
  // Send a prompt and collect the result
  // Throws if another prompt is already running
  // Returns: { output, turnCount, aborted, toolCalls, messages }

  steer(message: string): void
  // Inject a steering message during execution
  // Wraps string into UserMessage format

  abort(): void
  // Abort the current agent execution

  // === State ===

  isRunning(): boolean
  // Check if a prompt is currently running

  getSessionId(): string
  // Get the current session ID

  getSystemPrompt(): string
  // Get the current system prompt

  getMessages(): AgentMessage[]
  // Get the agent's current message history

  clearMessages(): void
  // Clear the agent's message history

  // === Tools ===

  getTools(): AgentTool<unknown>[]
  // Get registered tools

  setTools(tools: AgentTool<unknown>[]): void
  // Update tools on the agent

  // === Utilities ===

  queueFollowUp(message: string): void
  // Queue a follow-up message to be delivered after current execution

  drainFollowUpQueue(): string[]
  // Drain queued follow-up messages after prompt completes

  async waitForIdle(): Promise<void>
  // Wait for the agent to become idle

  // === Observability ===

  getObservabilitySnapshot(): EmbeddedAgentObservabilitySnapshot
  // Get cumulative per-session observability metrics
}
```

### 4.2 Configuration Types

```typescript
interface EmbeddedAgentConfig {
  /** Unique session identifier */
  sessionId: string;
  /** Absolute path to workspace directory containing bootstrap files */
  workspaceDir: string;
  /** LLM provider name (e.g., "anthropic", "openai", "google") */
  provider: string;
  /** LLM model identifier (e.g., "claude-sonnet-4-6") */
  model: string;
  /** Tools to register on the agent */
  tools?: AgentTool<unknown>[];
  /** Optional observability hooks and tracing adapter */
  observability?: EmbeddedAgentObservabilityConfig;
  /** OpenTelemetry configuration */
  otel?: AgentOtelConfig;
}

interface PromptOptions {
  /** Maximum agent loop iterations before abort (default: 50) */
  maxIterations?: number;
  /** Request timeout in milliseconds (default: 120000) */
  timeoutMs?: number;
  /** Optional callback for streaming events (fires after collection) */
  onEvent?: (event: AgentEvent) => void;
  /** Optional callback for immediate streaming (fires during collection) */
  onImmediate?: (event: AgentEvent) => void;
}

interface AgentResult {
  /** Final text output concatenated from all assistant messages */
  output: string;
  /** Number of turns (LLM call + tool execution rounds) completed */
  turnCount: number;
  /** Whether the agent was aborted (timeout or maxIterations) */
  aborted: boolean;
  /** Tool calls that were executed during the run */
  toolCalls: ToolCallRecord[];
  /** Final messages from the agent */
  messages: AgentMessage[];
  /** Observability data for this run */
  observability?: AgentRunObservability;
}
```

---

## 5. Provider Support

### 5.1 Built-in Providers

The EmbeddedAgent supports multiple LLM providers via the `PROVIDER_CONFIGS` map:

| Provider | API Key Env Var | API Type |
|----------|-----------------|----------|
| `anthropic` | `ANTHROPIC_API_KEY` | anthropic-messages |
| `openai` | `OPENAI_API_KEY` | openai-completions |
| `google` | `GOOGLE_API_KEY` or `GEMINI_API_KEY` | google-generative-ai |
| `gemini` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | google-generative-ai |
| `openrouter` | `OPENROUTER_API_KEY` | openai-completions |

### 5.2 Custom Provider Configuration

For providers not in the built-in list, the system falls back to:
- `LLM_API_KEY` or `API_KEY` environment variables
- `LLM_BASE_URL` for custom endpoint

### 5.3 API Key Resolution

```typescript
resolveProviderApiKey(provider: string): string | undefined
// Returns the API key for a given provider
// 1. Try provider-specific config
// 2. Fall back to LLM_API_KEY
// 3. Fall back to API_KEY
// Returns undefined if no key found
```

---

## 6. Tool System

### 6.1 Built-in Tools

The EmbeddedAgent can use tools from the tools module:

| Tool | File | Description |
|------|------|-------------|
| `bash` | `src/packages/agent/tools/bash.ts` | Execute shell commands |
| `read_file` | `src/packages/agent/tools/read-file.ts` | Read files from workspace |
| `write_file` | `src/packages/agent/tools/write-file.ts` | Write files to workspace |
| `web_search` | `src/packages/agent/tools/web-search.ts` | Search the web |

### 6.2 Tool Policy System

Tools can be filtered using the policy system:

```typescript
// Policy types available
- GlobalToolPolicy     // Allow/deny by name patterns
- ChatToolPolicy       // Per-chat policies
- ToolGranularPolicy   // Fine-grained tool control
- ToolPolicyPipeline   // Chain multiple policies
```

### 6.3 Registering Tools

```typescript
// Via constructor
const agent = new EmbeddedAgent({
  sessionId: "my-session",
  workspaceDir: "/path/to/workspace",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  tools: [myTool1, myTool2],
});

// Via setter
agent.setTools([newTool1, newTool2]);
```

---

## 7. Workspace System

### 7.1 Bootstrap Files

The workspace system loads markdown files in a specific order:

| File | Purpose | Load Order |
|------|---------|------------|
| `AGENTS.md` | Agent configuration, behavior rules | 1 |
| `SOUL.md` | Personality, communication style | 2 |
| `IDENTITY.md` | Identity, name, role | 3 |
| `USER.md` | User context, preferences | 4 |
| `MEMORY.md` | Long-term memory, facts | 5 |
| `TOOLS.md` | Tool documentation, usage hints | 6 |

### 7.2 Skills Discovery

Skills are loaded from:

1. **Workspace-local**: `<workspace>/skills/<skill-name>/SKILL.md`
2. **Hidden folder**: `<workspace>/.agents/skills/<skill-name>/SKILL.md`
3. **User-global**: `~/.agents/skills/<skill-name>/SKILL.md`

### 7.3 Hot Reload

The WorkspaceWatcher monitors bootstrap files for changes and automatically updates the agent's system prompt without restart.

**Features**:
- Debounced reload (500ms default)
- Graceful handling of file creation/deletion
- Logs changes for debugging

---

## 8. Session Management

The agent package provides a reusable `SessionManager` for managing multiple agent instances, plus a gateway-specific `AgentSessionManager` for chat-based sessions.

### 8.1 SessionManager (Reusable)

The `SessionManager` in `src/packages/agent/core/session-manager.ts` is a generic, reusable session manager that can work with any agent type:

```typescript
// Configuration
interface SessionManagerConfig {
  sessionTtlMs?: number;           // Session idle timeout (default: 30 min)
  maxSessions?: number;            // Max concurrent sessions (default: 100)
  cleanupIntervalMs?: number;      // Cleanup timer interval (default: 60 sec)
  maxMessagesPerSession?: number; // Max messages before pruning (default: 200)
  persistence?: SessionPersistence;
  compaction?: CompactionConfig;
}

// Generic agent interface
interface SessionAgent {
  getMessages(): AgentMessage[];
  clearMessages(): void;
  abort(): void;
  dispose(): void;
}

// Session manager
class SessionManager<TAgent extends SessionAgent> {
  constructor(config: SessionManagerConfig, createAgent: (id: string) => TAgent)

  getOrCreate(sessionId: string): TAgent
  get(sessionId: string): TAgent | undefined
  has(sessionId: string): boolean
  remove(sessionId: string): boolean
  dispose(): void

  persistSession(sessionId: string, messages?: AgentMessage[]): void
  getMetadata(sessionId: string): SessionMetadata | null
  get size(): number

  startCleanup(intervalMs: number): void
  stopCleanup(): void
  needsCompaction(sessionId: string): boolean
}
```

**Key Features:**
- Generic `TAgent` type - works with any agent implementation
- TTL-based cleanup of idle sessions
- LRU eviction when max sessions reached
- Optional pluggable persistence
- Context pruning using existing compaction

**Pluggable Persistence:**
```typescript
interface SessionPersistence {
  saveSession(sessionId: string, metadata: SessionMetadata): void;
  loadSession(sessionId: string): SessionMetadata | null;
  deleteSession(sessionId: string): void;
  saveMessages(sessionId: string, messages: AgentMessage[]): void;
  loadMessages(sessionId: string): AgentMessage[];
  touchSession(sessionId: string, metadata: Partial<SessionMetadata>): void;
  cleanupExpiredSessions(ttlMs: number): number;
  close?(): void;
}
```

### 8.2 AgentSessionManager (Gateway-Specific)

The gateway uses its own `AgentSessionManager` built on top of `SessionManager`:

```typescript
class AgentSessionManager {
  getOrCreate(chatId: string | number, config: EmbeddedAgentConfig): EmbeddedAgent
  has(chatId: string | number): boolean
  get(chatId: string | number): EmbeddedAgent | undefined
  remove(chatId: string | number): boolean
  persistSession(chatId: string | number): void
  isRunning(chatId: string | number): boolean
  steerOrQueue(chatId: string | number, message: string): "steered" | "queued" | "not-running"
  dispose(): void
}
```

### 8.3 Session Persistence

Sessions can be persisted for:
- Recovery after restarts
- Context continuity across requests
- Cost optimization (reuse existing sessions)

### 8.4 Context Compaction

For long-running sessions, context compaction can summarize old messages:

```typescript
interface CompactionConfig {
  enabled: boolean;
  threshold: number;      // Ratio of messages to trigger compaction
  preserveRecent: number;  // Number of recent messages to keep
  summaryPrompt?: string; // Custom prompt for summarization
}
```

---

## 9. Event Handling

### 9.1 Event Types

The EmbeddedAgent emits/receives these event types from pi-agent-core:

| Event | Description |
|-------|-------------|
| `agent_start` | Agent started |
| `turn_start` | New turn started |
| `message_start` | New message started |
| `message_update` | Message content updated |
| `message_end` | Message completed |
| `tool_execution_start` | Tool execution started |
| `tool_execution_update` | Tool output updated |
| `tool_execution_end` | Tool execution completed |
| `turn_end` | Turn completed |
| `agent_end` | Agent finished |

### 9.2 Event Callbacks

```typescript
// Called after event collection (batch)
onEvent?: (event: AgentEvent) => void

// Called immediately during event processing (streaming)
onImmediate?: (event: AgentEvent) => void
```

### 9.3 Max Iterations Guard

The EventCollector tracks `turn_end` events and triggers abortion when `turnCount >= maxIterations`:

```typescript
const collector = new EventCollector({
  maxIterations: 50,  // Default
  onMaxIterations: () => {
    agent.abort();  // Stop execution
  },
});
```

---

## 10. Configuration

### 10.1 Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | * | Anthropic API key |
| `OPENAI_API_KEY` | * | OpenAI API key |
| `GOOGLE_API_KEY` | * | Google AI API key |
| `GEMINI_API_KEY` | * | Gemini API key |
| `OPENROUTER_API_KEY` | * | OpenRouter API key |
| `LLM_PROVIDER` | | Default provider (default: "anthropic") |
| `LLM_MODEL` | | Default model (default: "claude-sonnet-4-6") |
| `LLM_API_KEY` | | Fallback API key |
| `LLM_BASE_URL` | | Custom endpoint URL |

### 10.2 InProcessEngine Usage

```typescript
const engine = new InProcessEngine(
  true,                          // enabled
  "anthropic",                  // defaultProvider
  "claude-sonnet-4-6",          // defaultModel
  { sessionConfig }              // AgentSessionManagerConfig
);

const result = await engine.execute({
  prompt: "Hello, agent!",
  options: {
    chatId: "chat-123",
    workspace: "my-project",
    timeout: 120000,
    maxIterations: 50,
    toolPolicy: { /* policy config */ },
    onEvent: (event) => { /* handle event */ },
    onImmediate: (event) => { /* stream event */ },
  },
});
```

---

## 11. What's Next

Based on the current implementation, here are potential areas for future enhancement:

### 11.1 Enhanced Tool System

| Feature | Description | Priority |
|---------|-------------|----------|
| **Tool result caching** | Cache tool results to avoid redundant executions | Medium |
| **Tool timeout control** | Per-tool timeout configuration | Medium |
| **Tool retry policy** | Automatic retry with exponential backoff | Low |
| **Tool sandboxing** | Execute tools in isolated containers | Low |

### 11.2 Memory & Context

| Feature | Description | Priority |
|---------|-------------|----------|
| **Vector store integration** | Store and retrieve memories using embeddings | High |
| **RAG pipeline** | Retrieve relevant docs from workspace | High |
| **Long-term memory** | Persistent memory across sessions | Medium |
| **User preference learning** | Learn and remember user preferences | Low |

### 11.4 Provider & Model

| Feature | Description | Priority |
|---------|-------------|----------|
| **More providers** | Azure OpenAI, Anthropic Vertex, etc. | Medium |
| **Model routing** | Automatic model selection based on task | Low |
| **Fallback chains** | Retry with different provider on failure | Medium |

### 11.6 Security

| Feature | Description | Priority |
|---------|-------------|----------|
| **Input sanitization** | Sanitize user prompts | High |
| **Tool permission escalation** | Dynamic tool permissions | High |
| **Rate limiting** | Per-user, per-session rate limits | Medium |
| **Audit logging** | Log all agent actions | Medium |

---

## Appendix: File Reference

### Core Package (`src/packages/agent`)

| File | Description |
|------|-------------|
| `src/packages/agent/index.ts` | Main package exports |
| `src/packages/agent/core/embedded-agent.ts` | Main EmbeddedAgent class |
| `src/packages/agent/core/event-bridge.ts` | EventCollector for result aggregation |
| `src/packages/agent/core/observability.ts` | Run tracking, usage stats, error categorization |
| `src/packages/agent/core/otel.ts` | OpenTelemetry service integration |
| `src/packages/agent/core/session-manager.ts` | Generic session lifecycle management |
| `src/packages/agent/core/workspace.ts` | Workspace bootstrap loading and watching |
| `src/packages/agent/core/context-compaction.ts` | LLM-powered context compaction |
| `src/packages/agent/tools/index.ts` | Tool factory functions |
| `src/packages/agent/tools/policy.ts` | Tool policy system |
| `src/packages/agent/tools/bash.ts` | Bash tool implementation |
| `src/packages/agent/tools/read-file.ts` | Read file tool |
| `src/packages/agent/tools/write-file.ts` | Write file tool |
| `src/packages/agent/tools/web-search.ts` | Web search tool |

### Gateway Integration (`src/gateway/engine`)

| File | Description |
|------|-------------|
| `src/gateway/engine/agent.ts` | Consolidated gateway entry point |
| `src/gateway/engine/agent-sessions.ts` | Session management |
| `src/gateway/engine/in-process.ts` | InProcessEngine adapter |
| `src/gateway/engine/orchestrator.ts` | Execution orchestrator |
| `src/gateway/engine/contracts.ts` | Engine contracts and types |
