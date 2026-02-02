"""
Tests for Docker error handling and exception types.
"""

import time

import pytest

from cc_bridge.core.docker_errors import (
    DockerContainerNotFoundError,
    DockerContainerNotRunningError,
    DockerDaemonUnavailableError,
    DockerError,
    DockerErrorHandler,
    DockerNetworkError,
    DockerPermissionError,
    DockerTimeoutError,
    get_docker_error_handler,
)


class TestDockerError:
    """Tests for DockerError base exception."""

    def test_create_with_message_only(self):
        """Test creating DockerError with just a message."""
        error = DockerError("Test error")
        assert str(error) == "Test error"
        assert error.container_name is None
        assert error.original_error is None

    def test_create_with_container_name(self):
        """Test creating DockerError with container name."""
        error = DockerError("Test error", container_name="test-container")
        assert error.container_name == "test-container"

    def test_create_with_original_error(self):
        """Test creating DockerError with original exception."""
        original = ValueError("Original error")
        error = DockerError("Test error", original_error=original)
        assert error.original_error is original

    def test_create_with_all_fields(self):
        """Test creating DockerError with all fields."""
        original = RuntimeError("Original")
        error = DockerError("Test error", container_name="test-container", original_error=original)
        assert str(error) == "Test error"
        assert error.container_name == "test-container"
        assert error.original_error is original


class TestDockerErrorSubclasses:
    """Tests for DockerError subclass exceptions."""

    def test_container_not_found_error(self):
        """Test DockerContainerNotFoundError."""
        error = DockerContainerNotFoundError("Container not found", "my-container")
        assert isinstance(error, DockerError)
        assert error.container_name == "my-container"

    def test_container_not_running_error(self):
        """Test DockerContainerNotRunningError."""
        error = DockerContainerNotRunningError("Container stopped", "my-container")
        assert isinstance(error, DockerError)
        assert error.container_name == "my-container"

    def test_daemon_unavailable_error(self):
        """Test DockerDaemonUnavailableError."""
        error = DockerDaemonUnavailableError("Daemon not running")
        assert isinstance(error, DockerError)

    def test_permission_error(self):
        """Test DockerPermissionError."""
        error = DockerPermissionError("Access denied", "my-container")
        assert isinstance(error, DockerError)

    def test_network_error(self):
        """Test DockerNetworkError."""
        error = DockerNetworkError("Network unreachable", "my-container")
        assert isinstance(error, DockerError)

    def test_timeout_error(self):
        """Test DockerTimeoutError."""
        error = DockerTimeoutError("Operation timed out", "my-container")
        assert isinstance(error, DockerError)


class TestDockerErrorHandler:
    """Tests for DockerErrorHandler class."""

    def test_initialization(self):
        """Test DockerErrorHandler initialization."""
        handler = DockerErrorHandler()
        assert handler.max_retries == 3
        assert handler.retry_delay == 1.0
        assert handler.retry_backoff == 2.0

    def test_custom_initialization(self):
        """Test DockerErrorHandler with custom parameters."""
        handler = DockerErrorHandler(max_retries=5, retry_delay=2.0, retry_backoff=3.0)
        assert handler.max_retries == 5
        assert handler.retry_delay == 2.0
        assert handler.retry_backoff == 3.0

    def test_handle_timeout_exception(self):
        """Test handling TimeoutError."""
        handler = DockerErrorHandler()
        timeout_exc = TimeoutError("Operation timed out")

        result = handler.handle_exception(timeout_exc, "test-container")

        assert isinstance(result, DockerTimeoutError)

    def test_handle_unknown_exception(self):
        """Test handling unknown exception falls back to DockerError."""
        handler = DockerErrorHandler()
        unknown_exc = ValueError("Unknown error")

        result = handler.handle_exception(unknown_exc, "test-container")

        assert isinstance(result, DockerError)
        assert "Unexpected Docker error" in str(result)

    def test_get_error_count_no_errors(self):
        """Test get_error_count when no errors occurred."""
        handler = DockerErrorHandler()
        count = handler.get_error_count("test-container")
        assert count == 0

    def test_get_error_count_with_errors(self):
        """Test get_error_count after errors."""
        handler = DockerErrorHandler()
        handler._error_counts["test-container"] = 5
        count = handler.get_error_count("test-container")
        assert count == 5

    def test_get_error_rate_no_errors(self):
        """Test get_error_rate when no errors occurred."""
        handler = DockerErrorHandler()
        rate = handler.get_error_rate("test-container")
        assert rate == 0.0

    def test_get_error_rate_with_errors(self):
        """Test get_error_rate calculation."""
        handler = DockerErrorHandler()
        import time

        handler._error_counts["test-container"] = 3
        handler._last_error_time["test-container"] = time.time()
        rate = handler.get_error_rate("test-container")
        assert rate > 0

    def test_get_error_rate_old_errors(self):
        """Test get_error_rate with errors outside time window."""
        handler = DockerErrorHandler()
        handler._error_counts["test-container"] = 5
        handler._last_error_time["test-container"] = time.time() - 100  # 100 seconds ago
        rate = handler.get_error_rate("test-container", window_seconds=60)
        assert rate == 0.0

    def test_is_degraded_below_threshold(self):
        """Test is_degraded when error rate below threshold."""
        handler = DockerErrorHandler()
        handler._error_counts["test-container"] = 1
        handler._last_error_time["test-container"] = time.time()
        assert not handler.is_degraded("test-container", threshold=10.0)

    def test_is_degraded_above_threshold(self):
        """Test is_degraded when error rate above threshold."""
        handler = DockerErrorHandler()
        handler._error_counts["test-container"] = 10
        handler._last_error_time["test-container"] = time.time()
        assert handler.is_degraded("test-container", threshold=1.0)

    @pytest.mark.asyncio
    async def test_retry_on_failure_success_on_first_try(self):
        """Test retry_on_failure when operation succeeds immediately."""
        handler = DockerErrorHandler()

        async def mock_operation():
            return "success"

        result = await handler.retry_on_failure(mock_operation, "test operation")

        assert result == "success"

    @pytest.mark.asyncio
    async def test_retry_on_failure_retries_transient_errors(self):
        """Test retry_on_failure retries on retryable errors."""
        handler = DockerErrorHandler(max_retries=3, retry_delay=0.01)

        attempt_count = 0

        async def mock_operation():
            nonlocal attempt_count
            attempt_count += 1
            if attempt_count < 2:
                # Raise standard TimeoutError - handle_exception will convert it
                raise TimeoutError("Timeout")
            return "success"

        result = await handler.retry_on_failure(mock_operation, "test operation", "test-container")

        assert result == "success"
        assert attempt_count == 2

    @pytest.mark.asyncio
    async def test_retry_on_failure_fails_after_max_retries(self):
        """Test retry_on_failure raises error after max retries."""
        handler = DockerErrorHandler(max_retries=2, retry_delay=0.01)

        async def mock_operation():
            # Raise standard TimeoutError - handle_exception will convert it
            raise TimeoutError("Timeout")

        with pytest.raises(DockerTimeoutError):
            await handler.retry_on_failure(mock_operation, "test operation", "test-container")

    @pytest.mark.asyncio
    async def test_retry_on_failure_no_retry_non_retryable(self):
        """Test retry_on_failure doesn't retry non-retryable errors."""
        handler = DockerErrorHandler(max_retries=3, retry_delay=0.01)

        attempt_count = 0

        async def mock_operation():
            nonlocal attempt_count
            attempt_count += 1
            # Raise PermissionError - not retryable by default
            raise PermissionError("Access denied")

        # PermissionError will be converted to DockerError (not retryable)
        with pytest.raises(DockerError):
            await handler.retry_on_failure(mock_operation, "test operation", "test-container")

        # Should fail immediately without retries
        assert attempt_count == 1

    @pytest.mark.asyncio
    async def test_retry_on_failure_resets_error_count_on_success(self):
        """Test that successful operation resets error counter."""
        handler = DockerErrorHandler()
        handler._error_counts["test-container"] = 5

        async def mock_operation():
            return "success"

        await handler.retry_on_failure(mock_operation, "test operation", "test-container")

        # Error count should be reset
        assert handler.get_error_count("test-container") == 0

    @pytest.mark.asyncio
    async def test_retry_on_failure_increments_error_count(self):
        """Test that failed operation increments error counter."""
        handler = DockerErrorHandler(max_retries=1, retry_delay=0.01)

        async def mock_operation():
            # Raise standard TimeoutError - handle_exception will convert it
            raise TimeoutError("Timeout")

        with pytest.raises(DockerTimeoutError):
            await handler.retry_on_failure(mock_operation, "test operation", "test-container")

        # Error count should be incremented
        # With max_retries=1, there are 2 attempts (initial + 1 retry), both fail
        assert handler.get_error_count("test-container") == 2

    @pytest.mark.asyncio
    async def test_retry_on_failure_custom_retryable_errors(self):
        """Test retry_on_failure with custom retryable errors."""
        handler = DockerErrorHandler(max_retries=2, retry_delay=0.01)

        attempt_count = 0

        async def mock_operation():
            nonlocal attempt_count
            attempt_count += 1
            # Raise PermissionError - not in custom retryable list
            raise PermissionError("Access denied")

        # Only retry TimeoutError (converted to DockerTimeoutError), not generic DockerError
        # PermissionError will be converted to generic DockerError
        custom_retryable = (DockerTimeoutError,)

        with pytest.raises(DockerError):
            await handler.retry_on_failure(
                mock_operation,
                "test operation",
                "test-container",
                retryable_errors=custom_retryable,
            )

        # Should fail immediately without retries
        assert attempt_count == 1


class TestGlobalErrorHandler:
    """Tests for global error handler singleton."""

    def test_get_docker_error_handler_singleton(self):
        """Test that get_docker_error_handler returns singleton."""
        handler1 = get_docker_error_handler()
        handler2 = get_docker_error_handler()
        assert handler1 is handler2

    def test_get_docker_error_handler_creates_instance(self):
        """Test that get_docker_error_handler creates instance on first call."""
        # Reset global variable for testing
        import cc_bridge.core.docker_errors

        cc_bridge.core.docker_errors._error_handler = None

        handler = get_docker_error_handler()
        assert isinstance(handler, DockerErrorHandler)

    def test_get_docker_error_handler_returns_existing(self):
        """Test that get_docker_error_handler returns existing instance."""
        # Reset and set a custom instance
        import cc_bridge.core.docker_errors

        cc_bridge.core.docker_errors._error_handler = None
        handler1 = get_docker_error_handler()
        handler1.max_retries = 10

        handler2 = get_docker_error_handler()
        assert handler2.max_retries == 10
