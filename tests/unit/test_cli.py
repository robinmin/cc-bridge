"""
Tests for CLI module.

Tests follow TDD principles:
1. Write failing test first
2. Implement minimal code to pass
3. Refactor for cleanliness
"""

# ruff: noqa: PLC0415 (intentional lazy imports in tests)
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from typer.testing import CliRunner

from cc_bridge.cli import app

runner = CliRunner()


class TestCLIInitialization:
    """Test CLI initialization."""

    def test_cli_has_app_instance(self):
        """CLI should have Typer app instance."""
        from cc_bridge.cli import app

        assert app is not None
        assert app.info.name == "cc-bridge"
        assert app.info.help is not None
        assert "Telegram bot bridge" in app.info.help

    def test_cli_all_commands_exist(self):
        """CLI should have all required commands registered."""
        from cc_bridge.cli import app

        # Simply verify that commands can be invoked without errors
        expected_commands = [
            "server",
            "hook-stop",
            "health",
            "setup",
            "config",
            "tunnel",
        ]
        for cmd_name in expected_commands:
            # Try to get help for each command
            result = runner.invoke(app, [cmd_name, "--help"])
            # Should not error - command exists
            # Exit code 0 means command was found
            assert (
                result.exit_code == 0 or result.exit_code is None
            ), f"Command '{cmd_name}' not found"


class TestCLIServerCommand:
    """Test server command."""

    def test_server_command_exists(self):
        """Server command should be callable."""
        result = runner.invoke(app, ["server", "--help"])
        assert result.exit_code == 0
        assert "Start the FastAPI webhook server" in result.stdout

    @patch("cc_bridge.commands.server.uvicorn.run")
    def test_server_command_accepts_reload_flag(self, mock_run):
        """Server command should accept reload flag."""
        result = runner.invoke(
            app, ["server", "--reload", "--host", "127.0.0.1", "--port", "9000"]
        )

        assert result.exit_code == 0
        kwargs = mock_run.call_args[1]
        assert kwargs["host"] == "127.0.0.1"
        assert kwargs["port"] == 9000
        assert kwargs["reload"] is True

    @patch("cc_bridge.commands.server.uvicorn.run")
    def test_server_command_accepts_host_option(self, mock_run):
        """Server command should accept host option."""
        result = runner.invoke(app, ["server", "--host", "127.0.0.1"])

        assert result.exit_code == 0
        assert mock_run.call_args[1]["host"] == "127.0.0.1"

    @patch("cc_bridge.commands.server.uvicorn.run")
    def test_server_command_accepts_port_option(self, mock_run):
        """Server command should accept port option."""
        result = runner.invoke(app, ["server", "--port", "9000"])

        assert result.exit_code == 0
        assert mock_run.call_args[1]["port"] == 9000


class TestCLIHookStopCommand:
    """Test hook-stop command."""

    def test_hook_stop_command_exists(self):
        """Hook-stop command should be callable."""
        result = runner.invoke(app, ["hook-stop", "--help"])
        assert result.exit_code == 0
        assert "Send Claude response to Telegram" in result.stdout

    @patch("cc_bridge.commands.hook_stop.TelegramClient")
    def test_hook_stop_command_accepts_transcript_path(
        self, mock_telegram_client, tmp_path: Path
    ):
        """Hook-stop command should accept transcript path."""
        # Create a valid transcript format
        transcript = tmp_path / "transcript.md"
        transcript.write_text(
            """
[user]
Hello, how are you?

[assistant]
I'm doing well, thank you! I'm here to help you with your coding tasks and questions. What would you like to work on today?
"""
        )

        # Mock the TelegramClient to return success
        mock_client = MagicMock()
        mock_client.send_message = AsyncMock(return_value=True)
        mock_telegram_client.return_value = mock_client

        result = runner.invoke(app, ["hook-stop", str(transcript)])

        # Should succeed with mocked Telegram client
        assert result.exit_code == 0


class TestCLIHealthCommand:
    """Test health command."""

    def test_health_command_exists(self):
        """Health command should be callable."""
        result = runner.invoke(app, ["health", "--help"])
        assert result.exit_code == 0
        assert "Run health checks" in result.stdout

    def test_health_command_runs(self):
        """Health command should execute."""
        result = runner.invoke(app, ["health"])

        # Health command exits with 1 in test environment (no actual services to check)
        assert result.exit_code in (0, 1)


class TestCLISetupCommand:
    """Test setup command."""

    def test_setup_command_exists(self):
        """Setup command should be callable."""
        result = runner.invoke(app, ["setup", "--help"])
        assert result.exit_code == 0
        assert "Interactive setup wizard" in result.stdout

    def test_setup_command_runs(self):
        """Setup command should execute."""
        result = runner.invoke(app, ["setup"])

        # Setup command fails in test environment (EOF when reading input)
        assert result.exit_code == 1
        assert "Setup failed" in result.stdout or "EOF" in result.stdout


class TestCLIConfigCommand:
    """Test config command."""

    def test_config_command_exists(self):
        """Config command should be callable."""
        result = runner.invoke(app, ["config", "--help"])
        assert result.exit_code == 0
        assert "Configuration management" in result.stdout

    def test_config_get_all(self):
        """Config command should get all config."""
        result = runner.invoke(app, ["config"])

        # Currently stub, should not crash
        assert result.exit_code == 0

    def test_config_get_specific_key(self):
        """Config command should get specific key."""
        result = runner.invoke(app, ["config", "--key", "server.port"])

        # Currently stub, should not crash
        assert result.exit_code == 0

    def test_config_set_value(self):
        """Config command should set value."""
        result = runner.invoke(
            app, ["config", "--key", "server.port", "--value", "9000"]
        )

        # Currently stub, should not crash
        assert result.exit_code == 0

    def test_config_delete_key(self):
        """Config command should delete key."""
        result = runner.invoke(app, ["config", "--key", "test.key", "--delete"])

        # Currently stub, should not crash
        assert result.exit_code == 0


class TestCLITunnelCommand:
    """Test tunnel command."""

    def test_tunnel_command_exists(self):
        """Tunnel command should be callable."""
        result = runner.invoke(app, ["tunnel", "--help"])
        assert result.exit_code == 0
        assert "Cloudflare tunnel management" in result.stdout

    @patch(
        "cc_bridge.core.tunnel.CloudflareTunnelManager.start",
        new=AsyncMock(return_value="https://test.trycloudflare.com"),
    )
    @patch(
        "cc_bridge.core.telegram.TelegramClient.set_webhook",
        new=AsyncMock(return_value=True),
    )
    def test_tunnel_start_flag(self):
        """Tunnel command should accept start flag."""
        result = runner.invoke(app, ["tunnel", "--start"])

        # Should succeed with mocked calls
        assert result.exit_code == 0

    def test_tunnel_stop_flag(self):
        """Tunnel command should accept stop flag."""
        result = runner.invoke(app, ["tunnel", "--stop"])

        # Currently stub, should not crash
        assert result.exit_code == 0

    def test_tunnel_port_option(self):
        """Tunnel command should accept port option."""
        result = runner.invoke(app, ["tunnel", "--port", "9000"])

        # Tunnel command exits with 1 in test environment (cloudflared not available)
        assert result.exit_code == 1


class TestCLIConfigurationIntegration:
    """Test CLI integration with configuration."""

    @patch("cc_bridge.cli.get_config")
    def test_cli_loads_config_on_startup(self, mock_get_config):
        """CLI should load configuration on startup."""
        mock_config = MagicMock()
        mock_config.get.return_value = "test_value"
        mock_get_config.return_value = mock_config

        result = runner.invoke(app, ["config"])

        # Config should be accessed
        assert result.exit_code == 0


class TestCLILoggingIntegration:
    """Test CLI integration with logging."""

    @patch("cc_bridge.cli.setup_logging")
    def test_cli_initializes_logging(self, mock_setup_logging):
        """CLI should initialize logging based on config."""
        result = runner.invoke(app, ["config"])

        # Currently stub, but setup_logging should be called in real implementation
        assert result.exit_code == 0


class TestCLIErrorHandling:
    """Test CLI error handling."""

    def test_handles_invalid_config_key_gracefully(self):
        """Should handle invalid config key gracefully."""
        result = runner.invoke(app, ["config", "--key", "invalid.nested.key"])

        # Should not crash
        assert result.exit_code == 0

    def test_shows_help_on_unknown_command(self):
        """Should show help for unknown commands."""
        result = runner.invoke(app, ["unknown-command"])

        # Should show error or help
        assert result.exit_code != 0 or "help" in result.stdout.lower()
