"""
Tests for bot command implementation.
"""

from unittest.mock import MagicMock, patch

import pytest

from cc_bridge.commands.bot import get_default_commands, main, set_bot_commands


class TestGetDefaultCommands:
    """Tests for get_default_commands function."""

    def test_returns_list(self):
        """Test that get_default_commands returns a list."""
        commands = get_default_commands()
        assert isinstance(commands, list)

    def test_returns_non_empty_list(self):
        """Test that get_default_commands returns non-empty list."""
        commands = get_default_commands()
        assert len(commands) > 0

    def test_command_structure(self):
        """Test that each command has required fields."""
        commands = get_default_commands()
        for cmd in commands:
            assert "command" in cmd
            assert "description" in cmd
            assert isinstance(cmd["command"], str)
            assert isinstance(cmd["description"], str)

    def test_expected_commands_exist(self):
        """Test that expected commands are present."""
        commands = get_default_commands()
        command_names = [cmd["command"] for cmd in commands]

        expected_commands = ["status", "clear", "stop", "resume", "help"]
        for expected in expected_commands:
            assert expected in command_names

    def test_command_descriptions(self):
        """Test that command descriptions are non-empty strings."""
        commands = get_default_commands()
        for cmd in commands:
            assert len(cmd["description"]) > 0


class TestSetBotCommands:
    """Tests for set_bot_commands function."""

    @pytest.mark.asyncio
    async def test_sets_commands_successfully(self):
        """Test successful command setting."""
        from unittest.mock import AsyncMock

        # Mock httpx.AsyncClient async context manager
        mock_response = MagicMock()
        mock_response.json = MagicMock(return_value={"ok": True, "result": True})

        async_mock_post = AsyncMock(return_value=mock_response)

        mock_client = MagicMock()
        mock_client.post = async_mock_post
        mock_client.__aenter__.return_value = mock_client
        mock_client.__aexit__.AsyncMock(return_value=None)

        with patch("cc_bridge.commands.bot.httpx.AsyncClient", return_value=mock_client):
            result = await set_bot_commands("test_token", get_default_commands())

        assert result is True
        async_mock_post.assert_called_once()

    @pytest.mark.asyncio
    async def test_handles_failure_response(self):
        """Test handling of failed API response."""
        from unittest.mock import AsyncMock

        # Mock failed API response
        mock_response = MagicMock()
        mock_response.json = MagicMock(
            return_value={"ok": False, "description": "Bad Request: chat not found"}
        )

        async_mock_post = AsyncMock(return_value=mock_response)

        mock_client = MagicMock()
        mock_client.post = async_mock_post
        mock_client.__aenter__.return_value = mock_client
        mock_client.__aexit__.AsyncMock(return_value=None)

        with patch("cc_bridge.commands.bot.httpx.AsyncClient", return_value=mock_client):
            result = await set_bot_commands("test_token", get_default_commands())

        assert result is False

    def test_function_is_async(self):
        """Test that set_bot_commands is an async function."""
        import inspect

        assert inspect.iscoroutinefunction(set_bot_commands)

    def test_function_signature(self):
        """Test set_bot_commands function signature."""
        import inspect

        sig = inspect.signature(set_bot_commands)
        params = sig.parameters
        assert "bot_token" in params
        assert "commands" in params


class TestMain:
    """Tests for main function."""

    @pytest.mark.asyncio
    async def test_main_sync_action_success(self, capsys):
        """Test main with sync action on success."""
        with patch("cc_bridge.commands.bot.set_bot_commands", return_value=True):
            exit_code = await main("sync")

        assert exit_code == 0
        captured = capsys.readouterr()
        assert "Commands synced" in captured.out

    @pytest.mark.asyncio
    async def test_main_sync_action_failure(self, capsys):
        """Test main with sync action on failure."""
        with patch("cc_bridge.commands.bot.set_bot_commands", return_value=False):
            exit_code = await main("sync")

        assert exit_code == 0
        captured = capsys.readouterr()
        assert "Commands failed to sync" in captured.out

    @pytest.mark.asyncio
    async def test_main_list_action(self, capsys):
        """Test main with list action."""
        exit_code = await main("list")

        assert exit_code == 0
        captured = capsys.readouterr()
        assert "Bot commands:" in captured.out
        assert "/status" in captured.out
        assert "/clear" in captured.out

    @pytest.mark.asyncio
    async def test_main_unknown_action(self, capsys):
        """Test main with unknown action."""
        exit_code = await main("unknown")

        assert exit_code == 1
        captured = capsys.readouterr()
        assert "Unknown action: unknown" in captured.out

    @pytest.mark.asyncio
    async def test_main_handles_exception(self, capsys):
        """Test main handles exceptions gracefully."""
        with patch("cc_bridge.commands.bot.set_bot_commands", side_effect=Exception("Test error")):
            exit_code = await main("sync")

        assert exit_code == 1
        captured = capsys.readouterr()
        assert "Error: Test error" in captured.err

    @pytest.mark.asyncio
    async def test_main_default_action(self, capsys):
        """Test main with default action (sync)."""
        with patch("cc_bridge.commands.bot.set_bot_commands", return_value=True):
            exit_code = await main()

        assert exit_code == 0
