# Logs Command Quick Reference

## Basic Commands

```bash
# View all logs
cc-bridge logs

# Tail logs in real-time
cc-bridge logs --follow
cc-bridge logs -f

# Filter by level
cc-bridge logs --level ERROR
cc-bridge logs -l ERROR

# Filter by module
cc-bridge logs --module server
cc-bridge logs -m server

# Combine filters
cc-bridge logs --level ERROR --module tmux

# JSON output
cc-bridge logs --json

# Custom file
cc-bridge logs --file /path/to/log.txt
```

## Options

| Option | Short | Description |
|--------|-------|-------------|
| `--follow` | `-f` | Tail log file in real-time |
| `--level` | `-l` | Filter by log level (ERROR, INFO, etc.) |
| `--module` | `-m` | Filter by module name |
| `--json` | | Output in JSON format |
| `--file` | | Read from specific file |

## Log Levels

- `DEBUG` - Detailed debugging information
- `INFO` - General informational messages
- `WARNING` - Warning messages
- `ERROR` - Error messages
- `CRITICAL` - Critical errors

## Common Modules

- `server` - Webhook server messages
- `telegram` - Telegram API messages
- `tmux` - tmux session messages
- `webhook` - Webhook-related messages

## Examples

### Monitor Errors
```bash
cc-bridge logs --follow --level ERROR
```

### Check Server Activity
```bash
cc-bridge logs --module server
```

### Export Logs
```bash
cc-bridge logs --json > logs.json
```

### Recent Errors
```bash
cc-bridge logs --level ERROR | tail -20
```

### Search Logs
```bash
cc-bridge logs | grep "timeout"
```

## Configuration

Set default log file:
```bash
cc-bridge config logging.file /path/to/bridge.log
```

Check current log file:
```bash
cc-bridge config logging.file
```

## Troubleshooting

### Log file not found
```bash
# Check configured path
cc-bridge config logging.file

# Set correct path
cc-bridge config logging.file /correct/path/to/bridge.log
```

### No logs matching filters
```bash
# Try without filters
cc-bridge logs

# Check file has content
cat /path/to/bridge.log
```

### Follow mode not working
```bash
# Check app is writing to log
tail -f /path/to/bridge.log

# Check file permissions
ls -l /path/to/bridge.log
```
