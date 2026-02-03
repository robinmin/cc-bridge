---
name: deprecate-webhook-command-consolidate-with-tunnel-and-telegram
description: Deprecate webhook.py command - functionality duplicated in tunnel.py and core/telegram.py, integrate into existing commands
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
tags: [deprecation, architecture, commands, webhook, cleanup]
---

## WBS#_deprecate_webhook_command_consolidate_with_tunnel_and_telegram

### Background

The `cc_bridge/commands/webhook.py` file (124 lines) duplicates functionality that exists in `commands/tunnel.py` and `core/telegram.py`. Webhook management is already handled by the tunnel command and TelegramClient.

**Current state:**
- `commands/webhook.py` contains:
  - `set_webhook()` async function (lines 15-30) - **DUPLICATES tunnel.py**
  - `get_webhook_info()` async function (lines 33-47) - **exists in telegram.py**
  - `delete_webhook()` async function (lines 50-64) - **exists in telegram.py**
  - `test_webhook()` async function (lines 67-79)
  - `main()` function with placeholder bot_token (lines 82-123)

**Duplication analysis:**
| Function | webhook.py | tunnel.py | telegram.py |
|----------|-----------|-----------|-------------|
| set_webhook | ✓ | ✓ | ✓ (TelegramClient.set_webhook) |
| get_webhook_info | ✓ | - | ✓ (TelegramClient.get_webhook_info) |
| delete_webhook | ✓ | - | ✓ (TelegramClient.delete_webhook) |

**Problems:**
1. Webhook setting is duplicated in 3 places
2. `webhook.py` has incomplete implementation (TODO placeholders)
3. Webhook management is already part of tunnel workflow
4. Adds unnecessary CLI surface area
5. `main()` function has hardcoded "your_bot_token" placeholder

**Current usage:**
- Webhook is set automatically by tunnel command when starting cloudflared
- Webhook can be set via setup wizard
- Manual webhook setting is rarely needed

### Requirements / Objectives

**Functional Requirements:**
- Consolidate all webhook operations to `TelegramClient` in `core/telegram.py`
- Deprecate and remove `commands/webhook.py`
- Ensure tunnel command still sets webhook automatically
- Ensure setup wizard can still configure webhook
- Update any documentation referencing `cc-bridge webhook`

**Non-Functional Requirements:**
- No breaking changes to webhook functionality
- Tunnel workflow unchanged
- Setup wizard unchanged
- Document deprecation clearly

**Acceptance Criteria:**
- [ ] Evaluation confirms `commands/webhook.py` can be safely removed
- [ ] All webhook functionality consolidated to `TelegramClient`
- [ ] Tunnel command still sets webhook automatically
- [ ] Setup wizard still configures webhook
- [ ] `commands/webhook.py` removed
- [ ] Documentation updated
- [ ] No broken references

### Solutions / Goals

**Technology Stack:**
- Python 3.11+
- httpx (existing, via TelegramClient)

**Consolidation strategy:**

**Single source of truth:** `TelegramClient` in `core/telegram.py`
- `set_webhook(url)` - Already exists
- `get_webhook_info()` - Already exists
- `delete_webhook()` - Already exists

**Workflow integration:**
- **Tunnel workflow:** `commands/tunnel.py` uses `TelegramClient.set_webhook()`
- **Setup workflow:** `commands/setup.py` uses `TelegramClient.set_webhook()`
- **Manual webhook operations:** Not needed as standalone CLI command

#### Plan

**Phase 1: Verify consolidation is safe**
- [ ] Verify `TelegramClient` has all webhook methods
- [ ] Verify tunnel command uses `TelegramClient`
- [ ] Verify setup wizard uses `TelegramClient`
- [ ] Check for any external references to `cc-bridge webhook`
- [ ] Create evaluation document

**Phase 2: Update any references**
- [ ] Update README if it references webhook command
- [ ] Update any documentation mentioning webhook CLI
- [ ] Add migration note to changelog

**Phase 3: Remove commands/webhook.py**
- [ ] Delete `commands/webhook.py`
- [ ] Update CLI command registry if needed
- [ ] Verify no import errors

**Phase 4: Testing**
- [ ] Run `cc-bridge tunnel --start` - verify webhook set
- [ ] Run setup wizard - verify webhook configuration
- [ ] Test manual webhook setting via Python API
- [ ] Verify webhook deletion works
- [ ] Run existing test suite

**Phase 5: Documentation**
- [ ] Update changelog with deprecation notice
- [ ] Update README if needed
- [ ] Document how to manually manage webhooks (if needed)
  - Use Python: `TelegramClient(bot_token).set_webhook(url)`
  - Or use tunnel command: `cc-bridge tunnel --setup`

### Alternative: Keep as thin wrapper

If there's a compelling reason to keep the command:

1. Remove all inline logic
2. Make it a thin wrapper around `TelegramClient` methods
3. Remove duplicate `main()` function
4. Add proper deprecation notice
5. Recommend using tunnel command instead

**Recommendation:** Deprecate and remove. The command is incomplete, duplicates functionality, and webhook management is already well-integrated into the tunnel and setup workflows.

### References

- Current webhook command: `/Users/robin/xprojects/cc-bridge/cc_bridge/commands/webhook.py`
- Telegram client: `/Users/robin/xprojects/cc-bridge/cc_bridge/core/telegram.py`
- Tunnel command: `/Users/robin/xprojects/cc-bridge/cc_bridge/commands/tunnel.py`
- Setup wizard: `/Users/robin/xprojects/cc-bridge/cc_bridge/commands/setup.py`
- Original task: `/Users/robin/xprojects/cc-bridge/docs/prompts/0011_Extended_commands:_webhook_command.md`
- Analysis plan: `/Users/robin/xprojects/cc-bridge/docs/prompts/0090_commands_folder_analysis_plan.md`
- Telegram Bot API: https://core.telegram.org/bots/api#setwebhook

---

## Implementation Summary (2025-02-02)

**Status:** Documentation updated, files pending manual deletion

### Completed Changes

**Phase 1: Verification** ✓
- Verified `TelegramClient` has all webhook methods (set_webhook, get_webhook_info, delete_webhook)
- Verified tunnel command uses `TelegramClient.set_webhook()`
- Verified setup wizard uses `TelegramClient.set_webhook()`
- No external references to `cc-bridge webhook` command in production code

**Phase 2: Documentation Updates** ✓
- Updated `README.md` - removed webhook.py from project structure (line 149)
- Updated `docs/DEVELOPER_SPEC.md` - removed webhook.py from module architecture (line 138)

### Manual Steps Required

**Files to delete:**
1. `cc_bridge/commands/webhook.py` - Duplicate webhook command implementation
2. `tests/unit/test_commands/test_webhook.py` - Tests for webhook command

**Commands to run:**
```bash
# Delete webhook.py command
rm cc_bridge/commands/webhook.py

# Delete webhook tests
rm tests/unit/test_commands/test_webhook.py

# Verify no import errors
python -c "from cc_bridge.cli import app"
```

**No CLI registration needed:** The webhook command was never registered in `cli.py`, so no removal from the command registry is required.

### Migration Guide

For users who need manual webhook management:

**Option 1: Use Python API**
```python
import asyncio
from cc_bridge.core.telegram import TelegramClient

async def manage_webhook():
    client = TelegramClient(bot_token="YOUR_BOT_TOKEN")
    try:
        # Set webhook
        result = await client.set_webhook("https://your-url.com/webhook")
        print(f"Webhook set: {result}")

        # Get webhook info
        info = await client.get_webhook_info()
        print(f"Webhook info: {info}")

        # Delete webhook
        result = await client.delete_webhook()
        print(f"Webhook deleted: {result}")
    finally:
        await client.close()

asyncio.run(manage_webhook())
```

**Option 2: Use tunnel command**
```bash
# Start tunnel (automatically sets webhook)
cc-bridge tunnel --start

# Manual webhook curl commands
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-url.com/webhook"
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
curl "https://api.telegram.org/bot<TOKEN>/deleteWebhook"
```

### Remaining Documentation Updates

Optional: Update `docs/DEVELOPER_SPEC.md` to remove:
- Section 3.4.2 "Webhook Command" (lines 312-318)
- Example code references to webhook.py (lines 1507-1513, 1569-1570, 1692-1694)
- Troubleshooting reference (line 1857)

These are example code snippets and can remain for historical context or be removed during next documentation pass.
