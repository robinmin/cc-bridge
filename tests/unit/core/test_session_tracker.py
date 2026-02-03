"""
Tests for session state tracking.
"""

# ruff: noqa: PLC0415 (intentional lazy imports in tests)

import pytest

from cc_bridge.core.session_tracker import (
    ConversationTurn,
    SessionState,
    SessionTracker,
    get_session_tracker,
)


@pytest.fixture
def session_tracker():
    """Create a fresh session tracker for each test."""
    return SessionTracker(
        idle_timeout=60.0,  # 1 minute for faster tests
        request_timeout=30.0,  # 30 seconds
        max_history=10,
    )


class TestConversationTurn:
    """Tests for ConversationTurn dataclass."""

    def test_create_turn(self):
        """Test creating a conversation turn."""
        turn = ConversationTurn(
            request_id="test-id",
            timestamp=1000.0,
            request="test request",
        )

        assert turn.request_id == "test-id"
        assert turn.request == "test request"
        assert turn.status == "pending"
        assert turn.response is None
        assert turn.duration is None

    def test_complete_turn(self):
        """Test completing a turn."""
        turn = ConversationTurn(
            request_id="test-id",
            timestamp=1000.0,
            request="test request",
        )

        turn.response_start = 1010.0
        turn.response_end = 1020.0
        turn.response = "test response"
        turn.status = "completed"

        assert turn.response_start == 1010.0
        assert turn.response_end == 1020.0
        assert turn.duration == 10.0
        assert turn.is_complete is True

    def test_failed_turn(self):
        """Test a failed turn."""
        turn = ConversationTurn(
            request_id="test-id",
            timestamp=1000.0,
            request="test request",
        )

        turn.status = "failed"
        turn.error = "Connection error"

        assert turn.is_complete is True
        assert turn.error == "Connection error"

    def test_to_dict(self):
        """Test converting turn to dictionary."""
        turn = ConversationTurn(
            request_id="test-id",
            timestamp=1000.0,
            request="test",
            response="answer",
            status="completed",
            response_start=1010.0,
            response_end=1020.0,
        )

        result = turn.to_dict()

        assert result["request_id"] == "test-id"
        assert result["request"] == "test"
        assert result["response"] == "answer"
        assert result["status"] == "completed"
        assert result["duration"] == 10.0


class TestSessionState:
    """Tests for SessionState dataclass."""

    def test_create_session(self):
        """Test creating a session state."""
        session = SessionState(
            instance_name="test-instance",
            created_at=1000.0,
            last_activity=1000.0,
            idle_timeout=60.0,
            request_timeout=30.0,
        )

        assert session.instance_name == "test-instance"
        assert session.status == "initializing"
        assert session.total_requests == 0
        assert session.completed_requests == 0
        assert session.failed_requests == 0
        assert session.success_rate == 1.0

    def test_idle_time_calculation(self):
        """Test idle time calculation."""
        import time

        session = SessionState(
            instance_name="test",
            created_at=time.time() - 100,
            last_activity=time.time() - 50,
        )

        # Should be approximately 50 seconds
        assert 49 < session.idle_time < 51

    def test_is_idle_check(self):
        """Test idle check."""
        import time

        session = SessionState(
            instance_name="test",
            created_at=time.time(),
            last_activity=time.time(),
            idle_timeout=60.0,
        )

        # Not idle initially
        assert session.is_idle is False

        # Simulate being idle for more than timeout
        session.last_activity = time.time() - 100
        assert session.is_idle is True

    def test_add_and_complete_turn(self):
        """Test adding and completing a turn."""
        session = SessionState(
            instance_name="test",
            created_at=1000.0,
            last_activity=1000.0,
        )

        turn = ConversationTurn(
            request_id="req-1",
            timestamp=1000.0,
            request="hello",
        )
        session.add_turn(turn)

        assert session.total_requests == 1
        assert session.active_turn == turn

        # Complete the turn
        session.complete_turn("req-1", "hi there")

        assert session.completed_requests == 1
        assert session.active_turn is None
        assert session.turns[0].response == "hi there"

    def test_failed_turn_affects_stats(self):
        """Test that failed turns affect statistics."""
        session = SessionState(
            instance_name="test",
            created_at=1000.0,
            last_activity=1000.0,
        )

        turn = ConversationTurn(
            request_id="req-1",
            timestamp=1000.0,
            request="hello",
        )
        session.add_turn(turn)
        session.complete_turn("req-1", "", error="Failed")

        assert session.failed_requests == 1
        assert session.success_rate == 0.0

    def test_max_history_limit(self):
        """Test that max_history limits turns stored."""
        session = SessionState(
            instance_name="test",
            created_at=1000.0,
            last_activity=1000.0,
            max_history=3,
        )

        # Add more turns than max_history
        for i in range(5):
            turn = ConversationTurn(
                request_id=f"req-{i}",
                timestamp=1000.0 + i,
                request=f"request {i}",
            )
            session.add_turn(turn)
            session.complete_turn(f"req-{i}", f"response {i}")

        # Should only keep last 3 turns
        assert len(session.turns) == 3
        assert session.turns[0].request_id == "req-2"
        assert session.turns[2].request_id == "req-4"

    def test_get_recent_history(self):
        """Test getting recent conversation history."""
        session = SessionState(
            instance_name="test",
            created_at=1000.0,
            last_activity=1000.0,
        )

        # Add some turns
        for i in range(5):
            turn = ConversationTurn(
                request_id=f"req-{i}",
                timestamp=1000.0 + i,
                request=f"request {i}",
            )
            session.add_turn(turn)
            session.complete_turn(f"req-{i}", f"response {i}")

        history = session.get_recent_history(limit=3)

        assert len(history) == 3
        assert history[0]["request_id"] == "req-2"
        assert history[2]["request_id"] == "req-4"


class TestSessionTracker:
    """Tests for SessionTracker class."""

    @pytest.mark.asyncio
    async def test_create_session(self, session_tracker):
        """Test creating a session."""
        session = await session_tracker.create_session("test-instance")

        assert session.instance_name == "test-instance"
        assert session.status == "active"
        assert session.total_requests == 0

    @pytest.mark.asyncio
    async def test_get_existing_session(self, session_tracker):
        """Test getting an existing session."""
        session1 = await session_tracker.create_session("test-instance")
        session2 = await session_tracker.get_session("test-instance")

        assert session1 is session2

    @pytest.mark.asyncio
    async def test_remove_session(self, session_tracker):
        """Test removing a session."""
        await session_tracker.create_session("test-instance")
        await session_tracker.remove_session("test-instance")

        session = await session_tracker.get_session("test-instance")
        assert session is None

    @pytest.mark.asyncio
    async def test_start_request(self, session_tracker):
        """Test starting a request."""
        request_id, session = await session_tracker.start_request(
            "test-instance", "hello"
        )

        assert request_id is not None
        assert session.instance_name == "test-instance"
        assert session.total_requests == 1
        assert session.active_turn is not None
        assert session.active_turn.request == "hello"

    @pytest.mark.asyncio
    async def test_complete_request(self, session_tracker):
        """Test completing a request."""
        request_id, _ = await session_tracker.start_request("test-instance", "hello")

        await session_tracker.complete_request(
            "test-instance",
            request_id,
            "hi there!",
            error=None,
        )

        session = await session_tracker.get_session("test-instance")
        assert session is not None
        assert session.completed_requests == 1
        assert session.failed_requests == 0
        assert session.active_turn is None

    @pytest.mark.asyncio
    async def test_complete_request_with_error(self, session_tracker):
        """Test completing a request with error."""
        request_id, _ = await session_tracker.start_request("test-instance", "hello")

        await session_tracker.complete_request(
            "test-instance",
            request_id,
            "",
            error="Connection failed",
        )

        session = await session_tracker.get_session("test-instance")
        assert session is not None
        assert session.completed_requests == 1
        assert session.failed_requests == 1

    @pytest.mark.asyncio
    async def test_auto_create_session_on_request(self, session_tracker):
        """Test that session is auto-created on first request."""
        request_id, session = await session_tracker.start_request(
            "new-instance", "test"
        )

        assert session is not None
        assert session.instance_name == "new-instance"
        assert session.total_requests == 1

    @pytest.mark.asyncio
    async def test_get_status(self, session_tracker):
        """Test getting session status."""
        await session_tracker.create_session("test-instance")

        status = await session_tracker.get_status("test-instance")

        assert status is not None
        assert status["instance_name"] == "test-instance"
        assert status["total_requests"] == 0
        assert status["is_active"] is False  # No active turn

    @pytest.mark.asyncio
    async def test_get_all_statuses(self, session_tracker):
        """Test getting all session statuses."""
        await session_tracker.create_session("instance-1")
        await session_tracker.create_session("instance-2")

        statuses = await session_tracker.get_all_statuses()

        assert len(statuses) == 2
        assert "instance-1" in statuses
        assert "instance-2" in statuses

    @pytest.mark.asyncio
    async def test_get_history(self, session_tracker):
        """Test getting conversation history."""
        request_id, _ = await session_tracker.start_request("test-instance", "hello")
        await session_tracker.complete_request(
            "test-instance",
            request_id,
            "hi!",
            error=None,
        )

        history = await session_tracker.get_history("test-instance", limit=10)

        assert len(history) == 1
        assert history[0]["request"] == "hello"
        assert history[0]["response"] == "hi!"

    @pytest.mark.asyncio
    async def test_cleanup_inactive_sessions(self, session_tracker):
        """Test cleaning up inactive sessions."""
        # Create sessions with different activity times
        await session_tracker.create_session("active-instance")
        await session_tracker.create_session("inactive-instance")

        import time

        # Manually set last_activity to simulate inactivity
        session1 = await session_tracker.get_session("active-instance")
        session1.last_activity = time.time()

        session2 = await session_tracker.get_session("inactive-instance")
        session2.last_activity = time.time() - 400  # More than max_inactive_time

        # Clean up sessions inactive for 300 seconds
        removed = await session_tracker.cleanup_inactive_sessions(
            max_inactive_time=300.0
        )

        assert "inactive-instance" in removed
        assert "active-instance" not in removed


class TestGlobalSessionTracker:
    """Tests for global session tracker singleton."""

    @pytest.mark.asyncio
    async def test_get_session_tracker_singleton(self):
        """Test that get_session_tracker returns same instance."""
        tracker1 = get_session_tracker()
        tracker2 = get_session_tracker()

        assert tracker1 is tracker2

    @pytest.mark.asyncio
    async def test_global_tracker_persists(self):
        """Test that global tracker persists across calls."""
        tracker1 = get_session_tracker()
        await tracker1.create_session("test")
        tracker2 = get_session_tracker()

        session = await tracker2.get_session("test")
        assert session is not None


@pytest.mark.asyncio
async def test_timeout_monitoring():
    """Test session timeout monitoring."""
    import asyncio

    tracker = SessionTracker(
        idle_timeout=0.1,  # Very short timeout for testing
        request_timeout=0.1,
        max_history=5,
    )

    # Track timeouts
    timed_out_sessions = []

    async def timeout_callback(instance_name: str, session: SessionState):
        """Callback for timed out sessions."""
        timed_out_sessions.append(instance_name)

    # Start monitoring
    await tracker.start_monitoring(
        check_interval=0.05, timeout_callback=timeout_callback
    )

    # Create a session and let it go idle
    await tracker.create_session("test-instance")
    await asyncio.sleep(0.2)  # Wait for idle timeout

    await tracker.stop_monitoring()

    # Session should be marked as idle
    session = await tracker.get_session("test-instance")
    assert session is not None
    assert session.is_idle is True
    assert "test-instance" in timed_out_sessions
