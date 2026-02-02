"""
Docker error handling and exception types.

This module provides custom exceptions and error handling utilities
for Docker operations with retry logic and graceful degradation.
"""

import asyncio
from collections.abc import Callable
from typing import Any

from cc_bridge.packages.logging import get_logger

logger = get_logger(__name__)


class DockerError(Exception):
    """Base exception for Docker-related errors."""

    def __init__(
        self,
        message: str,
        container_name: str | None = None,
        original_error: Exception | None = None,
    ):
        """
        Initialize Docker error.

        Args:
            message: Error message
            container_name: Associated container name
            original_error: Original exception if applicable
        """
        self.container_name = container_name
        self.original_error = original_error
        super().__init__(message)


class DockerContainerNotFoundError(DockerError):
    """Raised when a Docker container is not found."""

    pass


class DockerContainerNotRunningError(DockerError):
    """Raised when a Docker container exists but is not running."""

    pass


class DockerDaemonUnavailableError(DockerError):
    """Raised when Docker daemon is not available or not responding."""

    pass


class DockerPermissionError(DockerError):
    """Raised when there are permission issues with Docker operations."""

    pass


class DockerNetworkError(DockerError):
    """Raised when there are Docker network-related issues."""

    pass


class DockerTimeoutError(DockerError):
    """Raised when a Docker operation times out."""

    pass


class DockerErrorHandler:
    """
    Error handler for Docker operations.

    Provides retry logic, graceful degradation, and user-friendly
    error messages for Docker failures.
    """

    def __init__(
        self,
        max_retries: int = 3,
        retry_delay: float = 1.0,
        retry_backoff: float = 2.0,
    ):
        """
        Initialize Docker error handler.

        Args:
            max_retries: Maximum number of retry attempts
            retry_delay: Initial retry delay in seconds
            retry_backoff: Multiplier for retry delay after each attempt
        """
        self.max_retries = max_retries
        self.retry_delay = retry_delay
        self.retry_backoff = retry_backoff
        self._error_counts: dict[str, int] = {}
        self._last_error_time: dict[str, float] = {}

    def handle_exception(self, exc: Exception, container_name: str | None = None) -> DockerError:  # noqa: PLR0911
        """
        Convert a raw exception to an appropriate DockerError.

        Args:
            exc: Original exception
            container_name: Associated container name

        Returns:
            Appropriate DockerError subclass
        """
        try:
            import docker.errors

            if isinstance(exc, docker.errors.NotFound):
                return DockerContainerNotFoundError(
                    f"Container '{container_name}' not found. "
                    f"Use 'cc-bridge docker list' to see available containers.",
                    container_name=container_name,
                    original_error=exc,
                )
            elif isinstance(exc, docker.errors.APIError):
                # Get response object, checking if it exists
                response = exc.response if hasattr(exc, "response") else None
                status_code = response.status_code if response is not None else None

                if status_code == 403:
                    return DockerPermissionError(
                        "Permission denied. Ensure your user has Docker permissions.",
                        container_name=container_name,
                        original_error=exc,
                    )
                elif status_code == 409:
                    return DockerError(
                        f"Container '{container_name}' already exists or is in use.",
                        container_name=container_name,
                        original_error=exc,
                    )
                else:
                    return DockerError(
                        f"Docker API error: {exc}",
                        container_name=container_name,
                        original_error=exc,
                    )
            elif isinstance(exc, docker.errors.DockerException):
                if "connect" in str(exc).lower() or "daemon" in str(exc).lower():
                    return DockerDaemonUnavailableError(
                        "Docker daemon is not running or not accessible. "
                        "Start Docker and try again.",
                        container_name=container_name,
                        original_error=exc,
                    )
                else:
                    return DockerError(
                        f"Docker error: {exc}",
                        container_name=container_name,
                        original_error=exc,
                    )
            elif isinstance(exc, TimeoutError):
                return DockerTimeoutError(
                    f"Docker operation timed out for container '{container_name}'.",
                    container_name=container_name,
                    original_error=exc,
                )

        except Exception:
            pass

        # Fallback for unknown exceptions
        return DockerError(
            f"Unexpected Docker error: {exc}",
            container_name=container_name,
            original_error=exc,
        )

    async def retry_on_failure(
        self,
        operation: Callable,
        operation_name: str,
        container_name: str | None = None,
        retryable_errors: tuple[type[DockerError], ...] = (
            DockerDaemonUnavailableError,
            DockerTimeoutError,
            DockerNetworkError,
        ),
    ) -> Any:
        """
        Execute an operation with retry logic for transient failures.

        Args:
            operation: Async callable to execute
            operation_name: Description of the operation for logging
            container_name: Associated container name
            retryable_errors: Tuple of error types that should trigger retry

        Returns:
            Result of the operation

        Raises:
            DockerError: If all retries fail
        """
        delay = self.retry_delay
        last_error = None

        for attempt in range(self.max_retries + 1):
            try:
                result = await operation()
                # Success - reset error counter
                if container_name:
                    self._error_counts.pop(container_name, None)

                return result

            except Exception as e:
                # Convert to DockerError
                docker_error = self.handle_exception(e, container_name)
                last_error = docker_error

                # Track error
                if container_name:
                    self._error_counts[container_name] = (
                        self._error_counts.get(container_name, 0) + 1
                    )
                    import time

                    self._last_error_time[container_name] = time.time()

                # Check if error is retryable
                is_retryable = isinstance(docker_error, retryable_errors)

                if not is_retryable or attempt >= self.max_retries:
                    # Non-retryable or final attempt - raise
                    logger.error(
                        f"{operation_name} failed after {attempt + 1} attempt(s)",
                        error=str(docker_error),
                        container=container_name,
                    )
                    raise docker_error from None

                # Retry with backoff
                logger.warning(
                    f"{operation_name} failed (attempt {attempt + 1}/{self.max_retries + 1}), "
                    f"retrying in {delay:.1f}s...",
                    error=str(docker_error),
                    container=container_name,
                )
                await asyncio.sleep(delay)
                delay *= self.retry_backoff

        # Should never reach here, but just in case
        if last_error:
            raise last_error
        raise DockerError(f"{operation_name} failed after all retries")

    def get_error_count(self, container_name: str) -> int:
        """
        Get the number of errors encountered for a container.

        Args:
            container_name: Container name

        Returns:
            Error count
        """
        return self._error_counts.get(container_name, 0)

    def get_error_rate(self, container_name: str, window_seconds: int = 60) -> float:
        """
        Calculate the error rate for a container.

        Args:
            container_name: Container name
            window_seconds: Time window in seconds

        Returns:
            Errors per second in the time window
        """
        import time

        if container_name not in self._error_counts:
            return 0.0

        if container_name not in self._last_error_time:
            return 0.0

        elapsed = time.time() - self._last_error_time[container_name]
        if elapsed > window_seconds:
            return 0.0

        return self._error_counts[container_name] / max(elapsed, 1.0)

    def is_degraded(self, container_name: str, threshold: float = 0.1) -> bool:
        """
        Check if a container is in degraded state.

        Args:
            container_name: Container name
            threshold: Error rate threshold (errors per second)

        Returns:
            True if error rate exceeds threshold
        """
        return self.get_error_rate(container_name) > threshold


# Global error handler instance
_error_handler: DockerErrorHandler | None = None


def get_docker_error_handler() -> DockerErrorHandler:
    """
    Get global Docker error handler singleton.

    Returns:
        DockerErrorHandler instance
    """
    global _error_handler  # noqa: PLW0603
    if _error_handler is None:
        _error_handler = DockerErrorHandler()
    return _error_handler


__all__ = [
    "DockerContainerNotFoundError",
    "DockerContainerNotRunningError",
    "DockerDaemonUnavailableError",
    "DockerError",
    "DockerErrorHandler",
    "DockerNetworkError",
    "DockerPermissionError",
    "DockerTimeoutError",
    "get_docker_error_handler",
]
