# Webhook Message Processing Implementation

## Overview

This document describes the implementation of Task #0005: Webhook message processing for cc-bridge. This feature enables Telegram messages to flow through to Claude Code instances and receive responses back.

## What Was Implemented

### 1. Enhanced TmuxSession (`cc_bridge/core/tmux.py`)

**New Features:**
- Custom socket path support (matches cc-bridge's tmux socket location)
- Async `send_command_and_wait()` method for command execution with response capture
- `get_last_lines()` for retrieving recent output
- Better error handling and logging
- `get_session()` helper function to get sessions by instance name

**Key Methods:**
```python
async def send_command_and_wait(
    self,
    command: str,
    timeout: float = 30.0,
    prompt_marker: str = ">"
) -> tuple[bool, str]:
    """Send command and wait for Claude to finish processing."""
```

### 2. Webhook Endpoint (`cc_bridge/commands/server.py`)

**Features:**
- FastAPI lifespan management for initialization
- Pydantic model validation for Telegram updates
- Chat ID authorization checking
- Instance discovery and validation
- Message injection into Claude Code
- Response capture and cleaning
- Error handling and timeout management
- Response truncation for Telegram limits (4096 chars)

**Flow:**
```
1. Receive webhook POST with update
2. Parse using Pydantic Update model
3. Extract message.text and message.chat.id
4. Verify chat_id is authorized
5. Find running Claude instance
6. Send command via tmux send-keys
7. Wait for response (capture-pane polling)
8. Clean output (remove prompts, etc.)
9. Send back to Telegram via sendMessage
```

## Configuration

Required environment variables (set by `cc-bridge setup`):
```bash
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
```

## Testing the Implementation

### Prerequisites

1. Run setup (if not already done):
```bash
cc-bridge setup
```

2. Start a Claude instance:
```bash
cc-bridge claude start my-instance
```

3. Start the server:
```bash
cc-bridge server
```

### Test Flow

1. Send a message to your Telegram bot
2. The message should:
   - Reach the webhook endpoint (check server logs)
   - Be injected into the Claude instance
   - Receive a response from Claude
   - Be sent back to Telegram

### Expected Server Logs

```
INFO:     127.0.0.1:53568 - "POST /webhook HTTP/1.1" 200 OK
INFO:     cc_bridge.commands.server - Received message - chat_id=123456789
INFO:     cc_bridge.commands.server - Sending to Claude - instance=my-instance
INFO:     cc_bridge.commands.server - Response sent - chat_id=123456789
```

## Troubleshooting

### "No Claude instance running"

Start an instance:
```bash
cc-bridge claude start my-instance
```

### "Instance session not running"

The tmux session may have stopped. Restart:
```bash
cc-bridge claude restart my-instance
```

### "Unauthorized chat ID"

Check your `TELEGRAM_CHAT_ID` in `.env` matches your actual Telegram chat ID.

### Command times out

- Long-running Claude responses may exceed the 60s timeout
- Check if Claude is waiting for input
- Increase timeout in `server.py` if needed

## Known Limitations

1. **Single Instance**: Uses first available instance. Multi-instance routing not implemented.
2. **No Message Queue**: Concurrent messages are sent immediately; could race in Claude.
3. **60s Timeout**: Very long Claude responses may time out.
4. **Simple Output Cleaning**: Basic prompt removal; may need refinement.

## Next Steps

1. **End-to-end testing** with actual Claude conversations
2. **Output cleaning refinement** for better Telegram formatting
3. **Multi-instance routing** (e.g., `/instance@name` command)
4. **Message queuing** for concurrent requests
5. **Streaming responses** for long Claude outputs

## Files Modified

- `cc_bridge/core/tmux.py` - Enhanced with async support
- `cc_bridge/commands/server.py` - Implemented webhook processing
- `docs/prompts/0005_MVP_commands:_server_command.md` - Task documentation
