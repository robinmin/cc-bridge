---
name: deprecate-or-consolidate-bot-command-move-to-telegram-client
description: Evaluate and deprecate bot.py command - move set_bot_commands to TelegramClient, remove duplicate main() function
status: Done
created_at: 2025-02-02
updated_at: 2025-02-02
impl_progress:
  planning: completed
  design: completed
  implementation: completed
  review: completed
  testing: completed
dependencies: []
tags: [deprecation, architecture, commands, telegram, cleanup]
---

## WBS#_deprecate_or_consolidate_bot_command_move_to_telegram_client

### Background

The `cc_bridge/commands/bot.py` file (127 lines) provides Telegram bot command synchronization, but this functionality is rarely used manually. Users typically interact with bot commands directly through Telegram, not through a CLI sync command.

**Current state:**
- `commands/bot.py` contains:
  - `set_bot_commands()` async function (lines 12-30)
  - `get_default_commands()` function (lines 33-46)
  - `sync` Typer command (lines 49-68)
  - `list` Typer command (lines 71-79)
  - **Duplicate `main()` function** (lines 82-122) with logic that duplicates the Typer commands

**Problems:**
1. Bot commands are rarely synced manually (most users never need this)
2. The `main()` function duplicates the Typer command logic
3. The `set_bot_commands()` function should be in `TelegramClient` for consistency
4. Adds CLI surface area for rarely-used functionality

**Use case analysis:**
- Bot commands are set during setup wizard
- Bot commands rarely change after initial setup
- Telegram Bot API allows users to see commands in the app
- Manual sync is only needed when adding/removing commands

### Requirements / Objectives

**Functional Requirements:**
- Move `set_bot_commands()` to `TelegramClient` class in `core/telegram.py`
- Move `get_default_commands()` to `core/telegram.py` as module constant
- Evaluate whether to keep or deprecate the CLI command
- If keeping, remove duplicate `main()` function
- If deprecating, ensure setup wizard can still set commands

**Non-Functional Requirements:**
- Maintain backward compatibility if command is kept
- Ensure setup wizard still works
- Document deprecation if removing

**Acceptance Criteria:**
- [ ] Evaluation document created with recommendation
- [ ] `set_bot_commands()` moved to `TelegramClient` or documented as removed
- [ ] `get_default_commands()` moved or documented as removed
- [ ] Duplicate `main()` function removed
- [ ] Decision made on deprecation vs keeping
- [ ] Setup wizard still sets bot commands
- [ ] Documentation updated

### Solutions / Goals

**Technology Stack:**
- Python 3.11+
- httpx (existing, via TelegramClient)
- typer (existing)

**Evaluation:**

**Arguments for deprecation:**
- Rarely used feature (most users never touch bot commands after setup)
- Bot commands can be set once during setup and never changed
- Reduces CLI surface area
- Removes duplicate code

**Arguments for keeping:**
- Provides manual way to fix bot commands if they get out of sync
- Useful for development/testing
- Low maintenance burden

**Recommendation: KEEP but simplify.** Remove duplicate `main()` function, move logic to `TelegramClient`, keep CLI as a convenience for advanced users.

#### Plan

**Phase 1: Move logic to core/telegram.py**
- [ ] Add `DEFAULT_BOT_COMMANDS` constant to `core/telegram.py`
- [ ] Add `set_bot_commands()` method to `TelegramClient` class
- [ ] Add `get_bot_commands()` method to `TelegramClient` class
- [ ] Add comprehensive docstrings

**Phase 2: Simplify commands/bot.py**
- [ ] Import from `core.telegram`
- [ ] Remove `set_bot_commands()` function (use TelegramClient)
- [ ] Remove `get_default_commands()` function (use constant)
- [ ] **Remove duplicate `main()` function** (lines 82-122)
- [ ] Keep Typer commands (`sync`, `list`) as convenience
- [ ] Update commands to use TelegramClient methods
- [ ] Add deprecation notice if appropriate

**Phase 3: Update setup wizard**
- [ ] Ensure `commands/setup.py` uses TelegramClient.set_bot_commands()
- [ ] Test setup wizard bot command configuration

**Phase 4: Testing**
- [ ] Run `cc-bridge bot sync`
- [ ] Run `cc-bridge bot list`
- [ ] Test setup wizard with bot commands
- [ ] Verify Telegram bot has correct commands
- [ ] Run existing test suite

### Alternative: Full Deprecation

If the decision is to deprecate entirely:

1. Move logic to `TelegramClient` (as above)
2. Remove `commands/bot.py` entirely
3. Update setup wizard to use `TelegramClient.set_bot_commands()`
4. Document deprecation in changelog
5. Update any documentation referencing `cc-bridge bot`

### References

- Current bot command: `/Users/robin/xprojects/cc-bridge/cc_bridge/commands/bot.py`
- Telegram client: `/Users/robin/xprojects/cc-bridge/cc_bridge/core/telegram.py`
- Setup wizard: `/Users/robin/xprojects/cc-bridge/cc_bridge/commands/setup.py`
- Original task: `/Users/robin/xprojects/cc-bridge/docs/prompts/0013_Extended_commands:_bot_command.md`
- Analysis plan: `/Users/robin/xprojects/cc-bridge/docs/prompts/0090_commands_folder_analysis_plan.md`
- Telegram Bot API: https://core.telegram.org/bots/api#setmycommands
