"""
Log streaming utilities for cc-bridge.

This module provides log streaming with filtering and color coding capabilities.
"""

import asyncio
import re
from pathlib import Path

from cc_bridge.config import get_config
from cc_bridge.packages.logging import get_logger

logger = get_logger(__name__)

# Constants
DEFAULT_LOG_PATH = "~/.claude/bridge/logs/bridge.log"
LOG_LEVEL_COLORS = {
    "DEBUG": "\033[36m",  # Cyan
    "INFO": "\033[32m",  # Green
    "WARNING": "\033[33m",  # Yellow
    "ERROR": "\033[31m",  # Red
    "CRITICAL": "\033[35m",  # Magenta
}
RESET_COLOR = "\033[0m"

__all__ = [
    "LogFilter",
    "LogStreamer",
    "stream_logs",
    "DEFAULT_LOG_PATH",
]


class LogFilter:
    """
    Filter for log entries based on level, component, or pattern.

    Attributes:
        level: Minimum log level to display (None = all levels)
        component: Filter by component/module name (None = all components)
        pattern: Regex pattern to match in log lines (None = no pattern filtering)

    Examples:
        >>> filter = LogFilter(level="ERROR")
        >>> filter.matches("2024-01-01 ERROR: Something went wrong")
        True

        >>> filter = LogFilter(pattern="webhook")
        >>> filter.matches("Processing webhook update")
        True
    """

    def __init__(
        self,
        level: str | None = None,
        component: str | None = None,
        pattern: str | None = None,
    ):
        """
        Initialize log filter.

        Args:
            level: Minimum log level (DEBUG, INFO, WARNING, ERROR, CRITICAL)
            component: Filter by component/module name
            pattern: Regex pattern to match in log lines
        """
        self.level = level
        self.component = component
        self.pattern = re.compile(pattern) if pattern else None

    def matches(self, line: str) -> bool:
        """
        Check if a log line matches the filter criteria.

        Args:
            line: Log line to check

        Returns:
            True if line matches filter, False otherwise
        """
        # Level filtering
        if self.level:
            # Extract level from log line (assuming format like "ERROR:", "[ERROR]", or "ERROR")
            level_pattern = r"(?P<level>DEBUG|INFO|WARNING|ERROR|CRITICAL)"
            match = re.search(level_pattern, line, re.IGNORECASE)
            if match:
                line_level = match.group("level").upper()
                # Check if line level is at or above filter level
                level_priority = {
                    "DEBUG": 0,
                    "INFO": 1,
                    "WARNING": 2,
                    "ERROR": 3,
                    "CRITICAL": 4,
                }
                if level_priority.get(line_level, 0) < level_priority.get(
                    self.level.upper(), 0
                ):
                    return False

        # Pattern filtering
        return not (self.pattern and not self.pattern.search(line))


class LogStreamer:
    """
    Stream log files with filtering and color coding.

    Supports tail -f style following, filtering by level/pattern,
    and color-coded output for readability.

    Attributes:
        log_file: Path to the log file
        filter: Optional LogFilter for filtering log lines

    Examples:
        >>> streamer = LogStreamer(Path("/var/log/app.log"))
        >>> streamer.tail(lines=10)
        >>> await streamer.follow()  # async follow mode
    """

    def __init__(self, log_file: Path, log_filter: LogFilter | None = None):
        """
        Initialize log streamer.

        Args:
            log_file: Path to the log file
            log_filter: Optional filter for log entries
        """
        self.log_file = log_file.expanduser()
        self.filter = log_filter

    def tail(self, lines: int = 10) -> None:
        """
        Show the last N lines of the log file.

        Args:
            lines: Number of lines to show (default: 10)
        """
        if not self.log_file.exists():
            print(f"Log file not found: {self.log_file}")
            return

        try:
            # Read last N lines efficiently
            with Path.open(self.log_file, encoding="utf-8", errors="replace") as f:
                # Read all lines and filter
                all_lines = f.readlines()
                filtered_lines = [
                    line.rstrip("\n")
                    for line in all_lines
                    if not self.filter or self.filter.matches(line)
                ]

                # Get last N lines
                tail_lines = (
                    filtered_lines[-lines:]
                    if len(filtered_lines) > lines
                    else filtered_lines
                )

                for line in tail_lines:
                    print(self.format_line(line))

        except OSError as e:
            print(f"Error reading log file: {e}")

    async def follow(self) -> None:
        """
        Follow the log file for new entries (like tail -f).

        This async method monitors the log file and prints new lines as they are added.
        """
        if not self.log_file.exists():
            print(f"Log file not found: {self.log_file}")
            return

        try:
            # Open file and seek to end
            with Path.open(self.log_file, encoding="utf-8", errors="replace") as f:
                # Move to end of file
                f.seek(0, 2)
                file_pos = f.tell()

                print(f"Following log file: {self.log_file}")
                print("Press Ctrl+C to stop.\n")

                while True:
                    # Check for new lines
                    f.seek(file_pos)
                    new_data = f.read()
                    file_pos = f.tell()

                    if new_data:
                        for line in new_data.splitlines():
                            if not self.filter or self.filter.matches(line):
                                print(self.format_line(line))

                    # Wait before checking again
                    await asyncio.sleep(0.1)

        except KeyboardInterrupt:
            print("\nStopped following log file.")
        except OSError as e:
            print(f"Error reading log file: {e}")

    def format_line(self, line: str) -> str:
        """
        Add color coding to a log line based on log level.

        Args:
            line: Log line to format

        Returns:
            Formatted line with color codes
        """
        if not line:
            return line

        # Try to extract log level and add color
        for level, color in LOG_LEVEL_COLORS.items():
            # Match level patterns like "ERROR:", "[ERROR]", "ERROR -"
            patterns = [
                rf"\b{level}\s*:",  # "ERROR:"
                rf"\[{level}\]",  # "[ERROR]"
                rf"\b{level}\s*-",  # "ERROR -"
                rf'^"{level}"',  # JSON: "ERROR"
            ]
            for pattern in patterns:
                if re.search(pattern, line, re.IGNORECASE):
                    # Add color to the level indicator
                    colored_line = re.sub(
                        pattern,
                        f"{color}\\g<0>{RESET_COLOR}",
                        line,
                        flags=re.IGNORECASE,
                    )
                    return colored_line

        return line


async def stream_logs(
    log_file: str,
    follow: bool = True,
    lines: int = 10,
    log_filter: LogFilter | None = None,
) -> None:
    """
    Stream log file contents with optional filtering.

    Args:
        log_file: Path to log file
        follow: Follow log file for new entries (like tail -f)
        lines: Number of lines to show before following
        log_filter: Optional filter for log entries

    Examples:
        >>> await stream_logs("~/.claude/bridge/logs/bridge.log", follow=True)
        ... # Follows log file

        >>> await stream_logs("logs/app.log", follow=False, lines=50)
        ... # Shows last 50 lines and exits

        >>> filter = LogFilter(level="ERROR")
        >>> await stream_logs("logs/app.log", log_filter=filter)
        ... # Shows only ERROR level logs
    """
    log_path = Path(log_file).expanduser()

    if not log_path.exists():
        print(f"Log file not found: {log_path}")
        print("Creating log file directory...")
        try:
            log_path.parent.mkdir(parents=True, exist_ok=True)
            print(f"Log file will be created at: {log_path}")
        except OSError as e:
            print(f"Error creating log directory: {e}")
        return

    streamer = LogStreamer(log_path, log_filter)

    # Show last N lines first
    if lines > 0:
        streamer.tail(lines=lines)

    # Then follow if requested
    if follow:
        await streamer.follow()


def get_default_log_path() -> str:
    """
    Get the default log file path from configuration.

    Returns:
        Default log file path
    """
    config = get_config()
    return config.get("logging.file", DEFAULT_LOG_PATH)
