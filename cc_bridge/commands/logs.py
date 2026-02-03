"""
Logs command implementation.

This module implements log streaming with filtering capabilities.
"""

import asyncio
import sys

import typer

from cc_bridge.core.log_streamer import LogFilter, get_default_log_path, stream_logs
from cc_bridge.packages.logging import get_logger

logger = get_logger(__name__)

app = typer.Typer(help="Stream cc-bridge logs")


@app.command()
def main(
    follow: bool = typer.Option(
        True,
        "--follow/--no-follow",
        "-f",
        help="Follow log file for new entries (like tail -f)",
    ),
    lines: int = typer.Option(
        10, "--lines", "-n", help="Number of lines to show before following"
    ),
    level: str = typer.Option(
        None,
        "--level",
        "-l",
        help="Filter by log level (DEBUG, INFO, WARNING, ERROR, CRITICAL)",
    ),
    pattern: str = typer.Option(
        None, "--pattern", "-p", help="Filter by regex pattern"
    ),
    log_file: str = typer.Option(
        None, "--file", help="Path to log file (default: from config)"
    ),
):
    """
    Stream cc-bridge logs with optional filtering.

    Examples:
        cc-bridge logs                    # Follow logs with default settings
        cc-bridge logs --no-follow        # Show last 10 lines and exit
        cc-bridge logs -n 50              # Show last 50 lines
        cc-bridge logs --level ERROR      # Show only ERROR level logs
        cc-bridge logs -p "webhook"       # Show logs matching 'webhook'
    """
    try:
        # Get log file path
        log_path = log_file or get_default_log_path()

        # Create filter if requested
        log_filter = None
        if level or pattern:
            log_filter = LogFilter(level=level, pattern=pattern)

        # Run the async stream_logs function
        asyncio.run(
            stream_logs(
                log_file=log_path,
                follow=follow,
                lines=lines,
                log_filter=log_filter,
            )
        )

        return 0

    except KeyboardInterrupt:
        # Handle Ctrl+C gracefully
        print("\nStopped.")
        return 0
    except Exception as e:
        logger.error("Error streaming logs", error=str(e))
        print(f"Error: {e}", file=sys.stderr)
        return 1
