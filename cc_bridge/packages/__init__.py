"""
Reusable utility packages for cc-bridge.

This module provides common utilities and shared functionality
used across the cc-bridge application.
"""

from cc_bridge.packages.exceptions import (
    CCBridgeError,
    InstanceNotFoundError,
    InstanceRunningError,
    TelegramAPIError,
    TelegramError,
    TelegramTimeoutError,
    UserFacingError,
    ValidationError,
)
from cc_bridge.packages.logging import get_logger, reset_logging, setup_logging

__all__ = [
    # Exceptions
    "CCBridgeError",
    "TelegramError",
    "TelegramTimeoutError",
    "TelegramAPIError",
    "UserFacingError",
    "InstanceNotFoundError",
    "InstanceRunningError",
    "ValidationError",
    # Logging
    "setup_logging",
    "get_logger",
    "reset_logging",
]
