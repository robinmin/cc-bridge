"""
Tests for health monitoring and crash recovery.
"""

# ruff: noqa: PLC0415 (intentional lazy imports in tests)
from datetime import datetime
from unittest.mock import AsyncMock

import pytest

from cc_bridge.core.health_monitor import (
    DaemonRecovery,
    HealthMonitor,
    HealthStatus,
    get_health_monitor,
)


@pytest.fixture
def health_monitor():
    """Create a fresh health monitor for each test."""
    return HealthMonitor(
        check_interval=1.0,
        recovery_delay=0.1,
        max_consecutive_failures=2,
    )


class TestHealthStatus:
    """Tests for HealthStatus dataclass."""

    def test_create_status(self):
        """Test creating a health status."""
        status = HealthStatus(
            instance_name="test-instance",
            healthy=True,
            last_check=datetime.now(),
        )

        assert status.instance_name == "test-instance"
        assert status.healthy is True
        assert status.consecutive_failures == 0

    def test_to_dict(self):
        """Test converting status to dictionary."""
        now = datetime.now()
        status = HealthStatus(
            instance_name="test",
            healthy=True,
            last_check=now,
            container_running=True,
            pipes_exist=True,
        )

        result = status.to_dict()

        assert result["instance_name"] == "test"
        assert result["healthy"] is True
        assert result["container_running"] is True
        assert result["pipes_exist"] is True

    def test_to_dict_with_recovery(self):
        """Test converting status with recovery attempt to dictionary."""
        status = HealthStatus(
            instance_name="test",
            healthy=False,
            last_check=datetime.now(),
            last_recovery_attempt=datetime.now(),
            error_message="Test error",
        )

        result = status.to_dict()

        assert result["error_message"] == "Test error"
        assert result["last_recovery_attempt"] is not None


class TestHealthMonitor:
    """Tests for HealthMonitor class."""

    def test_init(self, health_monitor):
        """Test health monitor initialization."""
        assert health_monitor.check_interval == 1.0
        assert health_monitor.recovery_delay == 0.1
        assert health_monitor.max_consecutive_failures == 2
        assert health_monitor._running is False
        assert len(health_monitor._health_status) == 0

    @pytest.mark.asyncio
    async def test_start_stop(self, health_monitor):
        """Test starting and stopping health monitor."""
        assert health_monitor._running is False

        await health_monitor.start()
        assert health_monitor._running is True
        assert health_monitor._monitor_task is not None

        await health_monitor.stop()
        assert health_monitor._running is False

    @pytest.mark.asyncio
    async def test_start_already_running(self, health_monitor):
        """Test starting monitor when already running."""
        await health_monitor.start()
        # Should not raise, just log warning
        await health_monitor.start()

        await health_monitor.stop()

    @pytest.mark.asyncio
    async def test_add_recovery_callback(self, health_monitor):
        """Test adding recovery callbacks."""
        callback = AsyncMock()

        health_monitor.add_recovery_callback(callback)

        assert len(health_monitor._recovery_callbacks) == 1

    @pytest.mark.asyncio
    async def test_get_health_status_no_instances(self, health_monitor):
        """Test getting health status when no instances checked."""
        status = await health_monitor.get_health_status("non-existent")
        assert status is None

        all_status = await health_monitor.get_health_status()
        assert all_status == {}

    @pytest.mark.asyncio
    async def test_get_health_status_after_check(self, health_monitor):
        """Test getting health status after manually adding status."""
        # Manually add a health status
        from cc_bridge.core.health_monitor import HealthStatus

        health_monitor._health_status["test-instance"] = HealthStatus(
            instance_name="test-instance",
            healthy=True,
            last_check=datetime.now(),
        )

        status = await health_monitor.get_health_status("test-instance")
        assert status is not None
        assert status["instance_name"] == "test-instance"

    @pytest.mark.asyncio
    async def test_is_healthy(self, health_monitor):
        """Test checking if instance is healthy."""
        # Add a healthy status
        health_monitor._health_status["test"] = HealthStatus(
            instance_name="test",
            healthy=True,
            last_check=datetime.now(),
        )

        assert await health_monitor.is_healthy("test") is True

        # Make it unhealthy
        health_monitor._health_status["test"].healthy = False
        assert await health_monitor.is_healthy("test") is False

        # Non-existent instance
        assert await health_monitor.is_healthy("non-existent") is False

    @pytest.mark.asyncio
    async def test_recovery_trigger_on_max_failures(self, health_monitor):
        """Test that recovery is triggered after max consecutive failures."""
        recovery_called = []

        async def mock_recovery(instance_name: str):
            recovery_called.append(instance_name)

        health_monitor.add_recovery_callback(mock_recovery)

        # Create an unhealthy status with max failures
        health_monitor._health_status["test"] = HealthStatus(
            instance_name="test",
            healthy=False,
            last_check=datetime.now(),
            consecutive_failures=2,
        )

        await health_monitor._trigger_recovery("test")

        assert "test" in recovery_called
        assert health_monitor._health_status["test"].last_recovery_attempt is not None

    @pytest.mark.asyncio
    async def test_recovery_not_triggered_with_recent_attempt(self, health_monitor):
        """Test that recovery is not triggered if recently attempted."""
        recovery_called = []

        async def mock_recovery(instance_name: str):
            recovery_called.append(instance_name)

        health_monitor.add_recovery_callback(mock_recovery)

        # Create status with recent recovery attempt
        now = datetime.now()
        health_monitor._health_status["test"] = HealthStatus(
            instance_name="test",
            healthy=False,
            last_check=now,
            consecutive_failures=2,
            last_recovery_attempt=now,  # Just attempted
        )

        await health_monitor._trigger_recovery("test")

        # Should not trigger recovery (too recent)
        assert len(recovery_called) == 0


class TestDaemonRecovery:
    """Tests for DaemonRecovery class."""

    def test_init(self, health_monitor):
        """Test DaemonRecovery initialization."""
        recovery = DaemonRecovery(health_monitor)

        assert recovery.health_monitor is health_monitor

    @pytest.mark.asyncio
    async def test_recover_instance_not_docker(self, health_monitor):
        """Test recovering non-Docker instance (should be no-op)."""
        recovery = DaemonRecovery(health_monitor)

        # Should not raise, just log warning
        await recovery.recover_instance("non-existent")

    @pytest.mark.asyncio
    async def test_recover_session_state(self, health_monitor):
        """Test session state recovery."""
        recovery = DaemonRecovery(health_monitor)

        # Should not raise even if session doesn't exist
        await recovery.recover_session_state("test-instance")


class TestGlobalHealthMonitor:
    """Tests for global health monitor singleton."""

    @pytest.mark.asyncio
    async def test_get_health_monitor_singleton(self):
        """Test that get_health_monitor returns same instance."""
        monitor1 = get_health_monitor()
        monitor2 = get_health_monitor()

        assert monitor1 is monitor2


@pytest.mark.asyncio
async def test_health_monitor_integration():
    """Test health monitoring recovery trigger."""

    from cc_bridge.core.health_monitor import HealthStatus

    monitor = HealthMonitor(
        check_interval=0.1,
        max_consecutive_failures=1,
    )

    recovery_calls = []

    async def mock_recovery(name: str):
        recovery_calls.append(name)

    monitor.add_recovery_callback(mock_recovery)

    # Manually add unhealthy status that exceeds max failures
    monitor._health_status["test-instance"] = HealthStatus(
        instance_name="test-instance",
        healthy=False,
        last_check=datetime.now(),
        consecutive_failures=1,  # At max failures
        error_message="Test error",
    )

    # Trigger recovery
    await monitor._trigger_recovery("test-instance")

    # Verify recovery was triggered
    assert "test-instance" in recovery_calls
    assert monitor._health_status["test-instance"].last_recovery_attempt is not None
