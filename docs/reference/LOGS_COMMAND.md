# Logs Command Documentation

## Overview

The `cc-bridge logs` command provides log viewing and filtering capabilities for the Claude Code Telegram Bridge. It supports both real-time log tailing and reading from existing log files with flexible filtering options.

## Features

- **View all logs**: Display all log entries from the configured log file
- **Filter by level**: Show only logs of a specific level (ERROR, INFO, etc.)
- **Filter by module**: Show only logs from a specific module (server, telegram, tmux, etc.)
- **JSON output**: Output logs in JSON format for programmatic parsing
- **Real-time tailing**: Follow log file as new entries are added
- **Custom file path**: Read from a specific log file instead of the configured one

## Installation

The logs command is part of the `cc-bridge` CLI. Ensure you have the bridge installed:

```bash
pip install -e .
```

## Configuration

By default, the logs command reads from the log file configured in `~/.claude/bridge/config.toml`:

```toml
[logging]
file = "/path/to/bridge.log"
```

Configure the log file path:

```bash
cc-bridge config logging.file /path/to/bridge.log
```

## Usage

### Basic Usage

View all logs from the configured file:

```bash
cc-bridge logs
```

### Filter by Log Level

Show only ERROR level logs:

```bash
cc-bridge logs --level ERROR
```

Supported levels: `DEBUG`, `INFO`, `WARNING`, `ERROR`, `CRITICAL`

### Filter by Module

Show only logs from the server module:

```bash
cc-bridge logs --module server
```

Common modules: `server`, `telegram`, `tmux`, `webhook`

### Combine Filters

Show ERROR logs from the tmux module:

```bash
cc-bridge logs --level ERROR --module tmux
```

### JSON Output

Output logs in JSON format:

```bash
cc-bridge logs --json
```

JSON format example:
```json
{"timestamp": "2026-01-26T20:45:23Z", "level": "INFO", "module": "server", "message": "Webhook received"}
```

### Read from Specific File

Read logs from a specific file instead of the configured one:

```bash
cc-bridge logs --file /var/log/bridge.log
```

### Real-time Tailing

Tail the log file in real-time (like `tail -f`):

```bash
cc-bridge logs --follow
```

Combine with filters:

```bash
cc-bridge logs --follow --level ERROR
```

Press `Ctrl+C` to stop following.

### Short Options

Use short options for brevity:

```bash
cc-bridge logs -f              # Follow mode
cc-bridge logs -l ERROR        # Filter by level
cc-bridge logs -m server       # Filter by module
cc-bridge logs -f -l ERROR     # Follow and filter
```

## Log Formats

The logs command supports two log formats:

### Text Format

```
2026-01-26 20:45:23 [INFO] server: Webhook received
2026-01-26 20:45:24 [ERROR] tmux: Session not found
```

### JSON Format

```json
{"timestamp":"2026-01-26T20:45:23Z","level":"INFO","module":"server","message":"Webhook received"}
```

The command automatically detects which format is being used.

## Examples

### Monitor Errors in Real-time

```bash
cc-bridge logs --follow --level ERROR
```

Useful for debugging issues as they occur.

### Check Webhook Activity

```bash
cc-bridge logs --module webhook
```

See all webhook-related log entries.

### Export Logs for Analysis

```bash
cc-bridge logs --json > logs.json
```

Export logs in JSON format for external analysis tools.

### Debug Connection Issues

```bash
cc-bridge logs --level ERROR --module telegram
```

Focus on Telegram-related errors.

### View Recent Logs

```bash
cc-bridge logs | tail -20
```

Show the last 20 log entries.

### Search for Specific Messages

```bash
cc-bridge logs | grep "timeout"
```

Search for logs containing specific text.

## Exit Codes

- `0`: Command executed successfully
- `1`: Error occurred (e.g., log file not found, configuration error)

## Troubleshooting

### "Log file does not exist"

This error occurs when the configured log file doesn't exist.

**Solutions:**
1. Check the configured path: `cc-bridge config logging.file`
2. Create the log file: `touch /path/to/bridge.log`
3. Set a valid log file: `cc-bridge config logging.file /path/to/bridge.log`

### "No logs found matching the specified filters"

This message appears when no log entries match your filters.

**Solutions:**
1. Try broader filters (remove `--level` or `--module`)
2. Check if the log file has content: `cat /path/to/bridge.log`
3. View all logs: `cc-bridge logs`

### Follow mode not showing new logs

If follow mode isn't showing new entries:

**Solutions:**
1. Verify the application is writing to the log file
2. Check file permissions: `ls -l /path/to/bridge.log`
3. Try reading from the file first: `cc-bridge logs` (without `--follow`)

## Integration with Logging

To enable logging in your bridge application, configure Python's logging:

```python
import logging
from pathlib import Path

# Configure logging
log_file = Path.home() / '.claude' / 'bridge.log'
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
    handlers=[
        logging.FileHandler(log_file),
        logging.StreamHandler()
    ]
)

# Use logging in your code
logger = logging.getLogger('server')
logger.info('Webhook received')
logger.error('Connection failed')
```

## API Usage

You can also use the logs functionality programmatically:

```python
from logs import LogsCommand, parse_log_line, filter_log_entry
from pathlib import Path

# Create logs command instance
cmd = LogsCommand(
    log_file=Path('bridge.log'),
    follow=False,
    level='ERROR',
    module='tmux'
)

# Run the command
cmd.run()

# Parse individual log lines
line = '2026-01-26 20:45:23 [INFO] server: Webhook received'
entry = parse_log_line(line)
print(entry)  # {'timestamp': '...', 'level': 'INFO', ...}

# Filter log entries
if filter_log_entry(entry, level='ERROR'):
    print("This is an error log")
```

## See Also

- [Configuration Documentation](README.md#config)
- [Health Check Command](README.md#health-check)
- [Server Command](README.md#server)
