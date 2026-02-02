"""
Session state tracking for Docker daemon mode.

This module provides session management for persistent Claude Code instances,
including conversation history tracking, activity monitoring, and request correlation.
"""

import asyncio
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass, field
from typing import Any

from cc_bridge.packages.logging import get_logger

logger = get_logger(__name__)


@dataclass
class ConversationTurn:
    """Represents a single turn in the conversation."""

    request_id: str
    timestamp: float
    request: str
    response_start: float | None = None
    response_end: float | None = None
    response: str | None = None
    status: str = "pending"  # pending, active, completed, failed
    error: str | None = None

    @property
    def duration(self) -> float | None:
        """Get turn duration in seconds."""
        if self.response_end and self.response_start:
            return self.response_end - self.response_start
        if self.response_end and self.timestamp:
            return self.response_end - self.timestamp
        return None

    @property
    def is_complete(self) -> bool:
        """Check if turn is complete."""
        return self.status in ("completed", "failed")

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "request_id": self.request_id,
            "timestamp": self.timestamp,
            "request": self.request,
            "response_start": self.response_start,
            "response_end": self.response_end,
            "response": self.response,
            "status": self.status,
            "error": self.error,
            "duration": self.duration,
        }


@dataclass
class SessionState:
    """Represents the state of a Claude Code session."""

    instance_name: str
    created_at: float
    last_activity: float
    status: str = "initializing"  # initializing, active, idle, inactive, error
    turns: list[ConversationTurn] = field(default_factory=list)
    active_turn: ConversationTurn | None = None
    total_requests: int = 0
    completed_requests: int = 0
    failed_requests: int = 0

    # Configurable thresholds
    idle_timeout: float = 300.0  # 5 minutes
    request_timeout: float = 120.0  # 2 minutes
    max_history: int = 100  # Max turns to keep in memory

    @property
    def idle_time(self) -> float:
        """Get idle time in seconds."""
        return time.time() - self.last_activity

    @property
    def is_idle(self) -> bool:
        """Check if session is idle."""
        return self.idle_time > self.idle_timeout

    @property
    def is_active(self) -> bool:
        """Check if session is active (not idle and has active turn)."""
        return self.status == "active" and not self.is_idle and self.active_turn is not None

    @property
    def success_rate(self) -> float:
        """Get request success rate."""
        if self.total_requests == 0:
            return 1.0
        successful = self.completed_requests - self.failed_requests
        return successful / self.total_requests

    def add_turn(self, turn: ConversationTurn) -> None:
        """Add a turn to the session."""
        self.turns.append(turn)
        if len(self.turns) > self.max_history:
            self.turns.pop(0)  # Remove oldest
        self.total_requests += 1
        self.active_turn = turn

    def complete_turn(self, request_id: str, response: str, error: str | None = None) -> None:
        """Complete a turn with response."""
        turn = self._find_turn(request_id)
        if turn:
            turn.response = response
            turn.response_end = time.time()
            turn.status = "failed" if error else "completed"
            turn.error = error
            self.completed_requests += 1
            if error:
                self.failed_requests += 1
            if self.active_turn == turn:
                self.active_turn = None
            self.last_activity = time.time()

    def _find_turn(self, request_id: str) -> ConversationTurn | None:
        """Find a turn by request ID."""
        for turn in self.turns:
            if turn.request_id == request_id:
                return turn
        return None

    def get_recent_history(self, limit: int = 10) -> list[dict[str, Any]]:
        """Get recent conversation history."""
        recent_turns = self.turns[-limit:] if limit else self.turns
        return [turn.to_dict() for turn in recent_turns]

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "instance_name": self.instance_name,
            "created_at": self.created_at,
            "last_activity": self.last_activity,
            "status": self.status,
            "idle_time": self.idle_time,
            "is_idle": self.is_idle,
            "is_active": self.is_active,
            "total_requests": self.total_requests,
            "completed_requests": self.completed_requests,
            "failed_requests": self.failed_requests,
            "success_rate": self.success_rate,
            "active_turn": self.active_turn.to_dict() if self.active_turn else None,
            "turns_in_memory": len(self.turns),
        }


class SessionTracker:
    """
    Tracks session state for Docker daemon mode instances.

    Manages conversation history, activity monitoring, and timeout handling
    for persistent Claude Code processes using FIFO communication.
    """

    def __init__(
        self,
        idle_timeout: float = 300.0,
        request_timeout: float = 120.0,
        max_history: int = 100,
    ):
        """
        Initialize session tracker.

        Args:
            idle_timeout: Seconds before session is considered idle (default: 5 min)
            request_timeout: Seconds before request is considered timed out (default: 2 min)
            max_history: Maximum number of turns to keep in memory (default: 100)
        """
        self.idle_timeout = idle_timeout
        self.request_timeout = request_timeout
        self.max_history = max_history

        # Session storage by instance name
        self._sessions: dict[str, SessionState] = {}
        self._lock = asyncio.Lock()

        # Background monitoring task
        self._monitor_task: asyncio.Task | None = None
        self._running = False

    def _create_session_unlocked(self, instance_name: str) -> SessionState:
        """Create a new session without acquiring lock (must already hold lock)."""
        if instance_name in self._sessions:
            self.logger.warning(f"Session already exists for {instance_name}, returning existing")
            return self._sessions[instance_name]

        session = SessionState(
            instance_name=instance_name,
            created_at=time.time(),
            last_activity=time.time(),
            idle_timeout=self.idle_timeout,
            request_timeout=self.request_timeout,
            max_history=self.max_history,
        )
        session.status = "active"
        self._sessions[instance_name] = session

        self.logger.info(
            f"Created session for {instance_name} "
            f"(idle_timeout={self.idle_timeout}s, request_timeout={self.request_timeout}s)"
        )

        return session

    async def create_session(self, instance_name: str) -> SessionState:
        """Create a new session for an instance."""
        async with self._lock:
            return self._create_session_unlocked(instance_name)

    async def get_session(self, instance_name: str) -> SessionState | None:
        """Get session for an instance."""
        async with self._lock:
            return self._sessions.get(instance_name)

    async def remove_session(self, instance_name: str) -> None:
        """Remove a session."""
        async with self._lock:
            if instance_name in self._sessions:
                del self._sessions[instance_name]
                self.logger.info(f"Removed session for {instance_name}")

    async def start_request(
        self,
        instance_name: str,
        request: str,
    ) -> tuple[str, SessionState]:
        """
        Start a new request in a session.

        Returns:
            Tuple of (request_id, session_state)
        """
        async with self._lock:
            session = self._sessions.get(instance_name)
            if not session:
                # Auto-create session if it doesn't exist
                session = self._create_session_unlocked(instance_name)

            # Create new turn
            request_id = str(uuid.uuid4())
            turn = ConversationTurn(
                request_id=request_id,
                timestamp=time.time(),
                request=request,
                status="active",
            )

            session.add_turn(turn)
            session.active_turn = turn
            session.last_activity = time.time()
            session.status = "active"

            self.logger.debug(
                f"Started request {request_id[:8]} for {instance_name}: " f"{request[:50]}..."
            )

            return request_id, session

    async def complete_request(
        self,
        instance_name: str,
        request_id: str,
        response: str,
        error: str | None = None,
    ) -> None:
        """Complete a request with response."""
        async with self._lock:
            session = self._sessions.get(instance_name)
            if session:
                session.complete_turn(request_id, response, error)

                self.logger.debug(
                    f"Completed request {request_id[:8]} for {instance_name}: "
                    f"{'success' if not error else 'failed'} "
                    f"({len(response)} chars)"
                )

    async def get_status(self, instance_name: str) -> dict[str, Any] | None:
        """Get session status for an instance."""
        async with self._lock:
            session = self._sessions.get(instance_name)
            if session:
                return session.to_dict()
            return None

    async def get_all_statuses(self) -> dict[str, dict[str, Any]]:
        """Get statuses for all sessions."""
        async with self._lock:
            return {name: session.to_dict() for name, session in self._sessions.items()}

    async def get_history(self, instance_name: str, limit: int = 10) -> list[dict[str, Any]]:
        """Get conversation history for an instance."""
        async with self._lock:
            session = self._sessions.get(instance_name)
            if session:
                return session.get_recent_history(limit)
            return []

    async def start_monitoring(
        self,
        check_interval: float = 30.0,
        timeout_callback: Callable[[str, SessionState], Awaitable[None]] | None = None,
    ) -> None:
        """
        Start background monitoring of sessions.

        Args:
            check_interval: Seconds between status checks
            timeout_callback: Optional callback for timed out sessions
        """
        if self._running:
            self.logger.warning("Session monitoring already running")
            return

        self._running = True
        self._monitor_task = asyncio.create_task(
            self._monitor_loop(check_interval, timeout_callback)
        )

        self.logger.info("Started session monitoring")

    async def stop_monitoring(self) -> None:
        """Stop background monitoring."""
        self._running = False
        if self._monitor_task:
            self._monitor_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._monitor_task
            self._monitor_task = None

        self.logger.info("Stopped session monitoring")

    async def _monitor_loop(
        self,
        check_interval: float,
        timeout_callback: Callable[[str, SessionState], Awaitable[None]] | None,
    ) -> None:
        """Background monitoring loop."""
        try:
            while self._running:
                await asyncio.sleep(check_interval)
                await self._check_timeouts(timeout_callback)
        except asyncio.CancelledError:
            pass

    async def _check_timeouts(
        self,
        timeout_callback: Callable[[str, SessionState], Awaitable[None]] | None,
    ) -> None:
        """Check for timed out requests and idle sessions."""
        async with self._lock:
            now = time.time()

            for instance_name, session in self._sessions.items():
                # Check for timed out requests
                if session.active_turn:
                    elapsed = now - session.active_turn.timestamp
                    if elapsed > self.request_timeout:
                        self.logger.warning(
                            f"Request {session.active_turn.request_id[:8]} for "
                            f"{instance_name} timed out after {elapsed:.1f}s"
                        )
                        session.complete_turn(
                            session.active_turn.request_id,
                            "",
                            error="Request timeout",
                        )

                # Check for idle sessions
                if session.is_idle:
                    session.status = "idle"
                    self.logger.info(f"Session {instance_name} is idle ({session.idle_time:.1f}s)")
                elif session.status == "idle" and not session.is_idle:
                    session.status = "active"
                    self.logger.info(f"Session {instance_name} is active again")

                # Call timeout callback if provided
                if timeout_callback and session.is_idle:
                    await timeout_callback(instance_name, session)

    async def cleanup_inactive_sessions(self, max_inactive_time: float = 3600.0) -> list[str]:
        """
        Clean up sessions that have been inactive for too long.

        Args:
            max_inactive_time: Seconds of inactivity before cleanup (default: 1 hour)

        Returns:
            List of removed instance names
        """
        removed = []
        now = time.time()

        async with self._lock:
            to_remove = []
            for instance_name, session in self._sessions.items():
                inactive_time = now - session.last_activity
                if inactive_time > max_inactive_time:
                    to_remove.append(instance_name)

            for instance_name in to_remove:
                del self._sessions[instance_name]
                removed.append(instance_name)
                self.logger.info(
                    f"Cleaned up inactive session for {instance_name} "
                    f"(inactive for {inactive_time:.1f}s)"
                )

        return removed

    @property
    def logger(self) -> logging.Logger:
        """Get logger instance."""
        return logger

    def __del__(self):
        """Cleanup on deletion."""
        if self._monitor_task and not self._monitor_task.done():
            self._monitor_task.cancel()


# Global session tracker instance
_session_tracker: SessionTracker | None = None


def get_session_tracker() -> SessionTracker:
    """Get or create the global session tracker."""
    global _session_tracker  # noqa: PLW0603  # Singleton pattern
    if _session_tracker is None:
        _session_tracker = SessionTracker()
    return _session_tracker


__all__ = [
    "ConversationTurn",
    "SessionState",
    "SessionTracker",
    "get_session_tracker",
]
