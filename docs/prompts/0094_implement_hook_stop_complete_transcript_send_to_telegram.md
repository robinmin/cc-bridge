---
name: implement-hook-stop-complete-transcript-send-to-telegram
description: Complete implementation of hook_stop.py - read Claude transcript, parse response, send to Telegram via core/telegram.py
status: Done
created_at: 2025-02-02
updated_at: 2026-02-03 14:59:55
impl_progress:
  planning: completed
  design: completed
  implementation: completed
  review: pending
  testing: in_progress
dependencies: []
tags: [implementation, commands, telegram, hook, transcript, task-0006]
---

## WBS#_implement_hook_stop_complete_transcript_send_to_telegram

### Background

The `cc_bridge/commands/hook_stop.py` file is incomplete (55 lines) with TODO placeholders from Task 0006. This hook is essential for completing the "Stop Hook" workflow - when Claude Code finishes responding to a request, the hook reads the transcript and sends the response back to Telegram.

**Current state (incomplete):**
```python
def send_to_telegram(transcript_path: str) -> None:
    # TODO: Implement transcript reading and Telegram sending (Task 0006)
    transcript = Path(transcript_path)
    if not transcript.exists():
        raise FileNotFoundError(f"Transcript not found: {transcript_path}")
    content = transcript.read_text()
    # TODO: Parse transcript to extract Claude's response
    # TODO: Send response to Telegram via httpx
    print(f"Transcript content length: {len(content)}")
```

**Target workflow:**
1. User sends message via Telegram
2. Webhook forwards to Claude Code
3. Claude processes and responds
4. On completion, git hook calls `cc-bridge hook-stop <transcript_path>`
5. Hook parses transcript to extract Claude's response
6. Hook sends response back to Telegram

**Related:** This complements the webhook server (which handles real-time responses) by supporting the async "Stop Hook" pattern for longer-running commands.

### Requirements / Objectives

**Functional Requirements:**
- Implement `send_to_telegram()` function completely
- Parse Claude Code transcript format (see `core/parser.py`)
- Extract Claude's response from the transcript
- Handle response truncation for Telegram's 4096 char limit
- Send response to Telegram via `core/telegram.py`
- Get chat_id from config
- Handle errors gracefully
- Support both interactive and non-interactive modes

**Non-Functional Requirements:**
- Robust transcript parsing (handle various Claude Code output formats)
- Proper error handling (file not found, parse errors, send errors)
- Logging throughout
- Type hints
- Cross-platform compatibility

**Acceptance Criteria:**
- [ ] `send_to_telegram()` fully implemented
- [ ] Transcript parsing works (extracts Claude response)
- [ ] Response sent to Telegram successfully
- [ ] Long responses truncated with suffix message
- [ ] Error handling covers all failure modes
- [ ] Chat_id read from config correctly
- [ ] Uses `TelegramClient` from `core/telegram.py`
- [ ] Works with real Claude Code transcripts
- [ ] Unit tests for transcript parsing

### Solutions / Goals

**Technology Stack:**
- Python 3.11+
- Path (existing)
- httpx (via TelegramClient)
- Claude Code transcript format

**Implementation Approach:**

**Transcript Format (Claude Code):**
```
[User input transcript]
---
[Claude response]
```

**Core/telegram.py to use:**
- `TelegramClient` class with `send_message()` method
- Already has retry logic and error handling

**Core/parser.py role:**
- May need to extend or create transcript parsing functions
- Extract Claude's response from full transcript

#### Plan

**Phase 1: Understand transcript format**
- [ ] Read example Claude Code transcripts
- [ ] Document transcript structure
- [ ] Identify Claude response markers
- [ ] Check existing `core/parser.py` for relevant functions

**Phase 2: Implement transcript parsing**
- [ ] Add `parse_claude_transcript()` function to `core/parser.py` OR
- [ ] Add parsing logic to `hook_stop.py` directly
- [ ] Extract Claude's response from transcript
- [ ] Handle various output formats (code blocks, etc.)
- [ ] Handle edge cases (empty response, errors)

**Phase 3: Implement send_to_telegram()**
- [ ] Read transcript file
- [ ] Parse to extract Claude response
- [ ] Get chat_id from config
- [ ] Create TelegramClient instance
- [ ] Truncate response if > 4096 chars
- [ ] Send response via TelegramClient
- [ ] Handle errors gracefully

**Phase 4: Update main()**
- [ ] Ensure proper exit codes
- [ ] Add error messages to stderr
- [ ] Add logging

**Phase 5: Testing**
- [ ] Test with real Claude Code transcript
- [ ] Test with non-existent file
- [ ] Test with malformed transcript
- [ ] Test with long response (> 4096 chars)
- [ ] Test with Telegram webhook
- [ ] Unit tests for parsing logic

### References

- Current incomplete file: `/Users/robin/xprojects/cc-bridge/cc_bridge/commands/hook_stop.py`
- Telegram client: `/Users/robin/xprojects/cc-bridge/cc_bridge/core/telegram.py`
- Parser module: `/Users/robin/xprojects/cc-bridge/cc_bridge/core/parser.py`
- Config: `/Users/robin/xprojects/cc-bridge/cc_bridge/config.py`
- Original task: `/Users/robin/xprojects/cc-bridge/docs/prompts/0006_MVP_commands:_hook-stop_command.md`
- Claude Code transcript format (to be documented during implementation)
