"""
Integration tests for FIFO communication system.

These tests verify the end-to-end integration between:
- NamedPipeChannel (low-level FIFO communication)
- DockerInstance adapter (FIFO mode)
- Session tracking (request correlation)
"""

import asyncio
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from cc_bridge.core.health_monitor import HealthMonitor, get_health_monitor
from cc_bridge.core.instance_interface import DockerInstance
from cc_bridge.core.named_pipe import NamedPipeChannel
from cc_bridge.core.session_tracker import SessionTracker
from cc_bridge.models.instances import ClaudeInstance


@pytest.fixture
def session_tracker():
    """Create a fresh session tracker for each test."""
    tracker = SessionTracker(
        idle_timeout=60.0,
        request_timeout=30.0,
        max_history=10,
    )
    return tracker


@pytest.fixture
def temp_pipe_dir():
    """Create a temporary directory for FIFO pipes."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield tmpdir


@pytest.fixture
def docker_instance():
    """Create a Docker instance for testing."""
    return ClaudeInstance(
        name="test-instance",
        instance_type="docker",
        container_id="test-container-id",
        container_name="test-container",
        image_name="claude:latest",
        docker_network="test-network",
        communication_mode="fifo",
    )


class TestNamedPipeChannelIntegration:
    """Integration tests for NamedPipeChannel."""

    def test_create_and_cleanup_pipes(self, temp_pipe_dir):
        """Test creating and cleaning up FIFO pipes."""
        channel = NamedPipeChannel(instance_name="test", pipe_dir=temp_pipe_dir)

        # Create pipes
        channel.create_pipes()

        # Verify pipes exist
        assert Path(channel.input_pipe_path).exists()
        assert Path(channel.output_pipe_path).exists()

        # Verify they have .fifo extension
        assert str(channel.input_pipe_path).endswith(".fifo")
        assert str(channel.output_pipe_path).endswith(".fifo")

        # Clean up
        channel.close()

        # Verify pipes are removed
        assert not Path(channel.input_pipe_path).exists()
        assert not Path(channel.output_pipe_path).exists()

    def test_idempotent_create(self, temp_pipe_dir):
        """Test that create_pipes is idempotent."""
        channel = NamedPipeChannel(instance_name="test", pipe_dir=temp_pipe_dir)

        # Create pipes twice
        channel.create_pipes()
        first_input = channel.input_pipe_path
        first_output = channel.output_pipe_path

        channel.create_pipes()

        # Should use same paths
        assert channel.input_pipe_path == first_input
        assert channel.output_pipe_path == first_output

        channel.close()

    def test_pipe_paths_format(self, temp_pipe_dir):
        """Test that pipe paths follow expected format."""
        channel = NamedPipeChannel(instance_name="my-instance", pipe_dir=temp_pipe_dir)

        # Convert to strings for checking
        input_path = str(channel.input_pipe_path)
        output_path = str(channel.output_pipe_path)

        # Pipes contain instance name
        assert "my-instance" in input_path
        assert "my-instance" in output_path

        # Both pipes are in the temp directory
        assert temp_pipe_dir in input_path
        assert temp_pipe_dir in output_path


class TestDockerInstanceFIFOIntegration:
    """Integration tests for DockerInstance FIFO mode."""

    def test_fifo_mode_initialization(self, docker_instance, temp_pipe_dir):
        """Test DockerInstance initialization in FIFO mode."""
        adapter = DockerInstance(docker_instance, pipe_dir=temp_pipe_dir)

        assert adapter.communication_mode == "fifo"
        assert adapter._fifo_initialized is False
        assert adapter._pipe_channel is None

    @pytest.mark.asyncio
    async def test_fifo_initialization(self, docker_instance, temp_pipe_dir):
        """Test FIFO initialization creates pipes."""
        adapter = DockerInstance(docker_instance, pipe_dir=temp_pipe_dir)

        await adapter._ensure_fifo_initialized()

        assert adapter._fifo_initialized is True
        assert adapter._pipe_channel is not None

        # Verify pipes exist
        assert Path(adapter._pipe_channel.input_pipe_path).exists()
        assert Path(adapter._pipe_channel.output_pipe_path).exists()

        # Clean up
        adapter.cleanup()

    @pytest.mark.asyncio
    async def test_send_command_fifo_not_running(self, docker_instance, temp_pipe_dir):
        """Test send_command fails when container is not running."""
        adapter = DockerInstance(docker_instance, pipe_dir=temp_pipe_dir)

        # Mock is_running to return False
        with patch.object(adapter, "is_running", return_value=False):
            with pytest.raises(Exception) as exc_info:
                async for _ in adapter.send_command("test command"):
                    pass

            assert "Container is not running" in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_send_command_fifo_with_session_tracking(
        self, docker_instance, temp_pipe_dir, session_tracker
    ):
        """Test FIFO communication with session tracking."""
        adapter = DockerInstance(docker_instance, pipe_dir=temp_pipe_dir)

        # Initialize FIFO
        await adapter._ensure_fifo_initialized()

        # Mock the pipe channel send_and_receive to avoid blocking
        async def mock_send_and_receive(command, timeout):
            # Simulate a response
            yield f"Response to: {command}"

        with (
            patch.object(adapter._pipe_channel, "send_and_receive", new=mock_send_and_receive),
            patch.object(adapter, "is_running", return_value=True),
        ):
            # Send command
            response_chunks = []
            async for chunk in adapter._send_command_fifo("hello"):
                response_chunks.append(chunk)

            assert len(response_chunks) == 1
            assert "Response to: hello" in response_chunks[0]

        # Clean up
        adapter.cleanup()

    @pytest.mark.asyncio
    async def test_get_info_includes_fifo_info(self, docker_instance, temp_pipe_dir):
        """Test get_info includes FIFO mode information."""
        adapter = DockerInstance(docker_instance, pipe_dir=temp_pipe_dir)

        # Mock docker_client
        adapter.docker_client = MagicMock()
        mock_container = MagicMock()
        mock_container.status = "running"
        mock_container.attrs = {"Created": "2024-01-01T00:00:00.000000000Z"}
        adapter.docker_client.containers.get = MagicMock(return_value=mock_container)

        # Get info
        info = adapter.get_info()

        assert info["communication_mode"] == "fifo"
        assert info["pipe_dir"] is not None
        assert "fifo_initialized" in info

    @pytest.mark.asyncio
    async def test_cleanup_closes_pipes(self, docker_instance, temp_pipe_dir):
        """Test cleanup closes FIFO pipes when initialized."""
        adapter = DockerInstance(docker_instance, pipe_dir=temp_pipe_dir)

        # Initialize FIFO
        await adapter._ensure_fifo_initialized()

        # Get pipe paths for verification
        input_path = str(adapter._pipe_channel.input_pipe_path)  # type: ignore[union-attr]
        output_path = str(adapter._pipe_channel.output_pipe_path)  # type: ignore[union-attr]

        # Verify pipes exist
        assert Path(input_path).exists()
        assert Path(output_path).exists()

        # Clean up
        adapter.cleanup()

        # Verify pipes are removed
        assert not Path(input_path).exists()
        assert not Path(output_path).exists()


class TestSessionTrackerIntegration:
    """Integration tests for session tracking with FIFO communication."""

    @pytest.mark.asyncio
    async def test_request_lifecycle(self, session_tracker):
        """Test complete request lifecycle through session tracker."""
        # Start a request
        request_id, session = await session_tracker.start_request("test-instance", "hello world")

        assert request_id is not None
        assert session.total_requests == 1
        assert session.active_turn is not None
        assert session.active_turn.request == "hello world"

        # Complete the request
        await session_tracker.complete_request(
            "test-instance",
            request_id,
            "Hi there!",
            error=None,
        )

        # Verify completion
        session_after = await session_tracker.get_session("test-instance")
        assert session_after.completed_requests == 1
        assert session_after.failed_requests == 0
        assert session_after.active_turn is None

    @pytest.mark.asyncio
    async def test_failed_request_lifecycle(self, session_tracker):
        """Test failed request lifecycle."""
        # Start a request
        request_id, _ = await session_tracker.start_request("test-instance", "bad request")

        # Complete with error
        await session_tracker.complete_request(
            "test-instance",
            request_id,
            "",
            error="Request failed",
        )

        # Verify failure tracking
        session = await session_tracker.get_session("test-instance")
        assert session.completed_requests == 1
        assert session.failed_requests == 1
        assert session.success_rate == 0.0

    @pytest.mark.asyncio
    async def test_conversation_history_tracking(self, session_tracker):
        """Test conversation history is tracked correctly."""
        # Create multiple requests
        for i in range(3):
            request_id, _ = await session_tracker.start_request("test-instance", f"message {i}")
            await session_tracker.complete_request(
                "test-instance", request_id, f"response {i}", error=None
            )

        # Get history
        history = await session_tracker.get_history("test-instance", limit=10)

        assert len(history) == 3
        assert history[0]["request"] == "message 0"
        assert history[1]["request"] == "message 1"
        assert history[2]["request"] == "message 2"

    @pytest.mark.asyncio
    async def test_session_idle_detection(self, session_tracker):
        """Test session idle detection."""
        import time

        # Create session
        await session_tracker.create_session("test-instance")

        session = await session_tracker.get_session("test-instance")
        assert session.is_idle is False

        # Simulate old activity
        session.last_activity = time.time() - 400  # More than idle_timeout
        assert session.is_idle is True


class TestHealthMonitorIntegration:
    """Integration tests for health monitoring with FIFO instances."""

    @pytest.mark.asyncio
    async def test_health_monitor_lifecycle(self):
        """Test health monitor start and stop."""
        monitor = HealthMonitor(check_interval=0.1, max_consecutive_failures=2)

        assert monitor._running is False

        await monitor.start()
        assert monitor._running is True

        await monitor.stop()
        assert monitor._running is False

    @pytest.mark.asyncio
    async def test_health_status_tracking(self):
        """Test health status is tracked correctly."""
        from datetime import datetime

        from cc_bridge.core.health_monitor import HealthStatus

        monitor = HealthMonitor()
        monitor._health_status["test"] = HealthStatus(
            instance_name="test",
            healthy=True,
            last_check=datetime.now(),
            container_running=True,
            pipes_exist=True,
        )

        status = await monitor.get_health_status("test")
        assert status is not None
        assert status["instance_name"] == "test"
        assert status["healthy"] is True
        assert status["container_running"] is True

    @pytest.mark.asyncio
    async def test_recovery_callback_triggered(self):
        """Test recovery callback is triggered on consecutive failures."""
        from datetime import datetime

        from cc_bridge.core.health_monitor import HealthStatus

        monitor = HealthMonitor(max_consecutive_failures=2)

        recovery_called = []

        async def mock_recovery(name):
            recovery_called.append(name)

        monitor.add_recovery_callback(mock_recovery)

        # Add unhealthy status with max failures
        monitor._health_status["test"] = HealthStatus(
            instance_name="test",
            healthy=False,
            last_check=datetime.now(),
            consecutive_failures=2,
        )

        await monitor._trigger_recovery("test")

        assert "test" in recovery_called

    @pytest.mark.asyncio
    async def test_global_health_monitor_singleton(self):
        """Test global health monitor singleton."""
        monitor1 = get_health_monitor()
        monitor2 = get_health_monitor()

        assert monitor1 is monitor2


class TestEndToEndFIFOFlow:
    """End-to-end integration tests for FIFO communication flow."""

    @pytest.mark.asyncio
    async def test_complete_fifo_request_flow(self, temp_pipe_dir):
        """Test complete request flow from DockerInstance through session tracking."""
        # Create instance
        instance = ClaudeInstance(
            name="e2e-test",
            instance_type="docker",
            container_id="e2e-container",
            container_name="e2e-container",
            image_name="claude:latest",
            docker_network="test-net",
            communication_mode="fifo",
        )

        # Create adapter
        adapter = DockerInstance(instance, pipe_dir=temp_pipe_dir)

        # Initialize FIFO
        await adapter._ensure_fifo_initialized()

        # Mock pipe communication
        async def mock_send(command, timeout):
            yield "OK"

        # Mock is_running
        with (
            patch.object(adapter, "is_running", return_value=True),
            patch.object(adapter._pipe_channel, "send_and_receive", new=mock_send),
        ):
            # Send command
            responses = []
            async for chunk in adapter.send_command("test"):
                responses.append(chunk)

            assert len(responses) == 1
            assert responses[0] == "OK"

        # Clean up
        adapter.cleanup()

    @pytest.mark.asyncio
    async def test_fifo_error_handling(self, temp_pipe_dir):
        """Test error handling in FIFO communication."""
        instance = ClaudeInstance(
            name="error-test",
            instance_type="docker",
            container_id="error-container",
            container_name="error-container",
            image_name="claude:latest",
            docker_network="test-net",
            communication_mode="fifo",
        )

        adapter = DockerInstance(instance, pipe_dir=temp_pipe_dir)

        await adapter._ensure_fifo_initialized()

        # Mock timeout error - must be an async generator to match the real interface
        async def mock_timeout(command, timeout):
            raise asyncio.TimeoutError("Communication timeout")
            yield  # Makes this an async generator (never reached)

        with (
            patch.object(adapter, "is_running", return_value=True),
            patch.object(adapter._pipe_channel, "send_and_receive", new=mock_timeout),
        ):
            with pytest.raises(Exception) as exc_info:
                async for _ in adapter.send_command("test"):
                    pass

            assert "FIFO communication timed out" in str(exc_info.value)

        adapter.cleanup()

    @pytest.mark.asyncio
    async def test_communication_mode_routing(self, temp_pipe_dir):
        """Test that communication mode routes to FIFO implementation."""
        instance_fifo = ClaudeInstance(
            name="fifo-test",
            instance_type="docker",
            container_id="fifo-container",
            communication_mode="fifo",
        )

        instance_exec = ClaudeInstance(
            name="exec-test",
            instance_type="docker",
            container_id="exec-container",
            communication_mode="exec",
        )

        adapter_fifo = DockerInstance(instance_fifo, pipe_dir=temp_pipe_dir)
        adapter_exec = DockerInstance(instance_exec, pipe_dir=temp_pipe_dir)

        assert adapter_fifo.communication_mode == "fifo"
        assert adapter_exec.communication_mode == "exec"

        # Verify FIFO adapter has _ensure_fifo_initialized method
        assert hasattr(adapter_fifo, "_ensure_fifo_initialized")

        # Verify exec adapter doesn't use FIFO
        assert adapter_exec._fifo_initialized is False

    @pytest.mark.asyncio
    async def test_multiple_fifo_requests(self, temp_pipe_dir):
        """Test multiple FIFO requests in sequence."""
        instance = ClaudeInstance(
            name="multi-test",
            instance_type="docker",
            container_id="multi-container",
            communication_mode="fifo",
        )

        adapter = DockerInstance(instance, pipe_dir=temp_pipe_dir)

        # Initialize FIFO first
        await adapter._ensure_fifo_initialized()

        # Mock multiple successful requests
        request_count = 0

        async def mock_send(command, timeout):
            nonlocal request_count
            request_count += 1
            yield f"Response {request_count}"

        # Now patch the initialized pipe channel
        original_send = adapter._pipe_channel.send_and_receive  # type: ignore[union-attr]
        adapter._pipe_channel.send_and_receive = mock_send  # type: ignore[assignment]

        try:
            with patch.object(adapter, "is_running", return_value=True):
                # Send multiple commands
                for i in range(3):
                    responses = []
                    async for chunk in adapter.send_command(f"command {i}"):
                        responses.append(chunk)
                    assert len(responses) == 1
        finally:
            # Restore original
            adapter._pipe_channel.send_and_receive = original_send  # type: ignore[assignment]
            adapter.cleanup()

        # Verify 3 requests were processed
        assert request_count == 3


class TestFIFOHealthIntegration:
    """Integration tests for FIFO health monitoring."""

    @pytest.mark.asyncio
    async def test_fifo_pipes_health_check(self, temp_pipe_dir):
        """Test health check for FIFO pipes."""
        from cc_bridge.commands.health import check_fifo_pipes

        # Create pipes
        channel = NamedPipeChannel(instance_name="test", pipe_dir=temp_pipe_dir)
        channel.create_pipes()

        # Create a mock config dict that handles nested access
        class MockConfig(dict):
            def get(self, key, default=None):
                if key == "docker":
                    return {"pipe_dir": temp_pipe_dir}
                return default

        with patch("cc_bridge.commands.health.get_config", return_value=MockConfig()):
            # Run health check
            result = check_fifo_pipes()

            # Verify the health check completed successfully
            # Status can be healthy or warning depending on environment
            assert result["status"] in ("healthy", "warning")
            assert "pipe_dir" in result
            # If directory exists and is writable, check these fields
            if result.get("directory_exists") and result.get("writable") is not None:
                assert result["writable"] is True

        channel.close()

    @pytest.mark.asyncio
    async def test_health_monitor_detects_unhealthy_instance(self, temp_pipe_dir):
        """Test health monitor detects and recovers unhealthy instances."""
        from datetime import datetime

        from cc_bridge.core.health_monitor import HealthStatus

        monitor = HealthMonitor(max_consecutive_failures=1)

        # Add unhealthy status
        monitor._health_status["test"] = HealthStatus(
            instance_name="test",
            healthy=False,
            last_check=datetime.now(),
            consecutive_failures=1,
            error_message="FIFO pipes missing",
        )

        # Trigger recovery
        recovery_called = []

        async def mock_recovery(name):
            recovery_called.append(name)

        monitor.add_recovery_callback(mock_recovery)
        await monitor._trigger_recovery("test")

        assert "test" in recovery_called
