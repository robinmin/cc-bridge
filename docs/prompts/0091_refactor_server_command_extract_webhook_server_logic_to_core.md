---
name: refactor-server-command-extract-webhook-server-logic-to-core
description: Extract business logic from commands/server.py to core/webhook_server.py, keeping only CLI entry point
status: Testing
created_at: 2025-02-02
updated_at: 2025-02-02
impl_progress:
  planning: completed
  design: completed
  implementation: completed
  review: pending
  testing: in_progress
dependencies: []
tags: [refactoring, architecture, commands, delegation, server]
---

## WBS#_refactor_server_command_extract_webhook_server_logic_to_core

### Background

The `cc_bridge/commands/server.py` file (853 lines) is noted as an exception to the project's "Thin Wrappers" architectural principle. It contains significant business logic that should reside in `cc_bridge/core/` for better separation of concerns, testability, and reusability.

**Current state:** The file contains both CLI entry points and core business logic:
- FastAPI app setup and lifecycle management
- `GracefulShutdown` class for managing server shutdown
- `RateLimiter` class for request rate limiting
- `sanitize_for_telegram()` function for HTML sanitization
- `_clean_claude_output()` function for output cleaning
- Full webhook endpoint with request handling logic

**Target state:** Commands should be thin wrappers that delegate to core logic.

### Requirements / Objectives

**Functional Requirements:**
- Create `cc_bridge/core/webhook_server.py` with business logic
- Move `GracefulShutdown` class to core
- Move `RateLimiter` class to core
- Move `sanitize_for_telegram()` function to core
- Move `_clean_claude_output()` function to core (rename to `clean_claude_output()`)
- Create FastAPI app factory function in core
- Keep `commands/server.py` as thin CLI wrapper (uvicorn entry point)
- Ensure all imports are updated correctly

**Non-Functional Requirements:**
- Maintain backward compatibility (no breaking changes to CLI)
- Preserve all existing functionality
- Add type hints throughout
- Ensure thread safety for global singletons
- Add comprehensive docstrings

**Acceptance Criteria:**
- [ ] `cc_bridge/core/webhook_server.py` created with all business logic
- [ ] `commands/server.py` reduced to < 50 lines (CLI entry point only)
- [ ] All existing tests pass without modification
- [ ] Server starts, processes webhooks, and shuts down correctly
- [ ] Rate limiting continues to work
- [ ] Graceful shutdown continues to work
- [ ] Output sanitization continues to work
- [ ] No duplicate code between commands and core

### Solutions / Goals

**Technology Stack:**
- Python 3.11+
- FastAPI (existing)
- uvicorn (existing)
- asyncio (existing)
- typing (existing)

**Implementation Approach:**

1. **Create `cc_bridge/core/webhook_server.py`** with:
   - `GracefulShutdown` class
   - `RateLimiter` class
   - `sanitize_for_telegram()` function
   - `clean_claude_output()` function (renamed from `_clean_claude_output`)
   - `create_webhook_app()` factory function
   - FastAPI app lifecycle management
   - Webhook endpoint handler

2. **Refactor `commands/server.py`** to:
   - Import from `core.webhook_server`
   - Keep only `start_server()` CLI entry point
   - Use uvicorn.run() with imported app

3. **Update imports** in affected modules

#### Plan

**Phase 1: Create core/webhook_server.py**
- [ ] Create file with proper imports and structure
- [ ] Move `GracefulShutdown` class
- [ ] Move `RateLimiter` class
- [ ] Move `sanitize_for_telegram()` function
- [ ] Move and rename `_clean_claude_output()` to `clean_claude_output()`
- [ ] Create `create_webhook_app()` factory function
- [ ] Move FastAPI app creation to factory
- [ ] Move webhook endpoint handler
- [ ] Add `__all__` exports
- [ ] Add comprehensive docstrings

**Phase 2: Refactor commands/server.py**
- [ ] Remove business logic (moved to core)
- [ ] Import from `core.webhook_server`
- [ ] Keep only `start_server()` function
- [ ] Update uvicorn.run() to use imported app
- [ ] Verify file is < 50 lines

**Phase 3: Update imports**
- [ ] Check for imports of moved functions from `commands.server`
- [ ] Update to import from `core.webhook_server`
- [ ] Verify no circular imports

**Phase 4: Testing**
- [ ] Start server: `cc-bridge server`
- [ ] Test webhook endpoint with curl
- [ ] Test rate limiting
- [ ] Test graceful shutdown (SIGTERM/SIGINT)
- [ ] Verify Telegram integration works
- [ ] Run existing test suite

### References

- Current file: `/Users/robin/xprojects/cc-bridge/cc_bridge/commands/server.py` (853 lines)
- Analysis plan: `/Users/robin/xprojects/cc-bridge/docs/prompts/0090_commands_folder_analysis_plan.md`
- Project structure: `/Users/robin/xprojects/cc-bridge/CLAUDE.md`
- Core modules pattern: `cc_bridge/core/*.py`
