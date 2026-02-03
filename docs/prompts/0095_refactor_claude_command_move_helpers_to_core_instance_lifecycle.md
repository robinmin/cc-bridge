---
name: refactor-claude-command-move-helpers-to-core-instance-lifecycle
description: Move helper functions from commands/claude.py to core/instance_lifecycle.py, keep only CLI argument parsing in commands
status: Done
created_at: 2025-02-02
updated_at: 2026-02-03 14:59:45
impl_progress:
  planning: completed
  design: completed
  implementation: completed
  review: pending
  testing: in_progress
dependencies: []
tags: [refactoring, architecture, commands, delegation, instances]
---

## WBS#_refactor_claude_command_move_helpers_to_core_instance_lifecycle

### Background

The `cc_bridge/commands/claude.py` file (680 lines) is the primary instance management command but contains several helper functions with business logic that should be in `cc_bridge/core/` for better separation of concerns and reusability.

**Current state:**
- `commands/claude.py` contains helper functions that mix business logic with CLI handling:
  - `_get_tmux_socket_path()` (lines 28-30)
  - `_is_tmux_available()` (lines 33-39)
  - `_validate_working_directory()` (lines 42-64)
  - `_get_session_name()` (lines 67-80)
  - `_detect_instance_type()` (lines 83-114)
  - `_start_tmux_instance()` (lines 187-274)
  - `_start_docker_instance()` (lines 277-314)
  - `_stop_tmux_instance()` (lines 353-395)
  - `_stop_docker_instance()` (lines 398-423)

**Problem:** These helper functions contain reusable business logic (validation, detection, lifecycle operations) that should be available to other modules but are trapped in the command file.

### Requirements / Objectives

**Functional Requirements:**
- Create `cc_bridge/core/instance_lifecycle.py` with reusable helper functions
- Move validation functions to core:
  - `validate_working_directory()` (rename from `_validate_working_directory()`)
  - `detect_instance_type()` (rename from `_detect_instance_type()`)
  - `get_tmux_socket_path()` (rename from `_get_tmux_socket_path()`)
  - `is_tmux_available()` (rename from `_is_tmux_available()`)
  - `get_session_name()` (rename from `_get_session_name()`)
- Keep lifecycle helper functions in commands as they orchestrate core modules
- Update `commands/claude.py` to import from core

**Non-Functional Requirements:**
- Maintain backward compatibility (no breaking changes to CLI)
- Add comprehensive type hints
- Follow existing code patterns in `core/`
- Add docstrings to all functions

**Acceptance Criteria:**
- [ ] `cc_bridge/core/instance_lifecycle.py` created with validation utilities
- [ ] `commands/claude.py` imports from `core.instance_lifecycle`
- [ ] All existing tests pass without modification
- [ ] `cc-bridge claude start/stop/list/attach/restart/status` all work
- [ ] No duplicate code between commands and core
- [ ] Functions are reusable by other modules

### Solutions / Goals

**Technology Stack:**
- Python 3.11+
- pathlib (existing)
- subprocess (existing)
- asyncio (existing)

**Implementation Approach:**

**New `core/instance_lifecycle.py` structure:**
```python
# Constants
DEFAULT_TMUX_SOCKET_PATH = "~/.claude/bridge/tmux.sock"

# Path utilities
def get_tmux_socket_path() -> str
def is_tmux_available() -> bool
def get_session_name(name: str) -> str

# Validation utilities
def validate_working_directory(cwd: str) -> tuple[bool, str]
def detect_instance_type(
    explicit_type: str | None,
    existing_instance: ClaudeInstance | None,
) -> str
```

**Keep in `commands/claude.py`:**
- `_start_tmux_instance()` - Orchestrates multiple core calls
- `_start_docker_instance()` - Orchestrates multiple core calls
- `_stop_tmux_instance()` - Orchestrates multiple core calls
- `_stop_docker_instance()` - Orchestrates multiple core calls
- All Typer CLI command definitions (`start`, `stop`, `list`, `attach`, `restart`, `status`)
- User-facing error messages and formatting

**Rationale:** The lifecycle helper functions (`_start_*`, `_stop_*`) orchestrate multiple core modules (validation, instance manager, tmux, Docker) and contain CLI-specific logic. These are appropriate to keep in commands as they're not reusable business logic - they're workflow orchestration.

#### Plan

**Phase 1: Create core/instance_lifecycle.py**
- [ ] Create file with proper imports
- [ ] Add `get_tmux_socket_path()` function
- [ ] Add `is_tmux_available()` function
- [ ] Add `get_session_name()` function (delegates to `validation.safe_tmux_session_name`)
- [ ] Add `validate_working_directory()` function
- [ ] Add `detect_instance_type()` function
- [ ] Add `__all__` exports
- [ ] Add comprehensive docstrings

**Phase 2: Refactor commands/claude.py**
- [ ] Import from `core.instance_lifecycle`
- [ ] Remove inline helper functions
- [ ] Update function calls to use imported functions (remove `_` prefix)
- [ ] Keep lifecycle orchestration functions (`_start_*`, `_stop_*`)
- [ ] Keep all Typer CLI command definitions
- [ ] Verify file is well-organized

**Phase 3: Testing**
- [ ] Run `cc-bridge claude start <name>` (tmux)
- [ ] Run `cc-bridge claude start <name> --instance-type docker`
- [ ] Run `cc-bridge claude stop <name>`
- [ ] Run `cc-bridge claude list`
- [ ] Run `cc-bridge claude attach <name>`
- [ ] Run `cc-bridge claude restart <name>`
- [ ] Run `cc-bridge claude status <name>`
- [ ] Test with invalid working directory
- [ ] Test with invalid instance name
- [ ] Run existing test suite

### References

- Current claude command: `/Users/robin/xprojects/cc-bridge/cc_bridge/commands/claude.py`
- Validation module: `/Users/robin/xprojects/cc-bridge/cc_bridge/core/validation.py`
- Instance manager: `/Users/robin/xprojects/cc-bridge/cc_bridge/core/instances.py`
- Docker compat: `/Users/robin/xprojects/cc-bridge/cc_bridge/core/docker_compat.py`
- Analysis plan: `/Users/robin/xprojects/cc-bridge/docs/prompts/0090_commands_folder_analysis_plan.md`
