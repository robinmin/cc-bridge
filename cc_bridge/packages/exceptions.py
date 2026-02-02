"""
Custom exceptions for cc-bridge.

This module provides custom exception classes for better error handling
and user-facing error messages.
"""

import uuid


class CCBridgeError(Exception):
    """Base exception for cc-bridge errors."""

    pass


class TelegramError(CCBridgeError):
    """Base exception for Telegram API errors."""

    pass


class TelegramTimeoutError(TelegramError):
    """Raised when Telegram API request times out."""

    pass


class TelegramAPIError(TelegramError):
    """Raised when Telegram API returns an error response."""

    pass


class UserFacingError(CCBridgeError):
    """
    Exception with user-safe message for external communication.

    This exception separates internal error details from user-facing messages
    to prevent information leakage.
    """

    def __init__(self, user_message: str, internal_message: str = "", error_id: str | None = None):
        """
        Initialize user-facing error.

        Args:
            user_message: Safe message for users (no internal details)
            internal_message: Internal message for logging (full details)
            error_id: Reference ID for support tracking
        """
        self.user_message = user_message
        self.internal_message = internal_message or user_message
        self.error_id = error_id or self._generate_error_id()
        super().__init__(internal_message)

    def _generate_error_id(self) -> str:
        """Generate a unique error reference ID."""
        return str(uuid.uuid4())[:8]

    def __str__(self) -> str:
        """Return user-facing message."""
        return self.user_message


class InstanceNotFoundError(CCBridgeError):
    """Raised when a Claude instance is not found."""

    pass


class InstanceRunningError(CCBridgeError):
    """Raised when trying to start an already running instance."""

    pass


class ValidationError(CCBridgeError):
    """Raised when input validation fails."""

    pass
