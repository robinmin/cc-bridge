"""
pytest fixtures and configuration for cc-bridge tests.
"""

# ruff: noqa: PLC0415 (intentional lazy imports in test fixtures)
import os
from collections.abc import AsyncGenerator
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient

from cc_bridge.config import Config
from cc_bridge.core.telegram import TelegramClient
from cc_bridge.core.tmux import TmuxSession

# Store original environment variables before any tests run
_ORIG_ENV = os.environ.copy()

# Type stub for _config global (using string forward reference)
_config: "Config | None" = None


@pytest.fixture(autouse=True, scope="session")
def clean_test_environment() -> None:  # type: ignore[misc]
    """
    Clean environment for entire test session.

    This must run before any tests to prevent loading of user's
    actual configuration from environment variables or .env file.
    """
    # Clear problematic environment variables at session start
    env_vars_to_clear = [
        "LOG_LEVEL",
        "TELEGRAM_BOT_TOKEN",
        "TELEGRAM_CHAT_ID",
        "TELEGRAM_WEBHOOK_URL",
        "TMUX_SESSION",
        "PORT",
    ]
    for var in env_vars_to_clear:
        os.environ.pop(var, None)

    yield

    # No cleanup needed - we want this to persist for all tests


@pytest.fixture(autouse=True)
def reset_global_config() -> None:  # type: ignore[misc]
    """
    Reset global config singleton and environment variables before each test.

    This ensures tests don't pollute each other's state.
    """
    global _config  # noqa: PLW0603

    # Reset config singleton
    _config = None

    # Reset environment variables to original state
    # Remove any variables that were added by tests (excluding pytest's own vars)
    pytest_vars = {"PYTEST_CURRENT_TEST", "PYTEST_XDIST_WORKER", "PYTEST_XDIST_WORKER_COUNT"}
    added_vars = (set(os.environ.keys()) - set(_ORIG_ENV.keys())) - pytest_vars
    for var in added_vars:
        os.environ.pop(var, None)

    # Restore original values for any modified variables
    for var in set(_ORIG_ENV.keys()) & set(os.environ.keys()):
        if os.environ[var] != _ORIG_ENV[var]:
            os.environ[var] = _ORIG_ENV[var]

    yield

    # Cleanup after test
    _config = None

    # Final environment cleanup - use pop to avoid KeyError
    current_vars = set(os.environ.keys())
    original_vars = set(_ORIG_ENV.keys())
    added_vars = (current_vars - original_vars) - pytest_vars
    for var in added_vars:
        os.environ.pop(var, None)


@pytest.fixture(autouse=True)
def prevent_env_file_loading() -> None:  # type: ignore[misc]
    """
    Prevent loading of .env files during tests.

    This ensures tests run in isolation without loading
    environment variables from the project's .env file.
    """
    # Patch _load_env_file to do nothing
    with patch.object(Config, "_load_env_file", return_value=None):
        yield


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
    session.session_exists = MagicMock(return_value=True)  # type: ignore[assignment]
    # Mock send_keys to track calls
    session.send_keys = MagicMock()  # type: ignore[assignment]
    # Mock get_session_output
    session.get_session_output = MagicMock(return_value="Test output")  # type: ignore[assignment]
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
    async with AsyncClient(base_url="http://test") as client:
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
