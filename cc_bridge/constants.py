"""
Constants for cc-bridge configuration.

This module defines named constants for configuration values that were
previously hardcoded as "magic numbers" throughout the codebase.
"""

# Rate Limiting
DEFAULT_RATE_LIMIT_REQUESTS = 10
DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60

# Buffer Sizes
DEFAULT_READ_BUFFER_SIZE = 4096

# Telegram
TELEGRAM_MAX_MESSAGE_LENGTH = 4096
TELEGRAM_TRUNCATED_MESSAGE_SUFFIX = "\\n\\n... (truncated)"

# Timeouts (in seconds)
DEFAULT_TIMEOUT = 60.0
NAMED_PIPE_OPEN_TIMEOUT = 30.0
TELEGRAM_API_TIMEOUT = 30.0

# Docker
CONTAINER_STOP_TIMEOUT = 10

# Server Shutdown
SERVER_SHUTDOWN_TIMEOUT = 30  # Maximum seconds to wait for graceful shutdown

# File Sizes
MAX_REQUEST_SIZE = 10_000  # 10KB max webhook request size
MAX_MESSAGE_LENGTH = 4000  # Max message length before truncation

# Exit Codes (for CLI commands)
EXIT_SUCCESS = 0
EXIT_ERROR = 1
EXIT_USAGE_ERROR = 2

__all__ = [
    "CONTAINER_STOP_TIMEOUT",
    "DEFAULT_RATE_LIMIT_REQUESTS",
    "DEFAULT_RATE_LIMIT_WINDOW_SECONDS",
    "DEFAULT_READ_BUFFER_SIZE",
    "DEFAULT_TIMEOUT",
    "EXIT_ERROR",
    "EXIT_SUCCESS",
    "EXIT_USAGE_ERROR",
    "MAX_MESSAGE_LENGTH",
    "MAX_REQUEST_SIZE",
    "NAMED_PIPE_OPEN_TIMEOUT",
    "SERVER_SHUTDOWN_TIMEOUT",
    "TELEGRAM_API_TIMEOUT",
    "TELEGRAM_MAX_MESSAGE_LENGTH",
    "TELEGRAM_TRUNCATED_MESSAGE_SUFFIX",
]
