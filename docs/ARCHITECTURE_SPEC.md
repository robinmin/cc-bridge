# Container Agent Architecture Specification

## 1. Executive Summary

This document defines the architectural specification for the next-generation `cc-bridge` Container Agent. The design transitions from a monolithic Python script to a modular, high-performance TypeScript application running on Bun + Hono.

The goal is to create a lightweight, secure, and extensible agent runtime that supports current needs (Phase 1) while establishing the foundation for advanced capabilities like Multi-Agent Chains and Layered Responses (Future Phases).

---

## 2. Phase 1: Foundation (The Optimization)

### 2.1 Core Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| **Runtime** | **Bun** | Ultra-fast startup, native TypeScript, replaces Node.js + Python. |
| **Framework** | **Hono** | Lightweight, web-standard (Request/Response) framework for API & internal logic. |
| **SDK** | **@anthropic-ai/claude-agent-sdk** | Official programmatic control of Claude, replacing brittle CLI parsing. |
| **Docker** | **oven/bun:1-slim** | Reduces image size from >1GB to ~300MB. |

### 2.2 Functional Architecture

```mermaid
graph TD
    Host[Host Bridge Server] <-->|Persistent Stream (IPC)| IpcAdapter[IPC Adapter]
    subgraph Container [Docker Container]
        IpcAdapter --> Router[Hono Router]
        Router --> Controller[Agent Controller]
        Controller -->|Claude Agent SDK| Claude[Claude Code Agent]
        
        subgraph Adapters [Interface Adapters]
            StdinAdapter[Stdin/Stdout]
            HttpAdapter[HTTP Server]
            SocketAdapter[WebSocket (Future)]
        end
        
        IpcAdapter -.-> StdinAdapter
    end
```

### 2.3 IPC Mechanism: Transport Agnostic Design

To prevent "locking in" to a specific IPC method (like `docker exec`), we define a **Transport Adapter Pattern**. The core logic uses standard Request/Response objects (Hono style), and Adapters convert transport-specific protocols into these objects.

**Supported Adapters:**
1.  **Stdio Adapter (Default for Phase 1)**:
    - Reads JSON-RPC or line-delimited JSON from `stdin`.
    - Writes responses to `stdout`.
    - **Pros**: Works reliably via `docker exec -i` (bypasses macOS network/FS issues).
    - **Cons**: Text-based, serial.

2.  **HTTP/WebSocket Adapter (Future Option)**:
    - Exposes an internal port (e.g., 3000).
    - **Pros**: Standard network debugging.
    - **Cons**: Requires port mapping management.

### 2.4 Modular Claude Execution

We abstract the Claude runner into an `AgentRuntime` interface. This allows us to swap the underlying engine without changing the IPC layer.

```typescript
interface AgentRuntime {
  start(options: AgentOptions): Promise<void>;
  sendUserMessage(message: string): Promise<AgentResponse>;
  interrupt(): Promise<void>;
}
```

**Implementation Strategy:**
- **Current**: Wrap `Bun.spawn("claude")` or use `claude-agent-sdk` directly.
- **Future**: Validated "Sandboxed Runtime" or remote execution.

---

## 3. Future Phases: Advanced Capabilities

### 3.1 Chain of Agent Response (Layered Agents)

The architecture supports a "Middleware Chain" pattern where multiple agents can process a request before the final response reaches the user.

**Flow:**
`User Request` -> `[Safety Layer]` -> `[Orchestrator Agent]` -> `[Expert Agent (Claude Code)]` -> `[User Response]`

**Use Case:**
- **Orchestrator**: Decides *which* specific tool or sub-agent should handle the request (e.g., "Code Agent" vs. "Search Agent").
- **Intervention**: A "Safety Agent" can intercept and modify responses before they leave the container.

### 3.2 Dynamic Capability Loading (Plugins/MCP)

The agent will expose a dynamic plugin system compatible with **Model Context Protocol (MCP)**.
- **Dynamic Loading**: Load MCP servers at runtime without rebuilding the container.
- **Hot-Swapping**: Enable/disable capabilities (e.g., "Research Mode" vs "Coding Mode") on the fly via the bridge.

---

## 4. Implementation Logic (Phase 1)

### 4.1 Directory Structure
```
cc_bridge/agents/container/
├── src/
│   ├── adapters/         # IPC Adapters (Stdin, HTTP)
│   ├── core/
│   │   ├── runtime.ts    # AgentRuntime interface & Claude wrapper
│   │   └── router.ts     # Hono app & routing logic
│   └── index.ts          # Entrypoint (detects Adapter to use)
├── package.json
└── tsconfig.json
```

### 4.2 Security Model
- **Container Isolation**: Primary security boundary.
- **Non-Root User**: Run as `bun` (uid 1000).
- **Explicit Permissions**: Even if `--dangerously-skip-permissions` is used, the *Bridge* can enforce a secondary permission layer if needed by intercepting the IPC stream.

## 5. Migration Plan

1.  **Refactor**: Build `cc_bridge/agents/container/` as a standalone Bun+TypeScript project.
2.  **Dockerize**: Update Dockerfile to build this project into the `oven/bun` image.
3.  **Bridge Update**: Update Python host to launch via `docker exec ... bun run start`.
4.  **Verify**: Ensure feature parity (chat, interruptions, context).
