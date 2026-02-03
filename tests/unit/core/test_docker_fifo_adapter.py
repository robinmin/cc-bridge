"""
Tests for DockerInstance FIFO adapter.
"""

# ruff: noqa: PLC0415 (intentional lazy imports in tests)
from unittest.mock import MagicMock

import pytest

from cc_bridge.core.instance_interface import DockerInstance, InstanceOperationError
from cc_bridge.models.instances import ClaudeInstance


@pytest.fixture
def docker_instance():
    """Create a Docker instance for testing."""
    return ClaudeInstance(
        name="test-docker",
        instance_type="docker",
        container_id="abc123",
        container_name="claude-test",
        image_name="claude:latest",
        docker_network="claude-network",
        communication_mode="fifo",
    )


@pytest.fixture
def docker_instance_legacy_mode():
    """Create a Docker instance in legacy mode for testing."""
    return ClaudeInstance(
        name="test-docker-legacy",
        instance_type="docker",
        container_id="def456",
        container_name="claude-test-legacy",
        image_name="claude:latest",
        docker_network="claude-network",
        communication_mode="exec",
    )


class TestDockerInstanceFIFOMode:
    """Tests for DockerInstance in FIFO communication mode."""

    def test_init_fifo_mode(self, docker_instance):
        """Test initialization in FIFO mode."""
        adapter = DockerInstance(docker_instance)

        assert adapter.communication_mode == "fifo"
        assert adapter.instance.name == "test-docker"
        assert adapter._fifo_initialized is False
        assert adapter._pipe_channel is None

    def test_init_legacy_mode(self, docker_instance_legacy_mode):
        """Test initialization in legacy mode."""
        adapter = DockerInstance(docker_instance_legacy_mode)

        assert adapter.communication_mode == "exec"
        assert adapter._fifo_initialized is False

    def test_pipe_dir_expansion(self, docker_instance, monkeypatch):
        """Test that pipe_dir expands ${PROJECT_NAME} correctly."""
        # Mock config to return project name - patch at the config module level
        monkeypatch.setattr(
            "cc_bridge.config.get_config",
            lambda: {
                "docker": {
                    "pipe_dir": "/tmp/cc-bridge/${PROJECT_NAME}/pipes",
                    "communication_mode": "fifo",
                },
                "project_name": "my-project",
            },
        )

        adapter = DockerInstance(docker_instance)
        assert adapter.pipe_dir == "/tmp/cc-bridge/my-project/pipes"

    @pytest.mark.asyncio
    async def test_ensure_fifo_initialized(self, docker_instance):
        """Test FIFO initialization creates pipes."""
        adapter = DockerInstance(docker_instance, pipe_dir="/tmp/test-cc-bridge/pipes")

        await adapter._ensure_fifo_initialized()

        assert adapter._fifo_initialized is True
        assert adapter._pipe_channel is not None

        # Clean up
        adapter.cleanup()

    @pytest.mark.asyncio
    async def test_ensure_fifo_initialized_idempotent(self, docker_instance):
        """Test that calling _ensure_fifo_initialized multiple times is safe."""
        adapter = DockerInstance(docker_instance, pipe_dir="/tmp/test-cc-bridge/pipes")

        await adapter._ensure_fifo_initialized()
        first_channel = adapter._pipe_channel

        await adapter._ensure_fifo_initialized()
        second_channel = adapter._pipe_channel

        assert first_channel is second_channel

        # Clean up
        adapter.cleanup()

    @pytest.mark.asyncio
    async def test_send_command_fifo_not_running(self, docker_instance):
        """Test send_command fails when container is not running."""
        adapter = DockerInstance(docker_instance)
        # Mock is_running to return False
        adapter.is_running = MagicMock(return_value=False)  # type: ignore[assignment]

        with pytest.raises(InstanceOperationError) as exc_info:
            async for _ in adapter.send_command("test command"):
                pass

        assert "Container is not running" in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_get_info_includes_communication_mode(self, docker_instance):
        """Test get_info includes communication mode and FIFO info."""
        adapter = DockerInstance(docker_instance)
        # Mock docker_client for get_info
        adapter.docker_client = MagicMock()
        mock_container = MagicMock()
        mock_container.status = "running"
        mock_container.attrs = {"Created": "2024-01-01T00:00:00.000000000Z"}
        adapter.docker_client.containers.get = MagicMock(return_value=mock_container)

        info = adapter.get_info()

        assert info["communication_mode"] == "fifo"
        assert info["pipe_dir"] is not None
        assert "fifo_initialized" in info

    def test_cleanup_closes_fifo_pipes(self, docker_instance):
        """Test cleanup closes FIFO pipes when initialized."""
        adapter = DockerInstance(docker_instance)
        # Mock the pipe channel
        adapter._pipe_channel = MagicMock()
        adapter._fifo_initialized = True

        adapter.cleanup()

        adapter._pipe_channel.close.assert_called_once()
        assert adapter._fifo_initialized is False


class TestDockerInstanceLegacyMode:
    """Tests for DockerInstance in legacy (docker exec) communication mode."""

    def test_init_legacy_mode_attributes(self, docker_instance_legacy_mode):
        """Test legacy mode initialization sets correct attributes."""
        adapter = DockerInstance(docker_instance_legacy_mode)

        assert adapter.communication_mode == "exec"
        # Pipe channel is None in legacy mode
        assert adapter._pipe_channel is None

    @pytest.mark.asyncio
    async def test_send_command_legacy_not_running(self, docker_instance_legacy_mode):
        """Test send_command fails when container is not running in legacy mode."""
        adapter = DockerInstance(docker_instance_legacy_mode)
        # Mock is_running to return False
        adapter.is_running = MagicMock(return_value=False)  # type: ignore[assignment]

        with pytest.raises(InstanceOperationError) as exc_info:
            async for _ in adapter.send_command("test command"):
                pass

        assert "Container is not running" in str(exc_info.value)


class TestDockerInstanceCommunicationRouting:
    """Tests for communication mode routing in send_command."""

    @pytest.mark.asyncio
    async def test_send_command_routes_to_fifo(self, docker_instance):
        """Test send_command routes to FIFO implementation in fifo mode."""
        adapter = DockerInstance(docker_instance)

        # Create an async generator function for the mock
        async def mock_fifo_generator(text, **kwargs):
            """Mock FIFO async generator."""
            assert text == "test"
            yield "response"

        # Patch the FIFO method
        adapter._send_command_fifo = mock_fifo_generator  # type: ignore[assignment]
        # Mock is_running to return True
        adapter.is_running = MagicMock(return_value=True)  # type: ignore[assignment]

        results = []
        async for line in adapter.send_command("test"):
            results.append(line)

        assert results == ["response"]

    @pytest.mark.asyncio
    async def test_send_command_routes_to_legacy(self, docker_instance_legacy_mode):
        """Test send_command routes to legacy implementation in exec mode."""
        adapter = DockerInstance(docker_instance_legacy_mode)

        # Create an async generator function for the mock
        async def mock_exec_generator(text, **kwargs):
            """Mock exec async generator."""
            assert text == "test"
            yield "response"

        # Patch the exec method
        adapter._send_command_exec = mock_exec_generator  # type: ignore[assignment]
        # Mock is_running to return True
        adapter.is_running = MagicMock(return_value=True)  # type: ignore[assignment]

        results = []
        async for line in adapter.send_command("test"):
            results.append(line)

        assert results == ["response"]


class TestClaudeInstanceCommunicationMode:
    """Tests for ClaudeInstance communication_mode field."""

    def test_default_communication_mode(self):
        """Test default communication mode is fifo."""
        instance = ClaudeInstance(
            name="test",
            instance_type="docker",
            container_id="abc123",
        )

        assert instance.communication_mode == "fifo"

    def test_explicit_communication_mode_exec(self):
        """Test explicit communication mode can be set to exec."""
        instance = ClaudeInstance(
            name="test",
            instance_type="docker",
            container_id="abc123",
            communication_mode="exec",
        )

        assert instance.communication_mode == "exec"

    def test_communication_mode_validation(self):
        """Test communication_mode accepts valid values."""
        # These should not raise
        ClaudeInstance(
            name="test",
            instance_type="docker",
            container_id="abc123",
            communication_mode="fifo",
        )
        ClaudeInstance(
            name="test",
            instance_type="docker",
            container_id="abc123",
            communication_mode="exec",
        )
