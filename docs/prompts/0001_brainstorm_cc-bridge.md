---
name: brainstorm cc-bridge
description: Task: brainstorm cc-bridge
status: Done
created_at: 2026-01-26 20:26:47
updated_at: 2026-01-26 21:15:00
impl_progress:
  planning: completed
  design: completed
  implementation: pending
  review: pending
  testing: pending
---

## 0001. brainstorm cc-bridge

### Background

Transform the existing POC utility (`bridge.py` + bash hook) into a formal, production-ready Python project in the `cc-bridge/` directory. The current POC uses Flask for the webhook server and a bash script for the Stop hook, which has limitations in cross-platform support, error handling, and maintainability.

**Motivation**:
- Current POC is functional but lacks structure for long-term maintenance
- Bash hook is platform-dependent and hard to test
- No unified CLI interface for managing all bridge operations
- Need better configuration management
- Want to add health checking and setup automation

### Requirements

#### Core Commands (MVP)

| Command | Purpose | Description |
|---------|---------|-------------|
| `server` | Run FastAPI webhook server | Receives Telegram webhooks, injects to Claude via tmux |
| `hook-stop` | Send Claude response to Telegram | Replace bash hook with Python (Stop hook integration) |
| `health` | Periodic health checks | Verify webhook, tmux session, hook functionality |
| `setup` | First-time initialization | Interactive wizard for initial configuration |
| `config` | Configuration management | Set/get/delete config values |
| `tunnel` | Cloudflare tunnel management | Start/stop cloudflared with webhook auto-config |

#### Extended Commands (Phase 2)

| Command | Purpose | Description |
|---------|---------|-------------|
| `logs` | Log streaming | Tail bridge logs with filtering |
| `webhook` | Webhook management | Set/test/delete Telegram webhooks (manual) |
| `bot` | Bot commands | Sync custom commands to Telegram |

#### Technical Requirements

**Core Framework**:
- **Web Framework**: FastAPI (async, Pydantic validation)
- **CLI Framework**: Typer (modern, async-friendly)
- **HTTP Client**: httpx (async HTTP/2 support)
- **Logging**: structlog (JSON/text structured logging)
- **Testing**: pytest + pytest-cov + pytest-asyncio (comprehensive coverage)

**Configuration**:
- Layered system: CLI args > env vars > TOML config > defaults
- Single config file: `~/.claude/bridge/config.toml`
- Environment variables for secrets (bot token)

**Platform Scope**:
- macOS-only (M4 macmini deployment target)
- tmux for session management
- cloudflared for tunneling

**Development Toolchain**:
- **make**: Task automation (dev, test, lint, format, install, build)
- **uv**: Fast package management
- **ruff**: Linting and formatting (replace black, flake8, isort)
- **ty**: Type checking (extremely fast, from Astral)
- **typer**: CLI framework

### Q&A

**Questions resolved**:

| Question | Answer | Implication |
|----------|--------|-------------|
| **Deployment model** | Single machine (macOS M4 local macmini) | No multi-server complexity, focus on macOS optimization |
| **Session management** | tmux-based | Keep existing approach, no database needed |
| **Multi-user support** | Single-user only | Simplified authentication and session handling |
| **Configuration complexity** | Simple (env + file) | No profiles, just TOML config + environment variables |
| **Testing approach** | Comprehensive test suite | Full pytest coverage with integration tests |
| **Async library** | httpx | Modern async HTTP client with HTTP/2 support |

### Technical Decisions

#### Telegram Communication: Custom Implementation vs ProjectDiscovery Notify

**Decision**: Build custom Telegram client using **httpx** (NOT using ProjectDiscovery Notify)

**Rationale**:

| Aspect | ProjectDiscovery Notify | Custom httpx Implementation |
|--------|-------------------------|------------------------------|
| **Send to Telegram** | ✅ Yes | ✅ Yes |
| **Receive webhooks** | ❌ No | ✅ Yes |
| **Handle bot commands** | ❌ No | ✅ Yes |
| **Parse updates (callback/text)** | ❌ No | ✅ Yes |
| **Interactive features (keyboards)** | ❌ No | ✅ Yes |
| **Bidirectional communication** | ❌ No | ✅ Yes |
| **Cross-platform** | Go-only | Python (macOS target) |

**Why Notify is unsuitable**:
- Notify is a **unidirectional notification tool** designed for sending alerts FROM tools TO platforms
- Cannot receive Telegram webhooks (essential for cc-bridge)
- No support for interactive bot commands, inline keyboards, or callback queries
- Fundamentally designed for one-way communication, not bidirectional bot operations

**Implementation approach**:
```python
# cc_bridge/core/telegram.py
import httpx

class TelegramClient:
    async def send_message(self, chat_id: int, text: str, parse_mode: str = "HTML"):
        async with httpx.AsyncClient() as client:
            await client.post(
                f"https://api.telegram.org/bot{self.token}/sendMessage",
                json={"chat_id": chat_id, "text": text, "parse_mode": parse_mode}
            )

    async def set_webhook(self, url: str):
        async with httpx.AsyncClient() as client:
            await client.post(
                f"https://api.telegram.org/bot{self.token}/setWebhook",
                json={"url": url}
            )

# cc_bridge/commands/server.py
from fastapi import FastAPI, Request

app = FastAPI()

@app.post("/webhook")
async def telegram_webhook(update: dict):
    # Process message, callback, etc.
    return {"status": "ok"}
```

### Additional Requirements

#### Logging System

**Must support file logging with format flexibility**:

```toml
[logging]
level = "INFO"
format = "json"  # "json" or "text"
file = "~/.claude/bridge/logs/bridge.log"
max_bytes = 10485760  # 10MB
backup_count = 5
```

**JSON format example**:
```json
{"timestamp":"2026-01-26T20:45:23Z","level":"INFO","module":"server","message":"Webhook received","chat_id":12345}
```

**Text format example**:
```
2026-01-26 20:45:23 [INFO] server: Webhook received (chat_id=12345)
```

**Implementation**: Use `structlog` for structured logging with formatters

#### Cloudflare Tunnel Automation

**Automatic cloudflared tunnel management**:

```bash
# New command: `cc-bridge tunnel start`
cc-bridge tunnel start --port 8080
# Output: Tunnel started: https://xxx-trycloudflare.com
# Automatically: extracts URL, sets Telegram webhook

# New command: `cc-bridge tunnel stop`
cc-bridge tunnel stop
# Gracefully shuts down cloudflared process
```

**Implementation details**:
- Spawn cloudflared subprocess
- Parse stdout for quick tunnel URL
- Auto-register webhook with Telegram
- Manage process lifecycle
- Handle tunnel failures/restarts

#### Development Toolchain

**Standardized toolchain**:

| Tool | Purpose | Integration |
|------|---------|-------------|
| **make** | Task automation | Common commands via `make` targets |
| **uv** | Package management | Fast dependency resolution |
| **ruff** | Linting/formatting | Replace black, flake8, isort |
| **typer** | CLI framework | Already selected for CLI |

**Makefile targets**:
```makefile
make dev         # Start development server with reload
make test        # Run pytest with coverage
make lint        # Run ruff check
make format      # Run ruff format
make typecheck   # Run ty type checker
make install     # Install dependencies via uv
make build       # Build distribution
```

#### Technical Stack Updates

**Updated based on decisions**:

- ✅ **Platform**: macOS-only (no cross-platform complexity)
- ✅ **Config**: Simple TOML + env vars (no profiles)
- ✅ **Testing**: pytest with comprehensive coverage
- ✅ **Async**: httpx for HTTP, asyncio for concurrency
- ✅ **Logging**: structlog with JSON/text formatters
- ✅ **Tunneling**: cloudflared subprocess management
- ✅ **Tooling**: make + uv + ruff + ty (type checker) + typer (CLI)

### Design

#### Project Structure

```
cc-bridge/
├── cc_bridge/
│   ├── __init__.py
│   ├── cli.py                 # Typer CLI entry point
│   ├── config.py              # Config management
│   ├── logging.py             # Structured logging
│   │
│   ├── commands/              # CLI command implementations
│   │   ├── __init__.py
│   │   ├── server.py          # FastAPI server
│   │   ├── hook_stop.py       # Stop hook (replaces bash)
│   │   ├── health.py          # Health checks
│   │   ├── setup.py           # Initial setup wizard
│   │   ├── config.py          # Config management commands
│   │   ├── tunnel.py          # Cloudflare tunnel management
│   │   ├── logs.py            # Log streaming
│   │   ├── webhook.py         # Webhook management (manual)
│   │   └── bot.py             # Bot commands sync
│   │
│   ├── core/                  # Business logic
│   │   ├── __init__.py
│   │   ├── telegram.py        # Telegram API client
│   │   ├── tmux.py            # tmux operations
│   │   ├── claude.py          # Claude Code integration
│   │   └── parser.py          # Message formatting (HTML, code blocks)
│   │
│   └── models/                # Pydantic models
│       ├── __init__.py
│       ├── telegram.py        # Telegram API models
│       └── config.py          # Config models
│
├── tests/
│   ├── __init__.py
│   ├── test_commands/
│   ├── test_core/
│   └── conftest.py
│
├── pyproject.toml
├── Makefile                    # make targets for common tasks
├── README.md
├── .env.example
└── .ruff.toml                  # ruff configuration
```

#### Configuration Structure

```toml
# ~/.claude/bridge/config.toml
[telegram]
bot_token = "123456:ABC-DEF..."
webhook_url = "https://..."

[server]
host = "0.0.0.0"
port = 8080
reload = false

[tmux]
session = "claude"
auto_attach = true

[logging]
level = "INFO"                 # DEBUG, INFO, WARNING, ERROR, CRITICAL
format = "json"                # "json" or "text"
file = "~/.claude/bridge/logs/bridge.log"
max_bytes = 10485760           # 10MB
backup_count = 5

[health]
enabled = true
interval_minutes = 5

[tunnel]
auto_start = false             # Auto-start cloudflared with server
```

#### FastAPI Server Design

- Async endpoint for Telegram webhooks
- Background tasks for typing indicators
- Pydantic models for request/response validation
- Auto-generated OpenAPI docs (`/docs`, `/redoc`)
- Health check endpoint (`/health`)

#### Hook Stop: Python Implementation

**Advantages over bash**:
- Cross-platform (Windows support)
- Proper exception handling with try/except
- Structured logging
- Unit testable
- Better error messages

**Claude Code integration**:
```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "cc-bridge hook-stop {transcript_path}"
      }]
    }]
  }
}
```

### Plan

#### Phase 1: MVP Foundation

1. **Project scaffolding**
   - Create `cc-bridge/` directory structure
   - Set up `pyproject.toml` with dependencies
   - Initialize test framework

2. **Core modules**
   - `config.py`: Configuration loader with layered priority
   - `logging.py`: Structured logging setup
   - `cli.py`: Typer-based CLI skeleton

3. **Core business logic**
   - `telegram.py`: Telegram API client
   - `tmux.py`: tmux operations wrapper
   - `parser.py`: Message formatting (HTML, code blocks)

4. **MVP commands**
   - `server`: FastAPI webhook server
   - `hook-stop`: Python Stop hook
   - `health`: Basic health checks
   - `setup`: Interactive setup wizard
   - `config`: Config management
   - `tunnel`: Cloudflare tunnel management with webhook auto-config

#### Phase 2: Enhancement

5. **Extended commands**
   - `webhook`: Webhook management
   - `logs`: Log streaming
   - `bot`: Bot commands sync

6. **Robustness**
   - Better error handling
   - Session persistence
   - Rate limiting
   - Comprehensive logging

#### Phase 3: Advanced Features

7. **Optional features**
   - Message queuing
   - Docker deployment
   - Multi-user support
   - Metrics/observability

#### Implementation Strategy

**Recommended**: Incremental migration (Option A)
- Start with Phase 1 features
- Keep current POC working alongside
- Migrate feature by feature
- Faster feedback loop, less risky

### Artifacts

| Type | Path | Generated By | Date |
|------|------|--------------|------|
| Proposal | docs/prompts/0001_brainstorm_cc-bridge.md | rd2:tasks-cli | 2026-01-26 |

### References

**Current POC**:
- `bridge.py` - Flask webhook server
- `hooks/send-to-telegram.sh` - Bash Stop hook
- `README.md` - Setup and usage documentation

**Related Resources**:
- [FastAPI Documentation](https://fastapi.tiangolo.com/)
- [Typer Documentation](https://typer.tiangolo.com/)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Claude Code Hooks Documentation](https://github.com/anthropics/claude-code)
- [ProjectDiscovery Notify (Evaluated - Not Used)](https://github.com/projectdiscovery/notify) - Unidirectional notification tool, not suitable for bidirectional bot communication
