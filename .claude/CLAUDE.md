## CLAUDE.md

## Quick Commands
### Make targets
Always prioritize to use the following make targets:

| make target | Functionality |
|-----|-----|
| help               | Show this help message |
| status             | Run system health check |
| setup              | Initial project setup (interactive) |
| install            | Install dependencies using uv |
| dev                | Start development server with auto-reload |
| test               | Run pytest with coverage |
| test-quick         | Run tests without coverage |
| lint               | Run ruff linter |
| format             | Format code with ruff |
| typecheck          | Run ty type checker |
| fix                | Auto-fix lint errors + format code |
| all                | Run all checks (lint, format, typecheck, test) |
| fix-all            | Auto-fix everything, then validate |
| start              | Start cc-bridge service |
| stop               | Stop cc-bridge service |
| restart            | Restart cc-bridge service |
| setup-service      | Install deps + LaunchAgent (recommended) |
| service-uninstall  | Uninstall LaunchAgent |
| daemon-start       | Start system daemon |
| daemon-stop        | Stop system daemon |
| daemon-restart     | Restart system daemon |
| setup-daemon       | Install deps + LaunchDaemon (servers) |
| daemon-uninstall   | Uninstall LaunchDaemon |
| monitor            | Monitor server logs |
| build              | Build distribution packages |
| clean              | Clean build artifacts |

### cc-bridge Commands
Or, we can use './.venv/bin/cc-bridge' commands directly as shown below:

```bash
Usage: cc-bridge [OPTIONS] COMMAND [ARGS]...

 Telegram bot bridge for Claude Code

╭─ Options ───────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ --install-completion          Install completion for the current shell.                                             │
│ --show-completion             Show completion for the current shell, to copy it or customize the installation.      │
│ --help                        Show this message and exit.                                                           │
╰─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯

| Commands | Functionality |
|-----|-----|
| claude-attach   | Attach to a running Claude Code instance. |
| claude-list     | List all Claude Code instances. |
| claude-restart  | Restart a Claude Code instance. |
| claude-start    | Start a new Claude Code instance. |
| claude-stop     | Stop a Claude Code instance. |
| config          | Configuration management. |
| docker          | Manage Docker-based Claude instances |
| health          | Run health checks. |
| hook-stop       | Send Claude response to Telegram (Stop hook). |
| server          | Start the FastAPI webhook server. |
| setup           | Interactive setup wizard. |
```

## Project Structure

```
cc-bridge/
├── .claude/                    # Claude Code configuration
│   └── CLAUDE.md               # This file - project instructions for Claude
│
├── cc_bridge/                 # Main application package
│   ├── __init__.py             # Package init with backward compatibility proxies
│   ├── cli.py                  # Main Typer CLI entry point
│   ├── config.py               # Layered configuration (CLI/Env/TOML)
│   ├── constants.py            # Shared system-wide constants
│   │
│   ├── agents/                 # Container-level bridging components
│   │   └── container_agent.py # Bridges host I/O to Claude Code in Docker
│   │
│   ├── commands/               # CLI Command Implementations
│   │   │                         # One file per command - simple wrappers around core logic
│   │   ├── bot.py              # Telegram bot command synchronization
│   │   ├── claude.py           # Instance lifecycle management (start/stop/list)
│   │   ├── config.py           # Configuration management CLI
│   │   ├── cron.py             # Periodic background tasks
│   │   ├── docker_cmd.py       # Docker instance management commands
│   │   ├── health.py           # System status and diagnostic CLI
│   │   ├── hook_stop.py        # Terminal hook for Claude response completion
│   │   ├── logs.py             # Log management and streaming CLI
│   │   ├── server.py           # FastAPI Webhook Server (primary bridge logic)
│   │   ├── setup.py            # Interactive project setup wizard
│   │   ├── tunnel.py           # cloudflared tunnel lifecycle management
│   │   └── webhook.py          # Manual webhook and port management tools
│   │
│   ├── core/                   # Core Business Logic & Infrastructure
│   │   ├── claude.py           # Low-level Claude Code CLI wrappers
│   │   ├── docker_compat.py    # Docker SDK initialization and compatibility
│   │   ├── docker_discovery.py # Automatic detection of compatible containers
│   │   ├── docker_errors.py    # Specialized Docker exception handling
│   │   ├── health_monitor.py   # Background health check logic
│   │   ├── instance_detector.py# Multi-adapter instance state detection
│   │   ├── instance_interface.py# Abstract base + adapters for Docker/Tmux parity
│   │   ├── instances.py        # Persistence layer for instance state (instances.json)
│   │   ├── named_pipe.py       # FIFO-based IPC for daemon-mode Docker
│   │   ├── parser.py           # Result parsing and stream cleaning
│   │   ├── session_tracker.py  # Async state tracking for request/response pairs
│   │   ├── telegram.py         # Httpx wrapper for Telegram Bot API
│   │   ├── tmux.py             # Low-level tmux keys injection and pane capture
│   │   └── validation.py       # Input sanitization and safety checks
│   │
│   ├── packages/               # Reusable cross-cutting utilities
│   │   ├── exceptions.py       # Generic system-wide exception definitions
│   │   └── logging.py          # Structured logging configuration
│   │
│   └── models/                 # Pydantic Data Models
│       ├── config.py           # Configuration schema
│       ├── instances.py        # Instance state schema
│       └── telegram.py         # Telegram update/message schema
│
├── contrib/                    # System Integration & OS-level assets
│   ├── cc-bridge.rb            # Homebrew Formula
│   ├── com.cc-bridge.daemon.plist  # macOS LaunchDaemon (system-wide service)
│   ├── com.cloudflare.cloudflared.plist  # cloudflared service definition
│   ├── homebrew.mxcl.cc-bridge.plist    # User-level LaunchAgent (Homebrew)
│   └── homebrew.mxcl.cloudflared.plist  # User-level cloudflared Agent
│
├── dockers/                    # Docker Environment files
│   ├── docker-compose.yml      # Standardized container deployment
│   ├── Dockerfile              # Modernized image with uv/bun support
│   └── mcp.json                # MCP Server configuration
│
├── docs/                       # Public project documentation
│   ├── examples/                # Reference configurations
│   ├── technical/              # Architecture and sequence diagrams
│   └── prompts/                 # Task and planning documents
│
├── Makefile                    # Unified project automation
├── pyproject.toml              # Python project metadata and dependencies (PEPs)
├── pytest.ini                  # Test runner configuration
│
├── scripts/                    # Maintenance and installation utilities
│   ├── fix-cloudflared-plist.sh # Automated plist repair
│   ├── health-check.sh         # One-shot status diagnostic script
│   ├── install-daemon.sh       # Root-level installation script
│   ├── install-service.sh      # User-level installation script
│   ├── uninstall-daemon.sh     # Clean cleanup (Root)
│   └── uninstall-service.sh    # Clean cleanup (User)
│
└── tests/                      # Comprehensive test suite
    ├── unit/                    # Unit tests (isolated component testing)
    │   ├── commands/           # CLI command tests
    │   ├── core/               # Core business logic tests
    │   ├── models/             # Pydantic model tests
    │   └── test_*.py           # Other unit test files
    │
    └── integration/             # Integration tests (end-to-end workflows)
        └── test_fifo_communication.py
```

### Key Organizational Principles

1. **Commands as Thin Wrappers**: Files in `commands/` should be simple CLI wrappers around core logic in `core/`. All business logic lives in `core/`.

2. **Reusable Utilities in packages/**: Cross-cutting concerns like logging and exceptions go in `packages/` for reuse across the project.

3. **Models for Data Validation**: All data structures with Pydantic schemas live in `models/` for type safety and validation.

4. **Test Structure Mirrors Source**: `tests/unit/` mirrors `cc_bridge/` structure for easy navigation.

5. **Integration Tests Separate**: End-to-end tests live in `tests/integration/` and test complete workflows.
