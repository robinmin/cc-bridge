"""
Middleware and rate limiting for the webhook server.
"""

import asyncio
import time
from collections import defaultdict
from cc_bridge.constants import (
    DEFAULT_RATE_LIMIT_REQUESTS,
    DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
    SERVER_SHUTDOWN_TIMEOUT,
)
from cc_bridge.packages.logging import get_logger

logger = get_logger(__name__)

__all__ = [
    "GracefulShutdown",
    "RateLimiter",
    "get_shutdown_handler",
    "get_rate_limiter",
    "get_server_uptime",
]


class GracefulShutdown:
    """
    Manages graceful shutdown of the FastAPI server.

    Tracks pending requests and waits for them to complete during shutdown.
    """

    def __init__(self, timeout: float = SERVER_SHUTDOWN_TIMEOUT) -> None:
        """
        Initialize graceful shutdown handler.

        Args:
            timeout: Maximum seconds to wait for pending requests
        """
        self._shutdown_event = asyncio.Event()
        self._pending_requests = 0
        self._lock = asyncio.Lock()
        self._timeout = timeout

    async def increment_requests(self) -> None:
        """Increment pending request count."""
        async with self._lock:
            self._pending_requests += 1

    async def decrement_requests(self) -> None:
        """Decrement pending request count."""
        async with self._lock:
            self._pending_requests -= 1

    async def wait_for_shutdown(self) -> None:
        """
        Wait for pending requests to complete during shutdown.

        Logs progress and enforces timeout.
        """
        try:
            # Wait for pending requests with timeout
            start_time = time.time()
            while self._pending_requests > 0:
                elapsed = time.time() - start_time
                if elapsed >= self._timeout:
                    logger.warning(
                        "Shutdown timeout reached",
                        pending=self._pending_requests,
                        timeout=self._timeout,
                    )
                    break

                # Log progress every 5 seconds
                if int(elapsed) % 5 == 0 and self._pending_requests > 0:
                    logger.info(
                        "Waiting for pending requests",
                        pending=self._pending_requests,
                        elapsed=f"{elapsed:.1f}s",
                    )

                await asyncio.sleep(0.1)

            logger.info("Shutdown complete", pending=self._pending_requests)

        except Exception as e:
            logger.error("Error during shutdown", error=str(e), exc_info=True)

    def is_shutting_down(self) -> bool:
        """Check if shutdown has been initiated."""
        return self._shutdown_event.is_set()

    @property
    def pending_requests(self) -> int:
        """Get current pending request count."""
        return self._pending_requests


# Global graceful shutdown handler
_shutdown_handler: GracefulShutdown | None = None

# Server start time for uptime tracking
_server_start_time: float | None = None


def get_shutdown_handler() -> GracefulShutdown:
    """Get or create the global shutdown handler."""
    global _shutdown_handler  # noqa: PLW0603
    if _shutdown_handler is None:
        _shutdown_handler = GracefulShutdown()
    return _shutdown_handler


def get_server_uptime() -> float:
    """Get server uptime in seconds."""
    global _server_start_time
    if _server_start_time is None:
        # This might be called before start, but we set it in lifespan
        return 0.0
    return time.time() - _server_start_time


def set_server_start_time(start_time: float) -> None:
    """Set the server start time."""
    global _server_start_time
    _server_start_time = start_time


class RateLimiter:
    """
    Simple in-memory rate limiter for webhook endpoint.
    Limits requests per time window per identifier.
    """

    def __init__(self, requests: int, window: int) -> None:
        """
        Initialize rate limiter.

        Args:
            requests: Number of requests allowed
            window: Time window in seconds
        """
        self.requests = requests
        self.window = window
        self._timestamps: dict[int, list[float]] = defaultdict(list)
        self._lock = asyncio.Lock()

    async def is_allowed(self, identifier: int) -> bool:
        """
        Check if request is allowed for this identifier.

        Args:
            identifier: Unique identifier for the requester (e.g., chat_id)

        Returns:
            True if request is allowed, False if rate limited
        """
        async with self._lock:
            now = time.time()

            # Clean old timestamps outside the window
            self._timestamps[identifier] = [
                ts for ts in self._timestamps[identifier] if now - ts < self.window
            ]

            # Check if under the limit
            if len(self._timestamps[identifier]) < self.requests:
                self._timestamps[identifier].append(now)
                return True

            return False

    async def get_retry_after(self, identifier: int) -> int:
        """
        Get seconds until next request is allowed for a specific identifier.

        Args:
            identifier: Unique identifier for the requester (e.g., chat_id)

        Returns:
            Seconds to wait, or 0 if allowed
        """
        async with self._lock:
            if identifier not in self._timestamps:
                return 0

            # Get the oldest timestamp for this identifier
            timestamps = self._timestamps[identifier]
            if not timestamps:
                return 0

            oldest = min(timestamps)
            retry_after = int(oldest + self.window - time.time())
            return max(0, retry_after)


# Global rate limiter
_rate_limiter: RateLimiter | None = None


def get_rate_limiter() -> RateLimiter:
    """Get or create the global rate limiter."""
    global _rate_limiter  # noqa: PLW0603
    if _rate_limiter is None:
        _rate_limiter = RateLimiter(
            requests=DEFAULT_RATE_LIMIT_REQUESTS,
            window=DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
        )
    return _rate_limiter
