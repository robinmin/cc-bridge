"""
pytest fixtures and configuration for cc-bridge tests.
"""

from pathlib import Path
from typing import AsyncGenerator, Generator
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import AsyncClient, Response

from cc_bridge.config import Config, _config
from cc_bridge.core.telegram import TelegramClient
from cc_bridge.core.tmux import TmuxSession


@pytest.fixture(autouse=True)
def reset_global_config() -> None:
    """
    Reset global config singleton before each test.

    This ensures tests don't pollute each other's state.
    """
    global _config
    _config = None
    yield
    _config = None


@pytest.fixture
def test_config_dir(tmp_path: Path) -> Path:
    """
    Create temporary config directory for tests.

    Args:
        tmp_path: pytest tmp_path fixture

    Returns:
        Path to temporary config directory
    """
    config_dir = tmp_path / ".claude" / "bridge"
    config_dir.mkdir(parents=True)
    return config_dir


@pytest.fixture
def test_config(test_config_dir: Path) -> Config:
    """
    Create test configuration.

    Args:
        test_config_dir: Test config directory fixture

    Returns:
        Config instance with test settings
    """
    config = Config(config_path=test_config_dir / "config.toml")

    # Set test values
    config.set("telegram.bot_token", "test_bot_token")
    config.set("telegram.chat_id", "123456")
    config.set("tmux.session", "test_claude")
    config.set("server.host", "127.0.0.1")
    config.set("server.port", 8888)

    return config


@pytest.fixture
def mock_telegram_client() -> TelegramClient:
    """
    Create mock Telegram client.

    Returns:
        MagicMock configured as TelegramClient
    """
    client = MagicMock(spec=TelegramClient)
    client.send_message = AsyncMock(return_value={"ok": True})
    client.set_webhook = AsyncMock(return_value={"ok": True})
    client.get_webhook_info = AsyncMock(return_value={"ok": True, "url": "https://example.com"})
    client.delete_webhook = AsyncMock(return_value={"ok": True})
    client.answer_callback_query = AsyncMock(return_value={"ok": True})
    return client


@pytest.fixture
def mock_tmux_session() -> TmuxSession:
    """
    Create mock tmux session.

    Returns:
        TmuxSession instance with mocked methods
    """
    from unittest.mock import MagicMock

    session = TmuxSession("test_claude")
    # Mock session_exists to return True
    session.session_exists = MagicMock(return_value=True)
    # Mock send_keys to track calls
    session.send_keys = MagicMock()
    # Mock get_session_output
    session.get_session_output = MagicMock(return_value="Test output")
    return session


@pytest.fixture
def sample_telegram_message() -> dict:
    """
    Sample Telegram message for testing.

    Returns:
        Sample message dict
    """
    return {
        "update_id": 12345,
        "message": {
            "message_id": 1,
            "from": {
                "id": 123456,
                "is_bot": False,
                "first_name": "Test",
                "username": "testuser",
            },
            "date": 1234567890,
            "chat": {"id": 123456, "type": "private"},
            "text": "Hello Claude",
        },
    }


@pytest.fixture
def sample_telegram_callback() -> dict:
    """
    Sample Telegram callback query for testing.

    Returns:
        Sample callback dict
    """
    return {
        "update_id": 12346,
        "callback_query": {
            "id": "callback_123",
            "from": {
                "id": 123456,
                "is_bot": False,
                "first_name": "Test",
                "username": "testuser",
            },
            "message": {
                "message_id": 1,
                "from": {
                    "id": 123456,
                    "is_bot": False,
                    "first_name": "Test",
                },
                "date": 1234567890,
                "chat": {"id": 123456, "type": "private"},
                "text": "Test message",
            },
            "data": "callback_data",
        },
    }


@pytest.fixture
async def async_http_client() -> AsyncGenerator[AsyncClient, None]:
    """
    Create async HTTP client for testing.

    Yields:
        AsyncClient instance
    """
    async with AsyncClient(app=None, base_url="http://test") as client:
        yield client


@pytest.fixture
def sample_transcript(tmp_path: Path) -> Path:
    """
    Create sample Claude transcript file.

    Args:
        tmp_path: pytest tmp_path fixture

    Returns:
        Path to sample transcript
    """
    transcript = tmp_path / "transcript.md"
    transcript.write_text(
        """
[user]
Hello, how are you?

[assistant]
I'm doing well, thank you! I'm here to help you with your coding tasks and questions. What would you like to work on today?
"""
    )
    return transcript
