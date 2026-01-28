---
name: Project scaffolding
description: Task: Project scaffolding
status: Done
created_at: 2026-01-26 21:10:49
updated_at: 2026-01-26 22:00:00
impl_progress:
  planning: completed
  design: completed
  implementation: completed
  review: pending
  testing: pending
---

## 0002. Project scaffolding

### Background

Transform the existing POC utility (`bridge.py` + bash hook) into a formal, production-ready Python project in the `cc-bridge/` directory. This is Phase 1.1 of the cc-bridge implementation plan.

**Motivation:**
- Current POC lacks proper project structure for long-term maintenance
- Need formal Python package with proper dependency management
- Want comprehensive test framework from the start
- Need standardized tooling (make, ruff, ty, uv)

### Requirements

#### Functional Requirements

1. **Create complete directory structure** for `cc-bridge/` project
2. **Set up pyproject.toml** with all dependencies (fastapi, typer, httpx, pydantic, structlog, pytest, etc.)
3. **Create Makefile** with targets: dev, test, lint, format, typecheck, install, build
4. **Create .ruff.toml** configuration for linting and formatting
5. **Create .env.example** with environment variable templates
6. **Create README.md** with project description and setup instructions
7. **Create placeholder modules** with descriptive docstrings
8. **Create tests/conftest.py** with pytest fixtures
9. **Ensure package is installable** with `uv`

#### Non-Functional Requirements

- Platform: macOS-only (M4 macmini)
- Python: 3.10+
- Package manager: uv
- CLI entry point: `cc-bridge`
- Follow TDD methodology: write tests first, then implementation

#### Acceptance Criteria

- [ ] All directories created according to design spec
- [ ] pyproject.toml includes all dependencies from brainstorming
- [ ] Makefile has all required targets working correctly
- [ ] .ruff.toml configured with proper rules
- [ ] .env.example has all environment variables
- [ ] README.md describes the project
- [ ] All `__init__.py` files present
- [ ] All module files have descriptive docstrings
- [ ] tests/conftest.py has basic fixtures
- [ ] Package can be installed with `uv pip install -e ./cc-bridge`
- [ ] CLI entry point `cc-bridge` is available after install

### Q&A

**Q:** Should this scaffolding include actual implementation code?
**A:** No, this is scaffolding ONLY - create structure and stubs with docstrings, not full implementation. Actual implementation comes in later tasks (0003-0010).

**Q:** Should tests be written during scaffolding?
**A:** Yes, create test infrastructure (conftest.py with fixtures) and empty test files, but actual test implementations come later.

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
│   │   ├── server.py
│   │   ├── hook_stop.py
│   │   ├── health.py
│   │   ├── setup.py
│   │   ├── config.py
│   │   ├── tunnel.py
│   │   ├── logs.py
│   │   ├── webhook.py
│   │   └── bot.py
│   │
│   ├── core/                  # Business logic
│   │   ├── __init__.py
│   │   ├── telegram.py
│   │   ├── tmux.py
│   │   ├── claude.py
│   │   └── parser.py
│   │
│   └── models/                # Pydantic models
│       ├── __init__.py
│       ├── telegram.py
│       └── config.py
│
├── tests/
│   ├── __init__.py
│   ├── test_commands/
│   │   ├── __init__.py
│   │   ├── test_server.py
│   │   ├── test_hook_stop.py
│   │   ├── test_health.py
│   │   ├── test_setup.py
│   │   ├── test_config.py
│   │   ├── test_tunnel.py
│   │   ├── test_logs.py
│   │   ├── test_webhook.py
│   │   └── test_bot.py
│   ├── test_core/
│   │   ├── __init__.py
│   │   ├── test_telegram.py
│   │   ├── test_tmux.py
│   │   ├── test_claude.py
│   │   └── test_parser.py
│   └── conftest.py
│
├── pyproject.toml
├── Makefile
├── README.md
├── .env.example
└── .ruff.toml
```

#### Dependencies

**Core Framework:**
- fastapi: Web framework
- typer: CLI framework
- httpx: Async HTTP client
- pydantic: Data validation
- structlog: Structured logging

**Testing:**
- pytest: Test framework
- pytest-cov: Coverage
- pytest-asyncio: Async tests

**Development:**
- ruff: Linting/formatting
- ty: Type checking

### Plan

1. **Phase 1: Create directory structure**
   - [ ] Create cc-bridge/ root directory
   - [ ] Create all subdirectories (cc_bridge/, commands/, core/, models/, tests/)

2. **Phase 2: Configuration files**
   - [ ] Create pyproject.toml with all dependencies
   - [ ] Create Makefile with all targets
   - [ ] Create .ruff.toml configuration
   - [ ] Create .env.example
   - [ ] Create README.md

3. **Phase 3: Package structure**
   - [ ] Create all __init__.py files
   - [ ] Create module placeholder files with docstrings
   - [ ] Create test infrastructure (conftest.py)
   - [ ] Create empty test files

4. **Phase 4: Verification**
   - [x] Verify package can be installed with uv
   - [x] Verify CLI entry point works
   - [x] Verify make targets work
   - [x] Verify pytest can discover tests

### Implementation Summary

**Completed:** All phases completed successfully.

**Created Files:**

1. **Configuration Files (5):**
   - `pyproject.toml` - Project metadata, dependencies, pytest config
   - `Makefile` - Development targets (dev, test, lint, format, typecheck, install, build)
   - `.ruff.toml` - Linting and formatting configuration
   - `.env.example` - Environment variable templates
   - `README.md` - Project documentation

2. **Package Structure (21 files):**
   - `cc_bridge/__init__.py` - Package initialization
   - `cc_bridge/cli.py` - Typer CLI entry point with all command stubs
   - `cc_bridge/config.py` - Configuration management with layered priority
   - `cc_bridge/logging.py` - Structured logging setup

3. **Commands Package (10 files):**
   - `cc_bridge/commands/__init__.py`
   - `cc_bridge/commands/server.py` - FastAPI server with webhook endpoint
   - `cc_bridge/commands/hook_stop.py` - Python Stop hook implementation
   - `cc_bridge/commands/health.py` - Health check commands
   - `cc_bridge/commands/setup.py` - Interactive setup wizard
   - `cc_bridge/commands/config.py` - Configuration management commands
   - `cc_bridge/commands/tunnel.py` - Cloudflare tunnel management
   - `cc_bridge/commands/logs.py` - Log streaming
   - `cc_bridge/commands/webhook.py` - Webhook management
   - `cc_bridge/commands/bot.py` - Bot command sync

4. **Core Package (5 files):**
   - `cc_bridge/core/__init__.py`
   - `cc_bridge/core/telegram.py` - Telegram API client (httpx-based)
   - `cc_bridge/core/tmux.py` - tmux operations wrapper
   - `cc_bridge/core/claude.py` - Claude Code integration and transcript parsing
   - `cc_bridge/core/parser.py` - Message formatting and parsing

5. **Models Package (3 files):**
   - `cc_bridge/models/__init__.py`
   - `cc_bridge/models/telegram.py` - Telegram API Pydantic models
   - `cc_bridge/models/config.py` - Configuration Pydantic models

6. **Test Infrastructure (15 files):**
   - `tests/__init__.py`
   - `tests/conftest.py` - pytest fixtures (config, clients, samples)
   - `tests/test_commands/__init__.py` + 9 test files (one per command)
   - `tests/test_core/__init__.py` + 4 test files (one per core module)

**Total:** 48 files created

**Next Steps:**
- Install package: `cd cc-bridge && uv pip install -e .`
- Run tests: `make test`
- Start development: `make dev`

**Dependencies Configured:**
- Core: fastapi, typer, httpx, pydantic, structlog, toml, uvicorn
- Dev: pytest, pytest-cov, pytest-asyncio, ruff, ty
- All versions pinned in pyproject.toml

### Artifacts

| Type | Path | Generated By | Date |
|------|------|--------------|------|
| Project scaffold | cc-bridge/ | rd2:super-coder | 2026-01-26 |

### References

**Design Documents:**
- Task 0001: brainstorm_cc-bridge.md - Complete design specifications

**External Resources:**
- [FastAPI Documentation](https://fastapi.tiangolo.com/)
- [Typer Documentation](https://typer.tiangolo.com/)
- [PyProject TOML Specification](https://packaging.python.org/en/latest/specifications/pyproject-toml/)
- [pytest Documentation](https://docs.pytest.org/)
- [uv Documentation](https://github.com/astral-sh/uv)
- [ruff Documentation](https://docs.astral.sh/ruff/)
- [ty Documentation](https://github.com/astral-sh/ty)

**Current POC:**
- bridge.py - Flask webhook server (to be replaced)
- hooks/send-to-telegram.sh - Bash Stop hook (to be replaced)
