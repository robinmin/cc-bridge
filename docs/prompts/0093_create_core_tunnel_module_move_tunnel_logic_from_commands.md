---
name: create-core-tunnel-module-move-tunnel-logic-from-commands
description: Create core/tunnel.py with CloudflareTunnelManager, move tunnel logic from commands/tunnel.py, consolidate webhook setting with core/telegram.py
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
tags: [refactoring, architecture, commands, delegation, tunnel, cloudflare]
---

## WBS#_create_core_tunnel_module_move_tunnel_logic_from_commands

### Background

The `cc_bridge/commands/tunnel.py` file (200 lines) contains Cloudflare tunnel management logic that should be in `cc_bridge/core/`. Additionally, webhook setting logic is duplicated across multiple files:
- `commands/tunnel.py:set_webhook()`
- `commands/webhook.py:set_webhook()`
- `core/telegram.py:TelegramClient.set_webhook()`

**Current state:**
- `commands/tunnel.py` contains:
  - `TUNNEL_URL_PATTERN` regex
  - `parse_tunnel_url()` function
  - `start_tunnel()` function (subprocess management)
  - `stop_tunnel()` function
  - `set_webhook()` async function (duplicates core/telegram.py)
  - `main()` CLI entry point

- `core/telegram.py` already has:
  - `TelegramClient.set_webhook()` method
  - `TelegramClient.get_webhook_info()` method
  - `TelegramClient.delete_webhook()` method
  - Full retry logic and error handling

**Problems:**
1. Tunnel logic trapped in command file (not reusable)
2. Webhook setting duplicated in 3 places
3. `commands/webhook.py` is essentially redundant
4. No clean separation between tunnel process management and CLI

### Requirements / Objectives

**Functional Requirements:**
- Create `cc_bridge/core/tunnel.py` with tunnel business logic
- Create `CloudflareTunnelManager` class for process management
- Move `parse_tunnel_url()` to core
- Move `start_tunnel()` and `stop_tunnel()` to CloudflareTunnelManager
- Consolidate webhook setting to use `core/telegram.py` only
- Keep `commands/tunnel.py` as thin CLI wrapper
- Consider deprecating `commands/webhook.py` (functionality exists elsewhere)

**Non-Functional Requirements:**
- Proper process lifecycle management (start/stop/cleanup)
- Error handling for cloudflared not installed
- Timeout handling for URL detection
- Logging throughout
- Type hints

**Acceptance Criteria:**
- [ ] `cc_bridge/core/tunnel.py` created with CloudflareTunnelManager
- [ ] `commands/tunnel.py` reduced to thin CLI wrapper (< 50 lines)
- [ ] Webhook setting consolidated to use `core/telegram.py`
- [ ] `cc-bridge tunnel --start` works
- [ ] `cc-bridge tunnel --stop` works
- [ ] Tunnel URL parsing and detection works
- [ ] Automatic webhook setting works
- [ ] All existing tests pass

### Solutions / Goals

**Technology Stack:**
- Python 3.11+
- subprocess (existing)
- re (existing)
- httpx (existing, via TelegramClient)
- asyncio (existing)

**Implementation Approach:**

**New `core/tunnel.py` structure:**
```python
# Constants
TUNNEL_URL_PATTERN = re.compile(...)

# Functions
def parse_tunnel_url(output: str) -> str | None

# Classes
class CloudflareTunnelManager:
    """Manages Cloudflare tunnel lifecycle."""
    def __init__(self, port: int = 8080, timeout: int = 30)
    async def start(self) -> str  # Returns tunnel URL
    def stop(self) -> None
    def is_running(self) -> bool
    @property
    def url(self) -> str | None
```

**Webhook consolidation:**
- `commands/tunnel.py` should use `TelegramClient.set_webhook()`
- `commands/webhook.py` can be deprecated (redundant)
- All webhook operations go through `core/telegram.py`

#### Plan

**Phase 1: Create core/tunnel.py**
- [ ] Create file with proper imports
- [ ] Add `TUNNEL_URL_PATTERN` constant
- [ ] Add `parse_tunnel_url()` function
- [ ] Create `CloudflareTunnelManager` class
- [ ] Implement `__init__()` method
- [ ] Implement `start()` async method (spawn cloudflared, monitor for URL)
- [ ] Implement `stop()` method (terminate process)
- [ ] Implement `is_running()` method
- [ ] Implement `url` property
- [ ] Add `__all__` exports
- [ ] Add comprehensive docstrings

**Phase 2: Refactor commands/tunnel.py**
- [ ] Import `CloudflareTunnelManager` from `core.tunnel`
- [ ] Import `TelegramClient` from `core.telegram` for webhook setting
- [ ] Rewrite `start_tunnel()` to use CloudflareTunnelManager
- [ ] Rewrite `stop_tunnel()` to use CloudflareTunnelManager
- [ ] Rewrite `set_webhook()` to use TelegramClient
- [ ] Keep `main()` as CLI entry point
- [ ] Update `main()` to auto-set webhook via TelegramClient
- [ ] Verify file is thin wrapper

**Phase 3: Deprecate commands/webhook.py (optional)**
- [ ] Assess if webhook.py is still needed
- [ ] Document deprecation if appropriate
- [ ] Update CLI if removing webhook command

**Phase 4: Testing**
- [ ] Test `cc-bridge tunnel --start`
- [ ] Test `cc-bridge tunnel --stop`
- [ ] Verify tunnel URL detection
- [ ] Test automatic webhook setting
- [ ] Test with cloudflared not installed
- [ ] Test timeout handling
- [ ] Run existing test suite

### References

- Current tunnel command: `/Users/robin/xprojects/cc-bridge/cc_bridge/commands/tunnel.py`
- Current webhook command: `/Users/robin/xprojects/cc-bridge/cc_bridge/commands/webhook.py`
- Telegram client: `/Users/robin/xprojects/cc-bridge/cc_bridge/core/telegram.py`
- Analysis plan: `/Users/robin/xprojects/cc-bridge/docs/prompts/0090_commands_folder_analysis_plan.md`
- Cloudflare docs: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/
