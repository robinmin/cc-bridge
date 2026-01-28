# Hook-Stop Command

## Overview

The `hook-stop` command replaces the bash script (`hooks/send-to-telegram.sh`) with a Python implementation. It reads Claude Code transcripts, extracts the assistant's response, formats it as HTML, and sends it to Telegram.

## Installation

### 1. Install the package

```bash
cd /path/to/claudecode-telegram
pip install -e .
```

### 2. Configure Claude Code hooks

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "hook-stop"
          }
        ]
      }
    ]
  }
}
```

## How It Works

1. **Reads transcript path from JSON stdin**
   - Claude Code passes the transcript path via stdin
   - Format: `{"transcript_path": "/path/to/transcript.jsonl"}`

2. **Checks pending file flag**
   - Only responds to Telegram-initiated messages
   - Pending file: `~/.claude/telegram_pending`
   - Timeout: 10 minutes (600 seconds)

3. **Extracts assistant's response**
   - Finds last user message in transcript
   - Extracts all assistant messages after that point
   - Filters text content (ignores images, tool use, etc.)

4. **Formats as HTML**
   - Code blocks: `<pre><code class="language-python">...</code></pre>`
   - Inline code: `<code>...</code>`
   - Bold: `<b>...</b>`
   - Italic: `<i>...</i>`
   - HTML escaping: `<` → `&lt;`, `>` → `&gt;`, `&` → `&amp;`

5. **Sends to Telegram**
   - Uses Telegram Bot API
   - Truncates to 4000 characters if needed
   - Fallback to plain text if HTML parsing fails

6. **Cleans up**
   - Deletes pending file after sending

## Core Modules

### `telegram.py`

Telegram API client for sending messages.

```python
from claudecode_telegram.telegram import send_message

send_message(
    chat_id="123456789",
    text="<b>Hello!</b>",
    parse_mode="HTML"
)
```

**Features:**
- HTTP-based API calls using `httpx`
- Automatic message truncation (4096 char limit)
- HTML parse mode with fallback to plain text
- Error handling with logging

### `parser.py`

Markdown to HTML conversion for Telegram.

```python
from claudecode_telegram.parser import markdown_to_html

html = markdown_to_html("**Bold** and `code`")
# Returns: "<b>Bold</b> and <code>code</code>"
```

**Supported Markdown:**
- Code blocks with language: ````python ... ````
- Inline code: `` `code` ``
- Bold: `**text**`
- Italic: `*text*`
- HTML escaping for security

### `hook_stop.py`

Main command implementation.

```python
from claudecode_telegram.hook_stop import main

# Reads from JSON stdin
main()
```

**Workflow:**
1. Parse JSON input for transcript path
2. Check pending file exists and is recent
3. Read chat ID from file
4. Extract response from transcript
5. Convert markdown to HTML
6. Send to Telegram
7. Clean up pending file

## Testing

### Run all tests

```bash
pytest tests/ -v
```

### Run specific test file

```bash
pytest tests/test_hook_stop.py -v
```

### Run with coverage

```bash
pytest tests/ --cov=claudecode_telegram --cov-report=html
```

## Acceptance Criteria

- [x] Reads transcript path from JSON stdin
- [x] Checks pending file (timestamp < 10 min)
- [x] Finds last user message in transcript
- [x] Extracts assistant messages after that
- [x] Formats as HTML (code blocks, inline code, bold, italic)
- [x] Truncates to 4000 chars
- [x] Sends to Telegram
- [x] Deletes pending file
- [x] All tests pass
- [x] Type checking passes

## Comparison with Bash Script

### Bash Script Limitations

1. **Fragile parsing**: Uses `grep`, `tail`, `jq` pipeline
2. **Error handling**: Limited error recovery
3. **Maintenance**: Hard to extend and test
4. **Security**: Shell injection risks

### Python Implementation Benefits

1. **Robust parsing**: Native JSON handling
2. **Comprehensive testing**: Unit and integration tests
3. **Maintainability**: Modular, documented code
4. **Security**: Proper HTML escaping and input validation
5. **Extensibility**: Easy to add new features

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | - | Bot token from @BotFather |

## Files

- `~/.claude/telegram_chat_id` - Chat ID for sending messages
- `~/.claude/telegram_pending` - Timestamp flag for Telegram-initiated messages
- Transcript files - Claude Code conversation history (JSONL format)

## Troubleshooting

### No response sent

1. Check pending file exists: `ls -la ~/.claude/telegram_pending`
2. Check pending file timestamp: `cat ~/.claude/telegram_pending`
3. Check chat ID file: `cat ~/.claude/telegram_chat_id`
4. Check bot token: `echo $TELEGRAM_BOT_TOKEN`

### HTML not rendering

1. Verify message is not too long (>4000 chars)
2. Check for malformed HTML in markdown
3. Telegram will auto-fallback to plain text if HTML parsing fails

### Tests failing

1. Ensure dependencies installed: `pip install -e ".[dev]"`
2. Check Python version: `python --version` (must be >=3.10)
3. Run with verbose output: `pytest -vv`
