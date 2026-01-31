"""
Structured logging configuration for cc-bridge.

This module provides structured logging with JSON or text formatting,
log rotation, and configurable log levels.
"""

import logging
import logging.handlers
import sys
from pathlib import Path
from typing import Any

import structlog

# Flag to track if logging has been configured
_logging_configured = False


def reset_logging() -> None:
    """
    Reset logging configuration flag.

    This is primarily used in tests to allow reconfiguration between test runs.
    """
    global _logging_configured  # noqa: PLW0603
    _logging_configured = False


def setup_logging(
    level: str = "INFO",
    log_format: str = "json",
    log_file: str | None = None,
    max_bytes: int = 10485760,  # 10MB
    backup_count: int = 5,
) -> None:
    """
    Configure structured logging for cc-bridge.

    This function is idempotent - subsequent calls after the first will be ignored.

    Args:
        level: Log level (DEBUG, INFO, WARNING, ERROR, CRITICAL)
        log_format: Log format ("json" or "text")
        log_file: Path to log file (optional)
        max_bytes: Maximum size of log file before rotation
        backup_count: Number of backup files to keep
    """
    global _logging_configured  # noqa: PLW0603

    # Idempotent check - only configure once
    if _logging_configured:
        return

    # Convert string level to logging constant
    log_level = getattr(logging, level.upper(), logging.INFO)

    # Configure structlog to use standard logging
    # This allows pytest's caplog to capture records
    processors = [
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        # Process the event and write to standard logging
        structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
    ]

    structlog.configure(
        processors=processors,
        wrapper_class=structlog.stdlib.BoundLogger,
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )

    # Create formatter based on format type
    if log_format == "json":
        formatter = structlog.stdlib.ProcessorFormatter(
            processor=structlog.processors.JSONRenderer()
        )
    else:
        formatter = structlog.stdlib.ProcessorFormatter(
            processor=structlog.dev.ConsoleRenderer(
                colors=True,
                exception_formatter=structlog.dev.plain_traceback,
            )
        )

    # Configure standard logging
    root_logger = logging.getLogger()

    # Set the log level
    root_logger.setLevel(log_level)

    # Add console handler if not already present
    if not any(
        isinstance(h, logging.StreamHandler) and h.stream == sys.stdout
        for h in root_logger.handlers
    ):
        console_handler = logging.StreamHandler(sys.stdout)
        console_handler.setLevel(log_level)
        console_handler.setFormatter(formatter)
        root_logger.addHandler(console_handler)

    if log_file:
        log_path = Path(log_file).expanduser()
        log_path.parent.mkdir(parents=True, exist_ok=True)

        file_handler = logging.handlers.RotatingFileHandler(
            log_path,
            maxBytes=max_bytes,
            backupCount=backup_count,
        )
        file_handler.setLevel(log_level)
        file_handler.setFormatter(formatter)
        root_logger.addHandler(file_handler)

    # Configure uvicorn logging
    logging.getLogger("uvicorn").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)

    # Mark logging as configured
    _logging_configured = True


def get_logger(name: str) -> Any:
    """
    Get a structured logger instance.

    Args:
        name: Logger name (typically __name__ of the module)

    Returns:
        Structlog BoundLogger instance
    """
    logger = structlog.get_logger(name)
    # Bind with minimal context to ensure it's a BoundLogger
    return logger.bind()
