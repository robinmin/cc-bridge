# EmbeddedAgent Specification

**Version**: 1.5.0
**Last Updated**: 2026-03-18
**Status**: Production Ready
**Module**: `src/packages/agent/core` (core), `src/gateway/engine/agent.ts` (gateway entry)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
   2.1 [Execution Orchestrator](#21-execution-orchestrator)
   2.1.1 [Package Architecture](#211-package-architecture)
3. [Core Components](#3-core-components)
4. [API Reference](#4-api-reference)
5. [Provider Support](#5-provider-support)
6. [Tool System](#6-tool-system)
7. [Enhanced Tool System](#7-enhanced-tool-system)
8. [Security](#8-security)
9. [Workspace System](#9-workspace-system)
10. [Memory System](#10-memory-system)
11. [Session Management](#11-session-management)
12. [Event Handling](#12-event-handling)
13. [Configuration](#13-configuration)
14. [What's Next](#14-whats-next)

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

### 2.1 Execution Orchestrator

The gateway implements a **3-layer execution engine** with automatic fallback:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        ExecutionOrchestrator                                  │
│                                                                              │
│  Manages layer selection, fallback, health monitoring, and retry logic       │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
           ┌───────────────────────┼───────────────────────┐
           │                       │                       │
           ▼                       ▼                       ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────┐
│   In-Process     │  │    Host IPC      │  │      Container       │
│                  │  │                  │  │                      │
│ EmbeddedAgent    │  │  tmux sessions   │  │  Docker exec + tmux  │
│ (feature-flagged)│  │  on host OS      │  │                      │
│                  │  │                  │  │                      │
│ Default: disabled│  │ Default: enabled │  │ Default: enabled     │
│ Env: ENABLE_IN_  │  │ Env: always      │  │ Env: always         │
│ PROCESS=true     │  │ available        │  │ available           │
└──────────────────┘  └──────────────────┘  └──────────────────────┘
           │                       │                       │
           └───────────────────────┼───────────────────────┘
                                   │
                                   ▼
                        ┌──────────────────────┐
                        │  ExecutionResult     │
                        │  status: completed   │
                        │         | failed     │
                        │         | timeout    │
                        │         | running    │
                        └──────────────────────┘
```

**Layer Order** (tried in sequence until one succeeds):
1. `in-process` - Uses EmbeddedAgent directly (feature-flagged via `ENABLE_IN_PROCESS=true`)
2. `host-ipc` - Executes via tmux sessions on the host OS
3. `container` - Executes via Docker exec with tmux sessions

**Key Features**:
- Automatic fallback when a layer fails
- Health monitoring with periodic checks
- Per-layer retry logic (configurable `maxRetries`)
- Sync/async execution modes

### 2.1.1 Component Diagram

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

The agent functionality is organized into three layers:

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
├── index.ts                 # Main exports
├── agent.ts                 # Consolidated entry point (re-exports from packages/agent)
├── agent-sessions.ts        # Gateway-specific session management
├── in-process.ts           # InProcessEngine (IExecutionEngine)
├── host-ipc.ts             # HostIpcEngine (IExecutionEngine)
├── container.ts            # ContainerEngine (IExecutionEngine)
├── orchestrator.ts         # ExecutionOrchestrator (3-layer management)
├── contracts.ts            # Execution engine interfaces & types
└── tools/                   # Gateway-specific tools

src/gateway/memory/          # Memory system (Phase 5+)
├── index.ts                 # Main exports
├── memory.ts               # Core MemoryManager class
├── manager.ts             # Memory management orchestration
├── bank.ts                # Memory bank (long-term storage)
├── daily-log.ts           # Daily log for events
├── compaction.ts          # Compaction orchestration
├── contracts.ts           # Memory interfaces
├── types.ts               # Memory type definitions
├── policy.ts              # Memory policies
├── tools.ts               # Memory-related tools
├── storage/               # Storage backends
├── indexer/               # Indexing systems (FTS5, embeddings, hybrid)
│   ├── indexer.ts         # Main indexer
│   ├── fts5.ts            # SQLite FTS5 full-text search
│   ├── embeddings.ts      # Embedding-based search
│   ├── hybrid.ts          # Hybrid search fusion
│   └── file-watcher.ts    # File watching for auto-indexing
└── backend-*.ts           # Backend implementations
```

**Design Principles:**
1. **`src/packages/agent`** - Standalone, reusable package that can be used independently
2. **`src/gateway/engine/`** - Gateway's unified entry point with 3-layer execution engine
3. **`src/gateway/memory/`** - Memory system with markdown-first approach (Openclaw-inspired)
4. Gateway code imports from `./engine` or `@/packages/agent` (direct)

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

### 6.3 Tool Sandbox System

The tool sandbox system provides isolation for tool execution using host mode or Docker containers.

**Files**:
- `src/packages/agent/tools/sandbox/config.ts` - Configuration types
- `src/packages/agent/tools/sandbox/validator.ts` - Security validation
- `src/packages/agent/tools/sandbox/policy.ts` - Per-tool policy evaluation
- `src/packages/agent/tools/sandbox/limits.ts` - Resource limits
- `src/packages/agent/tools/sandbox/executor.ts` - Host/Docker executors
- `src/packages/agent/tools/sandbox/network.ts` - Network isolation
- `src/packages/agent/tools/sandbox/browser.ts` - Browser sandbox (CDP)
- `src/packages/agent/tools/sandbox/quota.ts` - Resource quota enforcement

#### Sandbox Modes

| Mode | Description |
|------|-------------|
| `host` | Execute directly on host (default) |
| `docker` | Execute inside Docker container |

#### Sandbox Configuration

```typescript
interface ToolSandboxConfig {
  /** Sandbox mode: 'host' or 'docker' */
  defaultMode: "host" | "docker";
  /** Docker-specific settings */
  docker?: ToolSandboxDockerSettings;
  /** Per-tool policy overrides */
  policies?: ToolSandboxPolicy[];
  /** Resource limits */
  limits?: SandboxLimits;
  /** Resource quota */
  quota?: ResourceQuota;
  /** Network isolation */
  networkIsolation?: NetworkIsolationConfig;
  /** Browser sandbox config */
  browser?: BrowserSandboxConfig;
}
```

#### Security Validation

The validator blocks dangerous Docker configurations:

- Host network mode (security risk)
- Unconfined seccomp profile
- Unconfined AppArmor profile
- Invalid bind mounts (relative paths)
- Sensitive host path warnings (/etc, /var, /usr, /root, /home)

```typescript
const validator = new SandboxSecurityValidator();
const result = validator.validateDockerSettings(settings);
if (!result.valid) {
  throw new Error(result.errors.map(e => e.message).join(", "));
}
```

#### Per-Tool Policy Engine

Each tool can have custom sandbox settings:

```typescript
interface ToolSandboxPolicy {
  /** Glob pattern to match tool names */
  toolPattern: string;
  /** Override mode for matched tools */
  mode?: "host" | "docker";
  /** Custom Docker settings */
  docker?: ToolSandboxDockerSettings;
  /** Resource limits override */
  limits?: SandboxLimits;
  /** Strictness level */
  strictness?: SandboxStrictness;
}
```

#### Resource Limits

```typescript
interface SandboxLimits {
  /** Memory limit (e.g., "512m", "2g") */
  memory?: string;
  /** CPU limit (number of CPUs) */
  cpus?: number;
  /** Maximum processes */
  pids?: number;
}
```

#### Network Isolation

```typescript
interface NetworkIsolationConfig {
  /** Network mode: none, bridge, internal, host, custom */
  mode: "none" | "bridge" | "internal" | "host" | "custom";
  /** Custom network name (for custom mode) */
  networkName?: string;
  /** Allowed ports (for host mode) */
  allowedPorts?: number[];
}
```

#### Browser Sandbox

Browser tools can run in isolated Chrome instances via CDP:

```typescript
interface BrowserSandboxConfig {
  /** Enable browser sandbox */
  enabled: boolean;
  /** Chrome binary path */
  binary?: string;
  /** Remote debugging port */
  port?: number;
  /** Chrome flags for isolation */
  flags?: string[];
}
```

#### Resource Quota Enforcement

```typescript
interface ResourceQuota {
  /** Maximum concurrent tool executions */
  maxConcurrent?: number;
  /** Maximum tools per minute */
  maxPerMinute?: number;
  /** Maximum total execution time (ms) */
  maxTotalTimeMs?: number;
}
```

### 6.4 Registering Tools

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

## 7. Enhanced Tool System

The Enhanced Tool System provides advanced tool management features including permission tiers, JIT elevation, and observability.

### 7.1 Permission Tiers

The tool system implements a hierarchical permission model with four tiers:

```typescript
enum PermissionTier {
  READ = 1,    // Read-only access to non-sensitive resources
  WRITE = 2,   // Write access to workspace files
  EXECUTE = 3, // Execute commands with restrictions
  ADMIN = 4,   // Full administrative access
}
```

Tools declare their required tier in their metadata:

```typescript
{
  name: "bash",
  tierRequirement: {
    minTier: PermissionTier.EXECUTE,
  },
}
```

### 7.2 JIT Permission Elevation

Permissions can be elevated just-in-time for specific operations:

```typescript
const escalation = new PermissionEscalation({
  maxDurationMs: 60000,
  defaultDurationMs: 5000,
});

await escalation.requestEscalation({
  sessionId: "session-123",
  toolName: "bash",
  reason: "Need to run build command",
  requestedTier: PermissionTier.EXECUTE,
  durationMs: 10000,
});
```

### 7.3 Audit Logging

All tool calls are logged with structured audit events:

```typescript
const auditLogger = new AuditLogger(sink, true);
auditLogger.logResult(
  "session-123",
  "bash",
  "execute",
  { command: "ls" },
  "success",
  PermissionTier.EXECUTE,
  false,
);
```

### 7.4 Tool Observability

| Feature | Description |
|---------|-------------|
| **Tool execution tracing** | Track tool call chain for debugging |
| **Per-tool rate limiting** | Configure rate limits at tool level |
| **Tool usage metrics** | Track tool usage patterns for observability |
| **Tool timeout control** | Per-tool timeout configuration |

---

## 8. Security

The Security section covers built-in security features for the agent.

### 8.1 Input Sanitization

User prompts are sanitized before processing to prevent injection attacks.

### 8.2 Tool Permission Escalation

Dynamic tool permissions with time-bounded access:

```typescript
interface PermissionConfig {
  sessionId: string;
  baseTier: PermissionTier;
  escalation?: {
    maxDurationMs: number;
    defaultDurationMs: number;
  };
}
```

### 8.3 Rate Limiting

Per-user and per-session rate limits:

```typescript
interface RateLimitConfig {
  maxPerMinute?: number;
  maxPerHour?: number;
  burstLimit?: number;
}
```

### 8.4 Audit Logging

Comprehensive logging of all agent actions with metadata.

---

## 9. Workspace System

### 9.1 Bootstrap Files

The workspace system loads markdown files in a specific order:

| File | Purpose | Load Order |
|------|---------|------------|
| `AGENTS.md` | Agent configuration, behavior rules | 1 |
| `SOUL.md` | Personality, communication style | 2 |
| `IDENTITY.md` | Identity, name, role | 3 |
| `USER.md` | User context, preferences | 4 |
| `MEMORY.md` | Long-term memory, facts | 5 |
| `TOOLS.md` | Tool documentation, usage hints | 6 |

### 9.2 Skills Discovery

Skills are loaded from:

1. **Workspace-local**: `<workspace>/skills/<skill-name>/SKILL.md`
2. **Hidden folder**: `<workspace>/.agents/skills/<skill-name>/SKILL.md`
3. **User-global**: `~/.agents/skills/<skill-name>/SKILL.md`

### 9.3 Hot Reload

The WorkspaceWatcher monitors bootstrap files for changes and automatically updates the agent's system prompt without restart.

**Features**:
- Debounced reload (500ms default)
- Graceful handling of file creation/deletion
- Logs changes for debugging

---

## 10. Memory System

The gateway implements a comprehensive memory system following Openclaw's markdown-first approach with Pi-mono-style compaction.

### 10.1 Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           MemoryManager                                      │
│  Coordinates memory operations: read, write, search, compaction             │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        │                          │                          │
        ▼                          ▼                          ▼
┌───────────────┐      ┌───────────────────┐      ┌─────────────────┐
│  MemoryBank  │      │   DailyLog        │      │  MemoryIndexer  │
│               │      │                   │      │                 │
│ Long-term    │      │ Event/topic log   │      │ FTS5 + Embedding│
│ storage       │      │ by date           │      │ hybrid search   │
└───────────────┘      └───────────────────┘      └─────────────────┘
        │                          │                          │
        └──────────────────────────┼──────────────────────────┘
                                   │
                                   ▼
                        ┌─────────────────────┐
                        │   StorageBackend    │
                        │                     │
                        │ builtin (SQLite)   │
                        │ external (custom)  │
                        │ none (disabled)     │
                        └─────────────────────┘
```

### 10.2 Memory Backends

The system supports pluggable storage backends:

| Backend | Description |
|---------|-------------|
| `builtin` | SQLite-based storage with FTS5 (default) |
| `external` | External vector store integration |
| `none` | Memory disabled |

### 10.3 Indexing System

The memory indexer provides multiple search capabilities:

| Index Type | Description |
|------------|-------------|
| **FTS5** | SQLite full-text search for keyword matching |
| **Embeddings** | Vector-based semantic search |
| **Hybrid** | Combines FTS5 and embedding search with fusion ranking |

### 10.4 Key Features

- **Markdown-first**: Memories stored as markdown files
- **Auto-indexing**: File watcher automatically indexes new/modified files
- **Token threshold detection**: Automatic compaction when memory exceeds thresholds
- **LLM summarizer**: Context-aware compaction using LLM summarization
- **Memory citations**: Track and cite memory sources in agent responses

### 10.5 Configuration

```typescript
interface MemoryConfig {
  /** Memory backend type */
  backend: "builtin" | "external" | "none";
  /** Enable auto-indexing via file watcher */
  autoIndex?: boolean;
  /** Token threshold for compaction (default: 8000) */
  tokenThreshold?: number;
  /** Maximum memory entries */
  maxEntries?: number;
  /** Citation mode */
  citationMode?: MemoryCitationMode;
}
```

### 10.6 Memory Tools

Agents can interact with memory via tools:

| Tool | Description |
|------|-------------|
| `memory_search` | Search memories using hybrid search |
| `memory_read` | Read specific memory entries |
| `memory_write` | Write new memories |
| `memory_forget` | Delete memories |

---

## 11. Session Management

The agent package provides a reusable `SessionManager` for managing multiple agent instances, plus a gateway-specific `AgentSessionManager` for chat-based sessions.

### 11.1 SessionManager (Reusable)

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

### 11.2 AgentSessionManager (Gateway-Specific)

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

### 11.3 Session Persistence

Sessions can be persisted for:
- Recovery after restarts
- Context continuity across requests
- Cost optimization (reuse existing sessions)

### 11.4 Context Compaction

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

## 12. Event Handling

### 12.1 Event Types

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

### 12.2 Event Callbacks

```typescript
// Called after event collection (batch)
onEvent?: (event: AgentEvent) => void

// Called immediately during event processing (streaming)
onImmediate?: (event: AgentEvent) => void
```

### 12.3 Max Iterations Guard

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

## 13. Configuration

### 13.1 Environment Variables

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

### 13.2 InProcessEngine Usage

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

## 14. What's Next

Future enhancement areas:

| Feature | Description | Priority |
|---------|-------------|----------|
| **RAG pipeline** | Retrieve relevant docs from workspace | High |
| **User preference learning** | Learn and remember user preferences | Low |
| **More providers** | Azure OpenAI, Anthropic Vertex, etc. | Medium |
| **Model routing** | Automatic model selection based on task | Low |
| **Fallback chains** | Retry with different provider on failure | Medium |
| **Tool result caching** | Cache tool results to avoid redundant executions | Medium |
| **Tool retry policy** | Automatic retry with exponential backoff | Low |

---

**Implemented in v1.5.0**: Memory system (FTS5, embeddings, hybrid search), 3-layer execution orchestrator, LLM-powered context compaction. See [Section 10 - Memory System](#10-memory-system) for details.

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
| `src/packages/agent/tools/permission/tiers.ts` | Permission tier definitions |
| `src/packages/agent/tools/permission/evaluator.ts` | Runtime permission evaluation |
| `src/packages/agent/tools/permission/escalation.ts` | JIT permission escalation |
| `src/packages/agent/tools/permission/audit.ts` | Audit logging |
| `src/packages/agent/tools/visibility/tracer.ts` | Tool call tracing |
| `src/packages/agent/tools/visibility/metrics.ts` | Usage metrics collection |
| `src/packages/agent/tools/visibility/rate-limiter.ts` | Per-tool rate limiting |
| `src/packages/agent/tools/sandbox/index.ts` | Sandbox module exports |
| `src/packages/agent/tools/sandbox/config.ts` | Sandbox configuration types |
| `src/packages/agent/tools/sandbox/validator.ts` | Security validation |
| `src/packages/agent/tools/sandbox/policy.ts` | Per-tool sandbox policy |
| `src/packages/agent/tools/sandbox/limits.ts` | Resource limits |
| `src/packages/agent/tools/sandbox/executor.ts` | Host/Docker executors |
| `src/packages/agent/tools/sandbox/network.ts` | Network isolation |
| `src/packages/agent/tools/sandbox/browser.ts` | Browser sandbox (CDP) |
| `src/packages/agent/tools/sandbox/quota.ts` | Resource quota enforcement |

### Gateway Integration (`src/gateway/engine`)

| File | Description |
|------|-------------|
| `src/gateway/engine/index.ts` | Main exports |
| `src/gateway/engine/agent.ts` | Consolidated gateway entry point (re-exports @/packages/agent) |
| `src/gateway/engine/agent-sessions.ts` | AgentSessionManager with SQLite persistence |
| `src/gateway/engine/in-process.ts` | InProcessEngine (IExecutionEngine) |
| `src/gateway/engine/host-ipc.ts` | HostIpcEngine via tmux (IExecutionEngine) |
| `src/gateway/engine/container.ts` | ContainerEngine via Docker/tmux (IExecutionEngine) |
| `src/gateway/engine/orchestrator.ts` | ExecutionOrchestrator (3-layer management) |
| `src/gateway/engine/contracts.ts` | Engine contracts, types, and errors |
| `src/gateway/engine/prompt-utils.ts` | Prompt building utilities |
| `src/gateway/engine/context-strategy.ts` | Context strategy for LLM calls |
| `src/gateway/engine/tools/` | Gateway-specific tools |

### Memory System (`src/gateway/memory`)

| File | Description |
|------|-------------|
| `src/gateway/memory/index.ts` | Main exports |
| `src/gateway/memory/memory.ts` | Core memory manager |
| `src/gateway/memory/manager.ts` | Memory management orchestration |
| `src/gateway/memory/bank.ts` | Long-term memory storage |
| `src/gateway/memory/daily-log.ts` | Daily event/topic logging |
| `src/gateway/memory/compaction.ts` | Compaction orchestration |
| `src/gateway/memory/contracts.ts` | Memory interfaces and types |
| `src/gateway/memory/types.ts` | Memory type definitions |
| `src/gateway/memory/policy.ts` | Memory policies |
| `src/gateway/memory/tools.ts` | Memory-related tools |
| `src/gateway/memory/storage.ts` | Storage abstraction |
| `src/gateway/memory/backend-*.ts` | Backend implementations |
| `src/gateway/memory/indexer/indexer.ts` | Main indexer |
| `src/gateway/memory/indexer/fts5.ts` | SQLite FTS5 full-text search |
| `src/gateway/memory/indexer/embeddings.ts` | Embedding-based search |
| `src/gateway/memory/indexer/hybrid.ts` | Hybrid search fusion |
| `src/gateway/memory/indexer/file-watcher.ts` | File watching for auto-indexing |
