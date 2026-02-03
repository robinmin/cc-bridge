---
name: refactor-health-command-move-checks-to-core-health-monitor
description: Move all health check logic from commands/health.py to core/health_monitor.py, keeping only CLI formatting
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
tags: [refactoring, architecture, commands, delegation, health]
---

## WBS#_refactor_health_command_move_checks_to_core_health_monitor

### Background

The `cc_bridge/commands/health.py` file (434 lines) violates the project's "Thin Wrappers" architectural principle. It contains all health check logic inline instead of delegating to the existing `cc_bridge/core/health_monitor.py` module.

**Current state:**
- `commands/health.py` contains ALL health check logic:
  - `check_telegram()` async function (lines 23-88)
  - `check_tmux()` function (lines 91-151)
  - `check_hook()` function (lines 154-218)
  - `check_docker_daemon()` async function (lines 221-338)
  - `check_fifo_pipes()` function (lines 341-392)
  - `run_all_checks()` async function (lines 395-415)
  - `main()` function with CLI formatting

**Existing `core/health_monitor.py`:**
- Already exists (456 lines)
- Contains `HealthMonitor` class for Docker daemon mode monitoring
- Has `HealthStatus` dataclass
- Has `DaemonRecovery` class
- Focuses on background monitoring and recovery
- Does NOT have the health check functions from commands/health.py

**Problem:** The health check functions in `commands/health.py` are general-purpose health checks (Telegram, tmux, hook, Docker daemon, FIFO pipes) that could be reused elsewhere but are trapped in the command file.

### Requirements / Objectives

**Functional Requirements:**
- Move all health check functions from `commands/health.py` to `core/health_monitor.py`
- Keep `commands/health.py` as thin CLI wrapper for output formatting
- Preserve all existing health check functionality
- Add comprehensive type hints
- Maintain backward compatibility with CLI usage

**Non-Functional Requirements:**
- No breaking changes to `cc-bridge health` command
- All health checks must continue to work
- Follow existing code patterns in `core/health_monitor.py`
- Use the same logger and exception handling patterns

**Acceptance Criteria:**
- [ ] All health check functions moved to `core/health_monitor.py`
- [ ] `commands/health.py` reduced to CLI wrapper (< 100 lines)
- [ ] `cc-bridge health` command works identically
- [ ] Health check output format unchanged
- [ ] Exit codes correct (0 if all healthy, 1 if any unhealthy)
- [ ] All existing tests pass

### Solutions / Goals

**Technology Stack:**
- Python 3.11+
- asyncio (existing)
- httpx (existing for Telegram checks)
- subprocess (existing for tmux/hook checks)

**Implementation Approach:**

**Current `commands/health.py` functions to move:**
1. `check_telegram()` - Checks Telegram webhook connectivity
2. `check_tmux()` - Checks tmux session status
3. `check_hook()` - Checks git hook configuration
4. `check_docker_daemon()` - Checks Docker daemon mode instances
5. `check_fifo_pipes()` - Checks FIFO pipe directory health
6. `run_all_checks()` - Orchestrates all checks

**Destination `core/health_monitor.py`:**
- Already has `HealthMonitor`, `HealthStatus`, `DaemonRecovery`
- Add new functions/classes for general health checks
- Keep the background monitoring separate from one-shot checks

**Note:** The existing `HealthMonitor` class is for background monitoring with automatic recovery. The health check functions are for one-shot diagnostic checks. These are complementary features.

#### Plan

**Phase 1: Extend core/health_monitor.py**
- [ ] Add `check_telegram_webhook()` async function
- [ ] Add `check_tmux_session()` function
- [ ] Add `check_git_hooks()` function
- [ ] Add `check_docker_instances()` async function
- [ ] Add `check_fifo_directory()` function
- [ ] Add `run_all_health_checks()` async function
- [ ] Update `__all__` exports
- [ ] Add comprehensive docstrings

**Phase 2: Refactor commands/health.py**
- [ ] Import health check functions from `core.health_monitor`
- [ ] Keep `main()` function for CLI entry point
- [ ] Keep output formatting logic
- [ ] Keep exit code handling
- [ ] Remove inline health check logic

**Phase 3: Testing**
- [ ] Run `cc-bridge health` - verify output
- [ ] Test with unhealthy Telegram (no token)
- [ ] Test with unhealthy tmux (no session)
- [ ] Test with Docker daemon instances
- [ ] Verify exit codes
- [ ] Run existing test suite

### References

- Current commands file: `/Users/robin/xprojects/cc-bridge/cc_bridge/commands/health.py`
- Current core file: `/Users/robin/xprojects/cc-bridge/cc_bridge/core/health_monitor.py`
- Analysis plan: `/Users/robin/xprojects/cc-bridge/docs/prompts/0090_commands_folder_analysis_plan.md`
- Related modules:
  - `/Users/robin/xprojects/cc-bridge/cc_bridge/core/telegram.py` (Telegram client)
  - `/Users/robin/xprojects/cc-bridge/cc_bridge/core/tmux.py` (TmuxSession)
  - `/Users/robin/xprojects/cc-bridge/cc_bridge/core/named_pipe.py` (NamedPipeChannel)
