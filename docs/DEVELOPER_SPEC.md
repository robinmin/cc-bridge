# CC-Bridge Developer Specification

**Version**: 2.2.0
**Last Updated**: 2026-02-21
**Status**: Production Ready

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [System Components](#3-system-components)
4. [Data Flow](#4-data-flow)
5. [Module Reference](#5-module-reference)
6. [API Reference](#6-api-reference)
7. [Testing Strategy](#7-testing-strategy)
8. [Development Workflow](#8-development-workflow)
9. [Maintenance Guide](#9-maintenance-guide)
10. [Extension Guide](#10-extension-guide)

---

## 1. Overview

### 1.1 Purpose

CC-Bridge is a **Bun/Hono-based** Telegram bot bridge that enables remote interaction with Claude Code. It provides bidirectional communication between Telegram users and Claude Code through a containerized agent with multiple IPC transport options.

### 1.2 Technology Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **Runtime** | Bun | Fast JavaScript runtime |
| **Web Framework** | Hono | Lightweight HTTP server |
| **Database** | SQLite (bun:sqlite) | Message persistence |
| **Container** | Docker | Agent isolation |
| **Testing** | Bun test | Test framework |
| **Linting** | Biome | Code quality |
| **Type Checking** | TypeScript | Type safety |

### 1.3 Design Principles

1. **Multi-Mode IPC**: Factory pattern with TCP, Unix socket, Docker exec
2. **Circuit Breaker**: Resilience pattern for fault tolerance
3. **Chain of Responsibility**: Bot pipeline for request routing
4. **Service Layer**: Modular services for cross-cutting concerns
5. **Plaintext Logging**: Clean log format for better DX

---

## 2. Architecture

### 2.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CC-Bridge System                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    Gateway Service (Bun/Hono)                │  │
│  │  ┌────────────────────────────────────────────────────────┐  │  │
│  │  │  HTTP Logging Middleware (Plaintext Format)           │  │  │
│  │  └────────────┬───────────────────────────────────────────┘  │  │
│  │               │                                                │  │
│  │  ┌────────────▼───────────────────────────────────────────┐  │  │
│  │  │  Bot Pipeline (MenuBot → HostBot → AgentBot)          │  │  │
│  │  └────────────┬───────────────────────────────────────────┘  │  │
│  │               │                                                │  │
│  │  ┌────────────▼───────────────────────────────────────────┐  │  │
│  │  │  Services Layer                                        │  │  │
│  │  │  - FileCleanupService                                   │  │  │
│  │  │  - IdempotencyService                                   │  │  │
│  │  │  - RateLimitService                                    │  │  │
│  │  │  - SessionPoolService                                   │  │  │
│  │  │  - TmuxManager                                         │  │  │
│  │  └────────────┬───────────────────────────────────────────┘  │  │
│  └───────────────┼───────────────────────────────────────────────┘  │
│                  │                                                    │
│  ┌───────────────▼───────────────────────────────────────────────┐  │
│  │                    IPC Factory                                │  │
│  │  ┌────────────────────────────────────────────────────────┐  │  │
│  │  │  Circuit Breaker Wrapper                               │  │  │
│  │  │  ┌──────────┬──────────┬────────────────┐              │  │  │
│  │  │  │   TCP    │  Unix   │  Docker Exec   │              │  │  │
│  │  │  │  Client  │  Client │    Client      │              │  │  │
│  │  │  └──────────┴──────────┴────────────────┘              │  │  │
│  │  └────────────────────────────────────────────────────────┘  │  │
│  └───────────────┬───────────────────────────────────────────────┘  │
└──────────────────┼──────────────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────────────┐
│                    Docker Container                                 │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │              Agent Runtime (Bun/Hono)                        │  │
│  │  ┌────────────────────────────────────────────────────────┐  │  │
│  │  │  Modes: TCP (3001) | Unix Socket | Stdio | HTTP        │  │  │
│  │  └────────────┬───────────────────────────────────────────┘  │  │
│  │               │                                                │  │
│  │  ┌────────────▼───────────────────────────────────────────┐  │  │
│  │  │  Command Executor (claude CLI)                        │  │  │
│  │  └────────────┬───────────────────────────────────────────┘  │  │
│  │               │                                                │  │
│  │  ┌────────────▼───────────────────────────────────────────┐  │  │
│  │  │  Tmux Session Manager                                  │  │  │
│  │  └────────────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 Directory Structure

```
src/
├── gateway/                    # Gateway service
│   ├── channels/               # Channel adapters
│   │   ├── telegram.ts         # Telegram client
│   │   └── feishu.ts           # Feishu/Lark client
│   ├── routes/                 # HTTP routes
│   │   ├── webhook.ts          # Channel webhooks + legacy unified
│   │   ├── health.ts           # Health checks
│   │   └── claude-callback.ts  # Agent callback endpoint
│   ├── pipeline/               # Bot pipeline
│   │   ├── agent-bot.ts        # Claude execution
│   │   ├── host-bot.ts         # Host management
│   │   └── menu-bot.ts         # Slash commands
│   ├── services/               # Business services
│   │   ├── claude-executor.ts  # Claude execution logic
│   │   ├── discovery-cache.ts  # Plugin discovery cache
│   │   ├── broadcast.ts        # Multi-channel target resolution
│   │   ├── tmux-manager.ts     # Tmux session management
│   │   ├── file-cleanup.ts     # File cleanup service
│   │   ├── filesystem-ipc.ts   # IPC file handling
│   │   ├── file-acceptor.ts    # Attachment download/validation
│   │   ├── SessionPoolService.ts
│   │   ├── IdempotencyService.ts
│   │   └── RateLimitService.ts
│   ├── apps/
│   │   ├── driver.ts           # Mini-app runtime driver
│   │   └── new_app_template.md # Mini-app template
│   ├── consts.ts               # Constants
│   ├── persistence.ts          # SQLite persistence
│   ├── instance-manager.ts     # Docker discovery
│   ├── index.ts                # Gateway entry point
│   └── tests/                  # Gateway tests
├── agent/                      # Container agent
│   ├── routes/                 # Agent HTTP routes
│   │   └── execute.ts          # Command execution
│   ├── api/                    # HTTP API server mode
│   │   └── server.ts           # Advanced HTTP API
│   ├── consts.ts               # Agent constants
│   ├── app.ts                  # Hono app
│   ├── index.ts                # Agent entry point
│   ├── runtime/
│   │   └── gateway-adapter.ts  # Gateway-backed runtime wiring (agent layer)
│   └── tests/                  # Agent tests
├── packages/                   # Shared packages
│   ├── agent-runtime/          # Contracts only (no gateway imports)
│   │   ├── contracts.ts
│   │   └── index.ts
│   ├── async/                  # Concurrency utilities
│   ├── markdown/               # Markdown/frontmatter helpers
│   ├── ipc/                    # IPC transport layer
│   │   ├── factory.ts          # IPC factory
│   │   ├── tcp-client.ts       # TCP client
│   │   ├── unix-client.ts      # Unix socket client
│   │   ├── docker-exec-client.ts
│   │   ├── host-client.ts      # Host mode client
│   │   ├── remote-client.ts    # Remote client
│   │   ├── circuit-breaker.ts  # Circuit breaker
│   │   ├── stdio-adapter.ts    # Stdio adapter
│   │   ├── backends.ts         # Backend types
│   │   ├── response-utils.ts   # Robust HTTP/JSON parsing helpers
│   │   └── types.ts            # Common types
│   ├── logger/                 # Logging package
│   ├── config/                 # Configuration
│   ├── scheduler/              # Schedule parsing/next-run logic
│   ├── text/                   # Text chunking helpers
│   └── validation/             # Reusable validation helpers
├── apps/                       # Mini-app definitions (*.md)
│   └── daily-news.md
└── dockers/
    ├── Dockerfile.agent        # Agent container
    └── docker-compose.yml      # Container orchestration
```

---

## 3. System Components

### 3.1 Gateway Service

**Entry Point**: `src/gateway/index.ts`

```typescript
import { Hono } from "hono";
import { pinoLogger } from "hono-pino";

const app = new Hono();

// Custom HTTP logging (plaintext)
app.use("*", async (c, next) => {
    const start = Date.now();
    await next();
    const duration = Date.now() - start;
    logger.info(`[${c.req.method}] ${c.req.path} → ${c.res.status} (${duration}ms)`);
});

// Routes
app.get("/health", authMiddleware, handleHealth);
app.post("/webhook/telegram", (c) => handleTelegramWebhook(c, { telegram, bots, config }));
app.post("/webhook/feishu", (c) => handleFeishuWebhook(c, { telegram, feishu, bots, feishuBots, config }));
app.post("/webhook", (c) => handleWebhook(c, { telegram, feishu, bots, feishuBots, config })); // legacy
app.post("/claude-callback", (c) => handleClaudeCallback(c, deps));
```

### 3.2 Bot Pipeline

**Chain of Responsibility Pattern**:

```typescript
// Bot interface
interface Bot {
    name: string;
    handle(message: Message): Promise<boolean>;
}

// Bot chain execution
for (const bot of bots) {
    handled = await handleBotWithTimeout(bot, message, telegram);
    if (handled) break;
}
```

**Bot Types**:
- `MenuBot`: Handles menu/workspace/status commands (`/menu`, `/ws_list`, `/ws_switch`, `/status`)
- `HostBot`: Manages host operations (`/host`, `/host_uptime`, `/host_ps`)
- `AgentBot`: Executes Claude Code commands

### 3.3 IPC Factory

**Location**: `src/packages/ipc/factory.ts`

```typescript
export class IpcFactory {
    static create(method: IpcMethod, config: IpcClientConfig): IIpcClient {
        let client: IIpcClient;

        switch (method) {
            case "tcp":
                client = new TcpIpcClient(config);
                break;
            case "unix":
                client = new UnixSocketIpcClient(config);
                break;
            case "docker-exec":
                client = new DockerExecIpcClient(config);
                break;
            case "host":
                client = new HostIpcClient(backend);
                break;
            case "auto":
                client = this.createAuto(config);
                break;
        }

        return new CircuitBreakerIpcClient(client);
    }
}
```

### 3.4 Circuit Breaker

**Location**: `src/packages/ipc/circuit-breaker.ts`

```typescript
export class CircuitBreakerIpcClient implements IIpcClient {
    private circuitState: CircuitState = {
        failures: 0,
        lastFailureTime: 0,
        state: "closed",
    };

    async sendRequest(request: IpcRequest, timeout?: number): Promise<IpcResponse> {
        if (!this.isCircuitAvailable()) {
            return {
                id: request.id,
                status: 503,
                error: { message: "Service temporarily unavailable (circuit breaker open)" }
            };
        }

        const result = await this.client.sendRequest(request, timeout);
        this.recordResult(result);
        return result;
    }
}
```

### 3.5 Persistence Layer

**Location**: `src/gateway/persistence.ts`
**Default DB File**: `data/gateway.db`

```typescript
export class PersistenceManager {
    private db: Database;

    async storeMessage(chatId: string | number, sender: string, text: string, workspace?: string) {
        this.db.run(
            "INSERT INTO messages (chat_id, workspace_name, sender, text) VALUES (?, ?, ?, ?)",
            [String(chatId), workspace || "cc-bridge", sender, text]
        );
    }

    async getHistory(chatId: string | number, limit: number = 50, workspace?: string): Promise<DBMessage[]> {
        return this.db.query("SELECT * FROM messages WHERE chat_id = ? AND workspace_name = ? ORDER BY id DESC LIMIT ?")
            .all(String(chatId), workspace || "cc-bridge", limit) as DBMessage[];
    }

    async setWorkspace(chatId: string | number, workspaceName: string) {
        this.db.run(
            "INSERT OR REPLACE INTO workspaces (chat_id, workspace_name, last_updated) VALUES (?, ?, CURRENT_TIMESTAMP)",
            [String(chatId), workspaceName]
        );
    }

    async getWorkspace(chatId: string | number): Promise<string> {
        const result = this.db.query("SELECT workspace_name FROM workspaces WHERE chat_id = ?").get(String(chatId)) as { workspace_name: string } | null;
        return result?.workspace_name || "cc-bridge";
    }
}
```

### 3.6 Tmux Manager

**Location**: `src/gateway/services/tmux-manager.ts`

```typescript
export class TmuxManager {
    async getOrCreateSession(containerId: string, workspace: string, chatId: string): Promise<string> {
        const sessionName = this.generateSessionName(workspace, chatId);

        // Check if session exists
        const exists = await this.sessionExists(containerId, sessionName);
        if (exists) return sessionName;

        // Create new session
        await this.createSession(containerId, sessionName);
        return sessionName;
    }

    async sendToSession(containerId: string, sessionName: string, prompt: string, metadata: Record<string, unknown>) {
        const requestId = crypto.randomUUID();
        const callbackUrl = this.buildCallbackUrl(metadata);

        const command = `claude -p '${prompt.replace(/'/g, "'\\''")}' --callback-url="${callbackUrl}" --request-id="${requestId}"`;

        await this.dockerExec(containerId, [
            "tmux", "send-keys", "-t", sessionName, command, "Enter"
        ]);
    }
}
```

### 3.7 Mini-App Driver

**Locations**:
- Runtime driver: `src/gateway/apps/driver.ts`
- App specs: `src/apps/*.md`
- Scheduler integration: `src/gateway/task-scheduler.ts`

Mini-apps are markdown-defined tasks rendered at runtime and dispatched to resolved targets.

Key lifecycle operations are exposed via:
- `make app-new`
- `make app-list`
- `make app-run`
- `make app-schedule`
- `make app-list-tasks`
- `make app-unschedule`

---

## 4. Data Flow

### 4.1 Message Processing Pipeline

```
Telegram Update
    ↓
Webhook Validation (parseWebhook)
    ↓
Deduplication Check (updateTracker)
    ↓
Rate Limiting (rateLimiter)
    ↓
Store Incoming Message (persistence)
    ↓
Bot Pipeline (MenuBot → HostBot → AgentBot)
    ↓
IPC Request (IpcFactory.create → sendRequest)
    ↓
Circuit Breaker Check
    ↓
Agent Execution
    ↓
Claude CLI Output
    ↓
IPC Response
    ↓
Store Outgoing Message (persistence)
    ↓
Telegram sendMessage
```

### 4.2 IPC Request Flow

```
Gateway Request
    ↓
IpcFactory.create(method, config)
    ↓
CircuitBreakerIpcClient.sendRequest()
    ↓
[Closed] → Forward to underlying client
[Open] → Return 503 immediately
    ↓
TcpIpcClient / UnixSocketIpcClient / DockerExecIpcClient
    ↓
HTTP Request to Agent (or docker exec)
    ↓
Agent processes request
    ↓
Response returned
    ↓
Circuit breaker state updated
```

---

## 5. Module Reference

### 5.1 IPC Package

**Exports**:
```typescript
// Factory
export { IpcFactory } from "./factory";

// Clients
export { TcpIpcClient } from "./tcp-client";
export { UnixSocketIpcClient } from "./unix-client";
export { DockerExecIpcClient } from "./docker-exec-client";
export { HostIpcClient } from "./host-client";
export { RemoteIpcClient } from "./remote-client";

// Circuit breaker
export { CircuitBreakerIpcClient } from "./circuit-breaker";

// Agent-side
export { StdioIpcAdapter } from "./stdio-adapter";

// Types
export type { IIpcClient, IpcRequest, IpcResponse, IpcMethod } from "./types";
export type { AnyBackend, ContainerBackend, HostBackend, RemoteBackend } from "./backends";
```

### 5.2 Services Layer

```typescript
// Claude Executor
export async function executeClaude(
    containerId: string,
    instanceName: string,
    prompt: string,
    config: ClaudeExecutionConfig
): Promise<ClaudeExecutionResultOrAsync>

// Tmux Manager (Async Mode)
export class TmuxManager {
    async getOrCreateSession(containerId: string, workspace: string, chatId: string): Promise<string>
    async sendToSession(containerId: string, sessionName: string, prompt: string, metadata: unknown): Promise<void>
}

// Session Pool
export class SessionPoolService {
    async getOrCreateSession(workspace: string, chatId: string): Promise<SessionInfo>
    async releaseSession(sessionId: string): Promise<void>
}

// File Cleanup
export class FileCleanupService {
    async start(): Promise<void>
    async stop(): Promise<void>
}

// Idempotency
export class IdempotencyService {
    check(requestId: string): boolean
    mark(requestId: string, ttl?: number): void
}

// Rate Limiting
export class RateLimitService {
    isAllowed(workspace: string, ip: string): Promise<boolean>
}
```

---

## 6. API Reference

### 6.1 Gateway HTTP Endpoints

#### GET `/health`

Health check endpoint (requires authentication via `HEALTH_API_KEY`).

**Response**:
```json
{
  "status": "ok",
  "runtime": "bun",
  "timestamp": "2025-02-07T10:00:00Z"
}
```

#### POST `/webhook`, `/webhook/telegram`, `/webhook/feishu`

Receive Telegram or Lark/Feishu webhook updates. `/webhook` is a legacy unified endpoint that auto-detects the channel.

**Request Body**: Telegram update object or Lark/Feishu event object
**Response**:
- `{ status: "ok" }` for accepted messages
- `{ challenge: "..." }` for Lark/Feishu URL verification
- `400` with `{ status: "ignored", reason: "invalid json" }` for malformed JSON on channel-specific routes

#### POST `/claude-callback`

Receive callback from agent (async mode).

**Request Body**:
```json
{
  "requestId": "uuid",
  "result": {
    "stdout": "output",
    "exitCode": 0
  }
}
```

### 6.2 Agent HTTP Endpoints

#### POST `/execute` (TCP 3001)

Execute a command in the container.

**Request Body**:
```json
{
  "command": "claude",
  "args": ["-p", "prompt"],
  "cwd": "/workspaces/cc-bridge",
  "timeout": 120000
}
```

**Response**:
```json
{
  "stdout": "output",
  "stderr": "errors",
  "exitCode": 0
}
```

---

## 7. Testing Strategy

### 7.1 Test Organization

```
src/
├── gateway/tests/
│   ├── agent-bot.test.ts
│   ├── claude-executor.test.ts
│   ├── health.test.ts
│   ├── host-bot.test.ts
│   ├── mailbox-watcher.test.ts
│   ├── persistence.test.ts
│   ├── telegram.test.ts
│   └── integration/
│       └── ...
├── agent/tests/
│   └── ...
└── packages/tests/
    └── ...
```

### 7.2 Running Tests

```bash
# Run all tests
bun test

# Run specific test file
bun test src/gateway/tests/agent-bot.test.ts

# Run with coverage
bun test --coverage

# Watch mode
bun test --watch
```

### 7.3 Test Patterns

```typescript
// Example test
import { describe, expect, test } from "bun:test";

describe("IpcFactory", () => {
    test("creates TCP client", () => {
        const client = IpcFactory.create("tcp", { instanceName: "test" });
        expect(client).toBeInstanceOf(CircuitBreakerIpcClient);
    });

    test("auto-selects available method", () => {
        const client = IpcFactory.create("auto");
        expect(client.isAvailable()).toBe(true);
    });
});
```

---

## 8. Development Workflow

### 8.1 Environment Setup

```bash
# Clone repository
git clone https://github.com/hanxiao/cc-bridge.git
cd cc-bridge

# Install dependencies
bun install

# Configure environment
cp src/dockers/.env.example src/dockers/.env
# Edit src/dockers/.env with your tokens
```

### 8.2 Development Commands

```bash
# Start gateway (host)
make gateway-start

# Build/restart container agent
make docker-restart

# View logs
make logs-monitor

# Run tests
make test

# Lint
make lint

# Format
make format
```

### 8.3 Makefile Targets

| Target | Description |
|--------|-------------|
| `gateway-start` | Start gateway service |
| `gateway-stop` | Stop gateway service |
| `gateway-restart` | Restart gateway |
| `docker-stop` | Stop container agent |
| `docker-restart` | Restart container |
| `docker-status` | Show container status/processes |
| `docker-logs` | Follow container logs |
| `logs-monitor` | Stream logs |
| `talk MSG="..."` | Send test message through container command flow |
| `app-new APP_ID=...` | Create mini-app definition |
| `app-list` | List mini-app definitions |
| `app-run APP_ID=...` | Run mini-app once |
| `app-schedule APP_ID=...` | Register scheduled mini-app task |
| `app-list-tasks [APP_ID=...]` | List mini-app tasks |
| `app-unschedule TASK_ID=...` | Unschedule by task id |
| `app-unschedule APP_ID=...` | Unschedule by app id |
| `test` | Run all tests |
| `lint` | Run linter |
| `format` | Format code |

---

## 9. Maintenance Guide

### 9.1 Adding Dependencies

```bash
# Add runtime dependency
bun add package-name

# Add dev dependency
bun add -d package-name

# Update dependencies
bun update
```

### 9.2 Debugging

**Enable debug logging**:
```bash
export LOG_LEVEL=debug
make gateway-start
```

**Check IPC connectivity**:
```bash
make talk MSG="ping"
```

**View container logs**:
```bash
docker logs -f cc-bridge-agent
```

### 9.3 Performance Monitoring

**Key metrics to monitor**:
- IPC request latency
- Circuit breaker state
- Rate limit utilization
- Session pool size
- File cleanup backlog

---

## 10. Extension Guide

### 10.1 Adding a New Bot

Create `src/gateway/pipeline/mybot.ts`:

```typescript
import type { Bot } from "./index";
import type { Message } from "@/gateway/channels";

export class MyBot implements Bot {
    name = "my-bot";

    async handle(message: Message): Promise<boolean> {
        // Handle message
        return true; // Return true if handled
    }
}
```

Register in `src/gateway/index.ts`:

```typescript
import { MyBot } from "./pipeline/mybot";

const bots = [
    new MenuBot(telegram),
    new HostBot(telegram),
    new AgentBot(telegram),
    new MyBot(telegram),  // Add here
];
```

### 10.2 Adding a New IPC Method

Create `src/packages/ipc/my-client.ts`:

```typescript
export class MyIpcClient implements IIpcClient {
    async sendRequest(request: IpcRequest, timeout?: number): Promise<IpcResponse> {
        // Implement IPC method
    }

    isAvailable(): boolean {
        return true;
    }

    getMethod(): string {
        return "my-method";
    }
}
```

Add to factory:

```typescript
case "my-method":
    client = new MyIpcClient(config);
    break;
```

### 10.3 Adding a New Service

Create `src/gateway/services/my-service.ts`:

```typescript
export class MyService {
    constructor(config: MyServiceConfig) {
        // Initialize
    }

    async start(): Promise<void> {
        // Start service
    }

    async stop(): Promise<void> {
        // Stop service
    }
}
```

---

## Appendix A: Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Gateway port | 8080 |
| `LOG_LEVEL` | Logging level | info |
| `LOG_FORMAT` | Log format (json/text) | json |
| `AGENT_MODE` | Agent mode (tcp/server/stdio/http) | tcp |
| `AGENT_TCP_PORT` | Agent TCP port | 3001 |
| `ANTHROPIC_AUTH_TOKEN` | Claude API token | - |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token | - |
| `FEISHU_APP_ID` | Lark/Feishu App ID | - |
| `FEISHU_APP_SECRET` | Lark/Feishu App Secret | - |
| `FEISHU_ENCRYPT_KEY` | Lark/Feishu Payload Encryption Key | - |
| `FEISHU_VERIFICATION_TOKEN` | Lark/Feishu Verification Token | - |
| `ENABLE_TMUX` | Enable tmux mode | false |
| `FILE_CLEANUP_ENABLED` | Enable file cleanup | true |

---

## Document Version History

| Version | Date | Changes |
|---------|------|---------|
| 2.2.0 | 2026-02-21 | Updated architecture/module docs for mini-app driver, package refactors, webhook routing, and current make targets |
| 2.0.0 | 2025-02-07 | Complete rewrite for Bun/Hono architecture, IPC factory, circuit breaker |
| 1.0.0 | 2026-02-02 | Initial developer spec |

---

**Maintained by**: CC-Bridge Development Team
