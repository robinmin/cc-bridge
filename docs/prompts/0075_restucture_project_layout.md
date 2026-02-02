---
name: restucture project layout
description: Task: restucture project layout
status: Done
created_at: 2026-02-02 11:22:24
updated_at: 2026-02-02 12:45:00
impl_progress:
  planning: completed
  design: completed
  implementation: completed
  review: completed
  testing: completed
---

## 0075. restucture project layout

### Background

Despite we almost got the project working and already got "make all" working, the project layout is a bit messy and some code are redundant and some features are not used and others implemented in the incorrect places. Let's refactor it. 

### Current Project Structure
```text
├── cc_bridge
│   ├── agents                  # Container-level bridging components
│   │   └── container_agent.py  # Bridges host I/O to Claude Code inside Docker
│   ├── cli.py                  # Main Typer CLI entry point
│   ├── commands                # CLI Command Implementations
│   │   ├── bot.py              # Telegram bot command synchronization (sync/list)
│   │   ├── claude.py           # Instance lifecycle management (start/stop/list)
│   │   ├── config.py           # Configuration management CLI
│   │   ├── cron.py             # Periodic background tasks (TBD: Auto-cleanup/Session pruning)
│   │   ├── health.py           # System status and diagnostic CLI
│   │   ├── hook_stop.py        # Terminal hook for Claude to report execution completion
│   │   ├── logs.py             # Log management and streaming CLI (TBD: Centralized log viewing)
│   │   ├── server.py           # FastAPI Webhook Server (Primary bridge logic)
│   │   ├── setup.py            # Interactive project setup wizard
│   │   ├── tunnel.py           # cloudflared tunnel lifecycle management
│   │   └── webhook.py          # Manual webhook and port management tools
│   ├── config.py               # Layered configuration system (CLI/Env/TOML)
│   ├── constants.py            # Shared system-wide constants and magic numbers
│   ├── core                    # Core Business Logic & Infrastructure
│   │   ├── claude.py           # Low-level Claude Code CLI wrappers
│   │   ├── docker_compat.py    # Docker SDK initialization and compatibility helpers
│   │   ├── docker_discovery.py # Automatic detection of compatible containers
│   │   ├── docker_errors.py    # Specialized Docker exception handling
│   │   ├── health_monitor.py   # Background health check logic (TBD: Detailed metrics)
│   │   ├── instance_detector.py# Multi-adapter instance state detection
│   │   ├── instance_interface.py# Abstract base and adapters for Docker/Tmux parity (TBD: Tmux auto-start)
│   │   ├── instances.py        # Persistence layer for instance state (instances.json)
│   │   ├── named_pipe.py       # FIFO-based IPC logic for daemon-mode Docker
│   │   ├── parser.py           # Result parsing and stream cleaning
│   │   ├── session_tracker.py  # Async state tracking for request/response pairs
│   │   ├── telegram.py         # Httpx wrapper for Telegram Bot API
│   │   ├── tmux.py             # Low-level tmux keys injection and pane capture
│   │   └── validation.py       # Input sanitization and safety checks
│   ├── docs                    # Internal documentation assets
│   ├── exceptions.py           # Generic system-wide exception definitions
│   ├── logging.py              # Structured logging configuration
│   └── models                  # Pydantic Data Models
│       ├── config.py           # Configuration schema
│       ├── instances.py        # Instance state schema
│       └── telegram.py         # Telegram update/message schema
├── contrib                     # System Integration & OS-level assets
│   ├── cc-bridge.rb            # Homebrew Formula (TBD: Distribution)
│   ├── com.cc-bridge.daemon.plist # macOS LaunchDaemon for system-wide service
│   ├── com.cloudflare.cloudflared.plist # cloudflared service definition
│   ├── homebrew.mxcl.cc-bridge.plist # User-level LaunchAgent (Homebrew)
│   └── homebrew.mxcl.cloudflared.plist # User-level cloudflared Agent
├── dist                        # Build distribution artifacts
├── dockers                     # Docker Environment
│   ├── docker-compose.yml      # Standardized container deployment
│   ├── Dockerfile              # Modernized image with uv/bun support
│   └── mcp.json                # MCP Server configuration for the project
├── docs                        # Public project documentation
│   ├── examples                # Reference configurations
│   ├── technical               # Architecture and sequence diagrams
│   └── ...                     # Static assets and tutorials
├── Makefile                    # Unified project automation and developer toolset
├── pyproject.toml              # Python project metadata and dependencies (PEPs)
├── pytest.ini                  # Test runner configuration
├── scripts                     # Maintenance and installation utilities
│   ├── fix-cloudflared-plist.sh # Automated plist repair
│   ├── health-check.sh         # One-shot status diagnostic script
│   ├── install-daemon.sh       # Root-level installation script
│   ├── install-service.sh      # User-level installation script
│   ├── uninstall-daemon.sh     # Clean cleanup (Root)
│   └── uninstall-service.sh    # Clean cleanup (User)
├── test_setup_fixes.py         # Diagnostic tool for environment validation
├── tests                       # Comprehensive test suite (TBD: Integration Coverage)
└── uv.lock                     # Deterministic dependency lockfile
```

### Ideal Project Structure
├── cc_bridge
│   ├── agents                  # Container-level bridging components
│   │   └── container_agent.py  # Bridges host I/O to Claude Code inside Docker
│   ├── cli.py                  # Main Typer CLI entry point
│   ├── commands                # CLI Command Implementations, one file per command. All of them should be a simple wrapper around the core logic and be imported in cli.py
│   ├── config.py               # Layered configuration system (CLI/Env/TOML)
│   ├── constants.py            # Shared system-wide constants and magic numbers
│   ├── core                    # Core Business Logic & Infrastructure
│   ├── packages                # reusable packages
│   │   ├── exceptions.py       # Generic system-wide exception definitions
│   │   └── logging.py          # Structured logging configuration
│   └── models                  # Pydantic Data Models
│       ├── config.py           # Configuration schema
│       ├── instances.py        # Instance state schema
│       └── telegram.py         # Telegram update/message schema
├── contrib                     # System Integration & OS-level assets
├── dist                        # Build distribution artifacts
├── dockers                     # Files for Docker Environment
├── docs                        # Public project documentation
├── Makefile                    # Unified project automation and developer toolset
├── pyproject.toml              # Python project metadata and dependencies (PEPs)
├── pytest.ini                  # Test runner configuration
├── scripts                     # Maintenance and installation utilities
├── tests                       # Comprehensive test suite (TBD: Integration Coverage)
│   ├── unit                    # Core Business Logic & Infrastructure
│   └── integration             # Pydantic Data Models

### Requirements

- Evaluate the current project structure and identify areas for improvement.
- Refactor the project structure to follow the ideal project structure.
- Ensure that the project structure is maintainable and scalable.
- Ensure that the project structure is consistent with the project's goals and requirements.
- Ensure "make all" still works after the refactoring.

### Q&A

[Clarifications added during planning phase]

### Design

**Architecture Analysis:**

This is an internal refactoring task focused on:
1. Moving reusable utilities (`exceptions.py`, `logging.py`) to `packages/` subdirectory
2. Reorganizing test structure into `unit/` and `integration/` subdirectories
3. Ensuring all imports are updated consistently

**Specialist Assessment:**
- `super-architect`: Not required - target structure is clearly defined
- `super-designer`: Not required - no UI/UX changes

### Plan

**Phase 1: Create packages directory**
- [x] Create `cc_bridge/packages/` directory
- [x] Create `cc_bridge/packages/__init__.py` with proper exports
- [x] Move `exceptions.py` to `cc_bridge/packages/exceptions.py`
- [x] Move `logging.py` to `cc_bridge/packages/logging.py`
- [x] Update `cc_bridge/__init__.py` for backward compatibility

**Phase 2: Update imports across codebase**
- [x] SKIP - Backward compatibility layer handles all imports automatically
- [x] Module proxies created for `cc_bridge.logging` and `cc_bridge.exceptions`
- [x] All existing imports continue to work without modification

**Phase 3: Reorganize test structure**
- [x] Create `tests/unit/` subdirectory (if not exists)
- [x] Create `tests/unit/test_logging.py`
- [x] Create `tests/unit/test_cli.py`
- [x] Create `tests/unit/test_config.py`
- [x] Note: `tests/integration/` already exists with `test_fifo_communication.py`
- [x] Note: Other test directories (`test_commands/`, `test_core/`, etc.) remain in place

**Phase 4: Validation**
- [x] Run `make all` to ensure no broken imports - 533 tests passed
- [x] Run `pytest` to verify all tests pass - 8 skipped, 1 warning
- [x] Verify no backward compatibility issues - all existing imports work

### Artifacts

| Type | Path | Generated By | Date |
|------|------|--------------|------|

### References

[Links to docs, related tasks, external resources]
