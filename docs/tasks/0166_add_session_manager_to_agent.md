---
name: add session manager to agent
description: Task: Add reusable session manager to src/packages/agent/core/
status: Done
created_at: 2026-03-15 10:35:19
updated_at: 2026-03-15 17:11:31
impl_progress:
  planning: completed
  design: completed
  implementation: completed
  review: completed
  testing: completed
---

## 0166. add session manager to agent

### Background

As described in section "11.2 Session Management" of file `docs/06_EMBEDDED_AGENT_SPEC.md`, we need to add a session manager to `src/packages/agent/core/`.

We already have an existing session manager in `src/gateway/engine/agent-sessions.ts` that:
- Maps chatId to EmbeddedAgent instances
- Has TTL cleanup, max concurrent sessions limits
- Uses SQLite persistence via AgentPersistence (gateway-specific)
- Handles warm restarts by loading previous message history
- Does context pruning when approaching context window limits

The problem: the gateway's session manager is tightly coupled to gateway infrastructure:
- Imports `AgentPersistence` from `@/gateway/persistence`
- Uses gateway's SQLite database path
- Has gateway-specific config (cleanup intervals, etc.)

We need to create a **reusable** session manager in `src/packages/agent` that:
1. Is infrastructure-agnostic (not coupled to any backend)
2. Can be used by the gateway or other consumers
3. Provides core session lifecycle management
4. Supports persistence via a pluggable interface

### Requirements

#### Core Functionality

| # | Requirement | Description |
|---|------------|-------------|
| R1 | Session lifecycle | Create, get, remove, dispose sessions by sessionId |
| R2 | TTL-based cleanup | Remove idle sessions after configurable timeout |
| R3 | Max session limits | LRU eviction when session limit is reached |
| R4 | Session metadata | Track createdAt, lastActivityAt, turnCount |
| R5 | Agent factory | Injectable factory for creating agent instances |
| R6 | Pluggable persistence | Interface for save/load operations (not hardcoded to SQLite) |
| R7 | Context pruning | Trim messages before hitting limits using existing compaction |

#### Persistence Interface

| # | Requirement | Description |
|---|------------|-------------|
| R8 | Save session metadata | Store session info (sessionId, timestamps, turnCount) |
| R9 | Load session metadata | Retrieve session info (null if not found) |
| R10 | Delete session | Remove session and its messages |
| R11 | Save message history | Persist agent messages for warm restarts |
| R12 | Load message history | Retrieve persisted messages |
| R13 | Touch session | Lightweight update (turnCount, lastActivityAt) |
| R14 | Cleanup expired | Bulk cleanup of sessions older than TTL |

#### Configuration

| # | Requirement | Description |
|---|------------|-------------|
| R15 | TTL config | Configurable session timeout (default: 30 minutes) |
| R16 | Max sessions | Configurable max concurrent sessions (default: 100) |
| R17 | Cleanup interval | Configurable cleanup timer interval (default: 60 seconds) |
| R18 | Max messages | Configurable max messages per session before pruning (default: 200) |

#### Generic Agent Support

| # | Requirement | Description |
|---|------------|-------------|
| R19 | Generic type | Support any agent type via generic `TAgent` |
| R20 | Factory pattern | Consumer provides factory function to create agents |
| R21 | Agent lifecycle | Consumer controls how agents are disposed |

### Design

#### Architecture

```
src/packages/agent/core/
├── session-manager.ts     # NEW: Reusable SessionManager
├── embedded-agent.ts      # Existing: Single agent wrapper
├── event-bridge.ts       # Existing: Event collection
├── observability.ts      # Existing: Run tracking
├── otel.ts              # Existing: OpenTelemetry
├── workspace.ts         # Existing: Workspace handling
└── context-compaction.ts # Existing: Message compaction

src/gateway/engine/
├── agent-sessions.ts     # EXISTING: Gateway-specific (keep for now)
├── agent-session-adapter.ts  # NEW: Adapter wrapping AgentPersistence
└── agent.ts             # Existing: Gateway entry point
```

#### Core Interfaces

```typescript
// src/packages/agent/core/session-manager.ts

import type { AgentMessage } from "@mariozechner/pi-agent-core";

/**
 * Session metadata stored by the session manager
 */
export interface SessionMetadata {
  sessionId: string;
  createdAt: number;
  lastActivityAt: number;
  turnCount: number;
  provider?: string;
  model?: string;
  workspaceDir?: string;
}

/**
 * Pluggable persistence interface for session state.
 * Implement this to add custom storage (SQLite, Redis, in-memory, etc.)
 */
export interface SessionPersistence {
  /** Save session metadata */
  saveSession(sessionId: string, metadata: SessionMetadata): void;

  /** Load session metadata (returns null if not found) */
  loadSession(sessionId: string): SessionMetadata | null;

  /** Delete session and its messages */
  deleteSession(sessionId: string): void;

  /** Save message history for a session */
  saveMessages(sessionId: string, messages: AgentMessage[]): void;

  /** Load message history for a session */
  loadMessages(sessionId: string): AgentMessage[];

  /** Update session metadata (turn count, last activity) */
  touchSession(sessionId: string, metadata: Partial<SessionMetadata>): void;

  /** Clean up sessions older than ttlMs */
  cleanupExpiredSessions(ttlMs: number): number;

  /** Optional: Close any open connections */
  close?(): void;
}

/**
 * Configuration for SessionManager
 */
export interface SessionManagerConfig {
  /** Session idle timeout in milliseconds (default: 30 minutes) */
  sessionTtlMs?: number;
  /** Maximum concurrent sessions (default: 100) */
  maxSessions?: number;
  /** Cleanup check interval in milliseconds (default: 60 seconds) */
  cleanupIntervalMs?: number;
  /** Maximum messages to keep per session before pruning (default: 200) */
  maxMessagesPerSession?: number;
  /** Optional persistence layer */
  persistence?: SessionPersistence;
  /** Optional compaction config */
  compaction?: CompactionConfig;
}

/**
 * Factory function for creating agent instances.
 * Consumer provides this to instantiate their specific agent type.
 */
export type AgentFactory<TAgent> = (sessionId: string) => TAgent;

/**
 * Session Manager - Core session lifecycle management
 *
 * Features:
 * - Lazy creation of agents on first use
 * - TTL-based cleanup of idle sessions
 * - Max concurrent session limit with LRU eviction
 * - Optional pluggable persistence for warm restarts
 * - Context pruning to prevent overflow
 */
export class SessionManager<TAgent> {
  constructor(config: SessionManagerConfig, createAgent: AgentFactory<TAgent>)

  // Lifecycle
  getOrCreate(sessionId: string): TAgent
  get(sessionId: string): TAgent | undefined
  has(sessionId: string): boolean
  remove(sessionId: string): boolean
  dispose(): void

  // Persistence
  persistSession(sessionId: string, messages?: AgentMessage[]): void

  // Metadata
  getMetadata(sessionId: string): SessionMetadata | null
  get size(): number

  // Cleanup
  startCleanup(intervalMs: number): void
  stopCleanup(): void
}
```

#### Gateway Adapter

```typescript
// src/gateway/engine/agent-session-adapter.ts

import type { SessionPersistence } from "@/packages/agent";
import { AgentPersistence } from "@/gateway/persistence";

/**
 * Gateway-specific adapter that implements SessionPersistence
 * using existing AgentPersistence (SQLite)
 */
export function createGatewaySessionAdapter(config: {
  dbPath?: string;
}): SessionPersistence {
  // Wrapper around AgentPersistence
}
```

### Plan

| Step | Task | Description |
|------|------|-------------|
| 1 | Create session-manager.ts | Implement SessionManager class with all core logic |
| 2 | Export from index.ts | Add exports to `src/packages/agent/index.ts` |
| 3 | Create adapter | Implement `src/gateway/engine/agent-session-adapter.ts` |
| 4 | Update gateway | Integrate adapter into gateway (optional - can keep existing for now) |
| 5 | Write tests | Add unit tests for SessionManager |
| 6 | Update docs | Update 06_EMBEDDED_AGENT_SPEC.md with new section |

### Artifacts

| Type | Path | Generated By |
|------|------|--------------|
| New file | `src/packages/agent/core/session-manager.ts` | Implementation |
| New file | `src/gateway/engine/agent-session-adapter.ts` | Implementation |
| Tests | `src/packages/tests/session-manager.test.ts` | Testing |
| Docs | `docs/06_EMBEDDED_AGENT_SPEC.md` | Documentation |

### References

- Existing implementation: `src/gateway/engine/agent-sessions.ts`
- EmbeddedAgent: `src/packages/agent/core/embedded-agent.ts`
- Context compaction: `src/packages/agent/core/context-compaction.ts`
- Persistence: `src/gateway/persistence.ts`
