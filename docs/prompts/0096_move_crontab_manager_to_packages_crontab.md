---
name: move-crontab-manager-to-packages-crontab
description: Move CrontabManager class from commands/cron.py to cc_bridge/packages/crontab.py for better reusability
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
tags: [refactoring, architecture, commands, packages, crontab]
---

## WBS#_move_crontab_manager-to-packages-crontab

### Background

The `cc_bridge/commands/cron.py` file (203 lines) contains the `CrontabManager` class, a reusable utility for safe crontab modification with backup and rollback capabilities. This class should be in `cc_bridge/packages/` as it's a general-purpose utility that could be used by other modules.

**Current state:**
- `commands/cron.py` contains `CrontabManager` class (lines 15-202)
- Full-featured with:
  - `_get_current_crontab()` - Read current crontab
  - `_backup_crontab()` - Backup to file
  - `_validate_entry()` - Validate crontab entry format
  - `add_entry()` - Add new crontab entry
  - `remove_entry()` - Remove CC-BRIDGE entries
  - `has_entries()` - Check if entries exist
  - `restore_backup()` - Restore from backup
- Used by `setup.py` (setup wizard) for configuring periodic health checks

**Problem:** The `CrontabManager` is trapped in the command file, making it harder to reuse. The `packages/` directory is specifically for "Reusable cross-cutting utilities."

**Note:** The cron.py file has no CLI command - it's only used by setup.py. After moving `CrontabManager`, the `commands/cron.py` file may be removed entirely or kept as a thin wrapper if needed.

### Requirements / Objectives

**Functional Requirements:**
- Move `CrontabManager` class to `cc_bridge/packages/crontab.py`
- Keep all existing functionality intact
- Update imports in `commands/setup.py`
- Update imports in `commands/cron.py` (if kept)
- Add comprehensive docstrings
- Consider whether to keep `commands/cron.py` after move

**Non-Functional Requirements:**
- No breaking changes to setup wizard
- Crontab operations continue to work
- Backup/restore functionality preserved
- Follow existing patterns in `packages/`

**Acceptance Criteria:**
- [ ] `cc_bridge/packages/crontab.py` created with `CrontabManager`
- [ ] `commands/setup.py` imports from `packages.crontab`
- [ ] Setup wizard crontab configuration works
- [ ] Backup/restore functionality works
- [ ] All existing tests pass
- [ ] Decision made on whether to keep `commands/cron.py`

### Solutions / Goals

**Technology Stack:**
- Python 3.11+
- subprocess (existing)
- pathlib (existing)

**Implementation Approach:**

**New `packages/crontab.py` structure:**
```python
"""
Crontab management utilities for cc-bridge.

This module provides safe crontab modification with backup and rollback capabilities.
"""

# Classes
class CrontabManager:
    """Manager for system crontab modifications."""

    # All existing methods preserved:
    # - __init__()
    # - _get_current_crontab()
    # - _backup_crontab()
    # - _validate_entry()
    # - add_entry()
    # - remove_entry()
    # - has_entries()
    # - restore_backup()
```

**After move, decide on `commands/cron.py`:**
- **Option 1:** Remove entirely (no CLI command, only used by setup.py)
- **Option 2:** Keep as thin wrapper importing from packages (for potential future CLI use)

**Recommendation:** Option 1 - Remove `commands/cron.py` entirely. The class is only used internally by setup.py and doesn't need a CLI command wrapper.

#### Plan

**Phase 1: Create packages/crontab.py**
- [ ] Create file with proper imports
- [ ] Copy `CrontabManager` class
- [ ] Update module docstring
- [ ] Add comprehensive docstrings for class and methods
- [ ] Add `__all__` exports
- [ ] Verify all methods work in new location

**Phase 2: Update imports**
- [ ] Update `commands/setup.py` to import from `packages.crontab`
- [ ] Test setup wizard crontab functionality
- [ ] If keeping `commands/cron.py`, update its imports too

**Phase 3: Decide on commands/cron.py**
- [ ] Assess whether file is still needed
- [ ] If not needed, delete `commands/cron.py`
- [ ] If keeping, make it a thin wrapper or add CLI commands

**Phase 4: Testing**
- [ ] Run setup wizard with crontab option
- [ ] Verify crontab entry is added
- [ ] Verify backup file is created
- [ ] Test crontab entry removal
- [ ] Test backup restoration
- [ ] Verify cron health checks run
- [ ] Run existing test suite

### References

- Current cron command: `/Users/robin/xprojects/cc-bridge/cc_bridge/commands/cron.py`
- Setup command: `/Users/robin/xprojects/cc-bridge/cc_bridge/commands/setup.py`
- Packages pattern: `/Users/robin/xprojects/cc-bridge/cc_bridge/packages/`
- Analysis plan: `/Users/robin/xprojects/cc-bridge/docs/prompts/0090_commands_folder_analysis_plan.md`
