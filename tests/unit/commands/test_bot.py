"""
Tests for bot command implementation.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from cc_bridge.core.telegram import DEFAULT_BOT_COMMANDS, TelegramClient


class TestDefaultBotCommands:
    """Tests for DEFAULT_BOT_COMMANDS constant."""

    def test_returns_list(self):
        """Test that DEFAULT_BOT_COMMANDS is a list."""
        assert isinstance(DEFAULT_BOT_COMMANDS, list)

    def test_returns_non_empty_list(self):
        """Test that DEFAULT_BOT_COMMANDS is non-empty list."""
        assert len(DEFAULT_BOT_COMMANDS) > 0

    def test_command_structure(self):
        """Test that each command has required fields."""
        for cmd in DEFAULT_BOT_COMMANDS:
            assert "command" in cmd
            assert "description" in cmd
            assert isinstance(cmd["command"], str)
            assert isinstance(cmd["description"], str)

    def test_expected_commands_exist(self):
        """Test that expected commands are present."""
        command_names = [cmd["command"] for cmd in DEFAULT_BOT_COMMANDS]

        expected_commands = ["status", "clear", "stop", "resume", "help"]
        for expected in expected_commands:
            assert expected in command_names

    def test_command_descriptions(self):
        """Test that command descriptions are non-empty strings."""
        for cmd in DEFAULT_BOT_COMMANDS:
            assert len(cmd["description"]) > 0


class TestTelegramClientBotCommands:
    """Tests for TelegramClient bot command methods."""

    @pytest.mark.asyncio
    async def test_set_bot_commands_success(self):
        """Test successful command setting."""
        client = TelegramClient(bot_token="test_token")

        # Mock the httpx.AsyncClient
        mock_response = MagicMock()
        mock_response.json = MagicMock(return_value={"ok": True, "result": True})
        mock_response.raise_for_status = MagicMock()

        async_mock_post = AsyncMock(return_value=mock_response)

        mock_httpx_client = MagicMock()
        mock_httpx_client.post = async_mock_post

        # Mock _get_client to return our mock client
        with patch.object(client, "_get_client", return_value=mock_httpx_client):
            result = await client.set_bot_commands(DEFAULT_BOT_COMMANDS)

        assert result == {"ok": True, "result": True}
        async_mock_post.assert_called_once()

    @pytest.mark.asyncio
    async def test_set_bot_commands_failure(self):
        """Test handling of failed API response."""
        client = TelegramClient(bot_token="test_token")

        # Mock failed API response
        mock_response = MagicMock()
        mock_response.json = MagicMock(
            return_value={"ok": False, "description": "Bad Request: chat not found"}
        )
        mock_response.raise_for_status = MagicMock(side_effect=Exception("HTTP Error"))

        async_mock_post = AsyncMock(return_value=mock_response)

        mock_httpx_client = MagicMock()
        mock_httpx_client.post = async_mock_post

        # Mock _get_client to return our mock client
        with patch.object(
            client, "_get_client", return_value=mock_httpx_client
        ), pytest.raises(Exception, match="HTTP Error"):
            await client.set_bot_commands(DEFAULT_BOT_COMMANDS)

    @pytest.mark.asyncio
    async def test_get_bot_commands(self):
        """Test getting bot commands from Telegram."""
        client = TelegramClient(bot_token="test_token")

        # Mock successful API response
        mock_response = MagicMock()
        mock_response.json = MagicMock(
            return_value={
                "ok": True,
                "result": [
                    {"command": "status", "description": "Check status"},
                    {"command": "help", "description": "Show help"},
                ],
            }
        )
        mock_response.raise_for_status = MagicMock()

        async_mock_get = AsyncMock(return_value=mock_response)

        mock_httpx_client = MagicMock()
        mock_httpx_client.get = async_mock_get

        # Mock _get_client to return our mock client
        with patch.object(client, "_get_client", return_value=mock_httpx_client):
            result = await client.get_bot_commands()

        # get_bot_commands returns the full response
        assert result["ok"] is True
        assert result["result"] == [
            {"command": "status", "description": "Check status"},
            {"command": "help", "description": "Show help"},
        ]
        async_mock_get.assert_called_once()

    @pytest.mark.asyncio
    async def test_delete_bot_commands(self):
        """Test deleting bot commands."""
        client = TelegramClient(bot_token="test_token")

        # Mock successful API response
        mock_response = MagicMock()
        mock_response.json = MagicMock(return_value={"ok": True, "result": True})
        mock_response.raise_for_status = MagicMock()

        async_mock_post = AsyncMock(return_value=mock_response)

        mock_httpx_client = MagicMock()
        mock_httpx_client.post = async_mock_post

        # Mock _get_client to return our mock client
        with patch.object(client, "_get_client", return_value=mock_httpx_client):
            result = await client.delete_bot_commands()

        assert result == {"ok": True, "result": True}
        async_mock_post.assert_called_once()
