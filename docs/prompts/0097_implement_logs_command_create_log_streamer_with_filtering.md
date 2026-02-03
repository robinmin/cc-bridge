---
name: implement-logs-command-create-log-streamer-with-filtering
description: Complete implementation of logs.py command - implement stream_logs() function, create core/log_streamer.py with filtering
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
tags: [implementation, commands, logs, filtering, task-0012]
---

## WBS#_implement-logs-command_create_log_streamer_with_filtering

### Background

The `cc_bridge/commands/logs.py` file is incomplete (42 lines) with TODO placeholders from Task 0012. This command would be useful for monitoring cc-bridge logs without having to manually find and tail log files.

**Current state (incomplete):**
```python
def stream_logs(log_file: str, follow: bool = True) -> None:
    # TODO: Implement log streaming (Task 0012)
    log_path = Path(log_file).expanduser()
    print(f"Streaming logs from {log_path}...")

def main(follow: bool = True) -> int:
    # TODO: Get log file from config (Task 0012)
    log_file = "~/.claude/bridge/logs/bridge.log"
    stream_logs(log_file, follow)
```

**Target workflow:**
1. User runs `cc-bridge logs` to monitor logs
2. Command streams log file to stdout with optional tail -f behavior
3. User can filter by log level, component, or search pattern
4. Logs are color-coded for readability

### Requirements / Objectives

**Functional Requirements:**
- Implement `stream_logs()` function completely
- Create `cc_bridge/core/log_streamer.py` with log streaming logic
- Support `--follow` mode (like tail -f)
- Support `--lines` option (show last N lines before following)
- Add filtering capabilities:
  - Filter by log level (DEBUG, INFO, WARNING, ERROR)
  - Filter by component/module
  - Filter by search pattern/text
- Add color coding for log levels
- Get log file path from config
- Handle non-existent log files gracefully

**Non-Functional Requirements:**
- Efficient file handling (don't load entire file for tail)
- Responsive to Ctrl+C
- Cross-platform compatibility
- Type hints
- Error handling

**Acceptance Criteria:**
- [ ] `stream_logs()` fully implemented
- [ ] `core/log_streamer.py` created with streaming logic
- [ ] `cc-bridge logs` shows logs
- [ ] `cc-bridge logs --follow` follows logs (tail -f behavior)
- [ ] `cc-bridge logs --level ERROR` filters by level
- [ ] `cc-bridge logs --pattern "webhook"` filters by pattern
- [ ] Color coding works for different log levels
- [ ] Handles non-existent log files gracefully
- [ ] Unit tests for filtering logic

### Solutions / Goals

**Technology Stack:**
- Python 3.11+
- pathlib (existing)
- asyncio (for non-blocking file monitoring)
- re (for pattern filtering)
- colorama/termcolor (for color coding)

**Implementation Approach:**

**New `core/log_streamer.py` structure:**
```python
# Constants
DEFAULT_LOG_PATH = "~/.claude/bridge/logs/bridge.log"

# Classes
class LogFilter:
    """Filter for log entries."""
    def __init__(self, level: str | None = None, component: str | None = None,
                 pattern: str | None = None)
    def matches(self, line: str) -> bool

class LogStreamer:
    """Stream log files with filtering and color coding."""
    def __init__(self, log_file: Path, filter: LogFilter | None = None)
    def tail(self, lines: int = 10) -> None  # Show last N lines
    async def follow(self) -> None  # Like tail -f
    def format_line(self, line: str) -> str  # Add colors

# Functions
async def stream_logs(log_file: str, follow: bool = True,
                      lines: int = 10, filter: LogFilter | None = None) -> None
```

**CLI interface (commands/logs.py):**
```python
@app.command()
def logs(
    follow: bool = typer.Option(True, "--follow/--no-follow", "-f"),
    lines: int = typer.Option(10, "--lines", "-n"),
    level: str = typer.Option(None, "--level", "-l"),
    pattern: str = typer.Option(None, "--pattern", "-p"),
):
    """Stream cc-bridge logs."""
```

**Log format assumptions:**
- JSON logs from `packages/logging.py`
- Structure: `{"timestamp": "...", "level": "INFO", "message": "..."}`
- Or plain text logs with level prefix

#### Plan

**Phase 1: Create core/log_streamer.py**
- [ ] Create file with proper imports
- [ ] Add `LogFilter` class with filtering logic
- [ ] Add `LogStreamer` class
- [ ] Implement `tail()` method (read last N lines efficiently)
- [ ] Implement `follow()` async method (watch for new lines)
- [ ] Implement `format_line()` method (color coding)
- [ ] Add `stream_logs()` async function
- [ ] Add `__all__` exports
- [ ] Add comprehensive docstrings

**Phase 2: Implement commands/logs.py**
- [ ] Import from `core.log_streamer`
- [ ] Get log file path from config
- [ ] Implement `main()` function with CLI arguments
- [ ] Add Typer command definition
- [ ] Handle keyboard interrupts gracefully
- [ ] Handle missing log files

**Phase 3: Testing**
- [ ] Run `cc-bridge logs`
- [ ] Run `cc-bridge logs --follow`
- [ ] Run `cc-bridge logs --lines 50`
- [ ] Run `cc-bridge logs --level ERROR`
- [ ] Run `cc-bridge logs --pattern "webhook"`
- [ ] Test with non-existent log file
- [ ] Test keyboard interrupt (Ctrl+C)
- [ ] Unit tests for filter logic

### References

- Current incomplete file: `/Users/robin/xprojects/cc-bridge/cc_bridge/commands/logs.py`
- Logging module: `/Users/robin/xprojects/cc-bridge/cc_bridge/packages/logging.py`
- Config: `/Users/robin/xprojects/cc-bridge/cc_bridge/config.py`
- Original task: `/Users/robin/xprojects/cc-bridge/docs/prompts/0012_Extended_commands:_logs_command.md`
- Analysis plan: `/Users/robin/xprojects/cc-bridge/docs/prompts/0090_commands_folder_analysis_plan.md`
- tail(1) man page for reference implementation
