"""
Tests for container agent.
"""

# ruff: noqa: PLC0415 (intentional lazy imports in tests)

import pytest

from cc_bridge.agents.container_agent import ClaudeProcessManager, ContainerAgent


class TestClaudeProcessManager:
    """Tests for ClaudeProcessManager class."""

    def test_init_default_args(self):
        """Test initialization with default arguments."""
        manager = ClaudeProcessManager()
        assert manager.claude_args == []
        assert manager.log_level == "INFO"
        assert manager.process is None
        assert manager._running is False
        assert manager._restart_count == 0
        assert manager._max_restarts == 5
        assert manager._restart_backoff == 1.0
        assert manager._max_backoff == 30.0

    def test_init_with_args(self):
        """Test initialization with custom arguments."""
        manager = ClaudeProcessManager(
            claude_args=["--allow-dangerously-skip-permissions"],
            log_level="DEBUG",
        )
        assert manager.claude_args == ["--allow-dangerously-skip-permissions"]
        assert manager.log_level == "DEBUG"

    def test_get_status_initial(self):
        """Test get_status returns expected fields."""
        manager = ClaudeProcessManager()
        status = manager.get_status()
        assert status["mode"] == "daemon"
        assert status["running"] is False
        assert status["claude_pid"] is None
        assert status["claude_returncode"] is None
        assert status["restart_count"] == 0
        assert "idle_seconds" in status


class TestContainerAgent:
    """Tests for ContainerAgent class."""

    def test_init_daemon_mode(self):
        """Test initialization in daemon mode."""
        agent = ContainerAgent(mode="daemon")
        assert agent.mode == "daemon"
        assert agent.claude_args == []
        assert agent.log_level == "INFO"
        assert agent.claude_manager is not None
        assert agent.running is False

    def test_init_legacy_mode(self):
        """Test initialization in legacy mode."""
        agent = ContainerAgent(mode="legacy")
        assert agent.mode == "legacy"
        assert agent.claude_manager is None  # No manager in legacy mode

    def test_init_with_claude_args(self):
        """Test initialization with Claude arguments."""
        agent = ContainerAgent(
            claude_args=["--allow-dangerously-skip-permissions"],
            mode="daemon",
            log_level="DEBUG",
        )
        assert agent.claude_args == ["--allow-dangerously-skip-permissions"]
        assert agent.log_level == "DEBUG"
        assert agent.claude_manager is not None

    def test_get_status_daemon_mode(self):
        """Test get_status in daemon mode."""
        agent = ContainerAgent(mode="daemon")
        status = agent.get_status()
        assert status["mode"] == "daemon"
        assert status["running"] is False
        assert status["log_level"] == "INFO"
        assert "claude_pid" in status
        assert "restart_count" in status

    def test_get_status_legacy_mode(self):
        """Test get_status in legacy mode."""
        agent = ContainerAgent(mode="legacy")
        status = agent.get_status()
        assert status["mode"] == "legacy"
        assert status["running"] is False
        # Legacy mode doesn't have Claude manager fields
        assert "claude_pid" not in status

    def test_shutdown_sets_running_false(self):
        """Test shutdown sets the running flag to False."""
        agent = ContainerAgent(mode="daemon")
        agent.running = True  # Simulate agent is running
        agent.shutdown()
        assert agent.running is False
        # Shutdown event is also set
        assert agent._shutdown_event.is_set()

    @pytest.mark.asyncio
    async def test_daemon_mode_has_manager(self):
        """Test daemon mode creates ClaudeProcessManager."""
        agent = ContainerAgent(mode="daemon")
        assert agent.claude_manager is not None
        assert isinstance(agent.claude_manager, ClaudeProcessManager)

    @pytest.mark.asyncio
    async def test_legacy_mode_no_manager(self):
        """Test legacy mode does not create ClaudeProcessManager."""
        agent = ContainerAgent(mode="legacy")
        assert agent.claude_manager is None
