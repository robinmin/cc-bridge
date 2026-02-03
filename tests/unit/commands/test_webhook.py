"""
Tests for the cc_bridge.commands.webhook module.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from cc_bridge.commands.webhook import (
    delete_webhook,
    get_webhook_info,
    main,
    set_webhook,
    test_webhook as cmd_test_webhook,
)


@pytest.mark.asyncio
@patch("cc_bridge.commands.webhook.get_config")
@patch("cc_bridge.commands.webhook.TelegramClient")
async def test_set_webhook(mock_telegram_client, mock_get_config):
    """Test setting the webhook."""
    # Mock config
    mock_conf = MagicMock()
    mock_conf.get.return_value = "https://example.com/webhook"
    mock_get_config.return_value = mock_conf

    # Mock TelegramClient as async context manager
    mock_client_instance = AsyncMock()
    mock_client_instance.__aenter__.return_value = mock_client_instance
    mock_client_instance.set_webhook.return_value = {"ok": True}
    mock_telegram_client.return_value = mock_client_instance

    # Call the function
    result = await set_webhook("https://example.com/webhook")

    # Assertions
    assert result is True
    mock_telegram_client.assert_called_once()
    mock_client_instance.set_webhook.assert_called_once_with(
        "https://example.com/webhook"
    )


@pytest.mark.asyncio
@patch("cc_bridge.commands.webhook.get_config")
@patch("cc_bridge.commands.webhook.TelegramClient")
async def test_get_webhook_info(mock_telegram_client, mock_get_config):
    """Test getting webhook info."""
    # Mock config
    mock_conf = MagicMock()
    mock_get_config.return_value = mock_conf

    # Mock TelegramClient
    mock_client_instance = AsyncMock()
    mock_client_instance.__aenter__.return_value = mock_client_instance
    mock_client_instance.get_webhook_info.return_value = {
        "ok": True,
        "result": {"url": "https://example.com"},
    }
    mock_telegram_client.return_value = mock_client_instance

    # Call the function
    result = await get_webhook_info()

    # Assertions
    assert result["result"]["url"] == "https://example.com"
    mock_telegram_client.assert_called_once()
    mock_client_instance.get_webhook_info.assert_called_once()


@pytest.mark.asyncio
@patch("cc_bridge.commands.webhook.get_config")
@patch("cc_bridge.commands.webhook.TelegramClient")
async def test_delete_webhook(mock_telegram_client, mock_get_config):
    """Test deleting the webhook."""
    # Mock config
    mock_conf = MagicMock()
    mock_get_config.return_value = mock_conf

    # Mock TelegramClient
    mock_client_instance = AsyncMock()
    mock_client_instance.__aenter__.return_value = mock_client_instance
    mock_client_instance.delete_webhook.return_value = {"ok": True}
    mock_telegram_client.return_value = mock_client_instance

    # Call the function
    result = await delete_webhook()

    # Assertions
    assert result is True
    mock_telegram_client.assert_called_once()
    mock_client_instance.delete_webhook.assert_called_once()


@pytest.mark.asyncio
@patch("cc_bridge.commands.webhook.get_config")
@patch("cc_bridge.commands.webhook.httpx.AsyncClient")
async def test_test_webhook_cmd(mock_async_client, mock_get_config):
    """Test the webhook test command."""
    # Mock config
    mock_conf = MagicMock()
    mock_get_config.return_value = mock_conf

    # Mock AsyncClient
    mock_client_instance = AsyncMock()
    mock_client_instance.__aenter__.return_value = mock_client_instance

    # Configure response mock
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {"status": "ok"}

    mock_client_instance.post.return_value = mock_response
    mock_async_client.return_value = mock_client_instance

    # Call the function
    result = await cmd_test_webhook("http://localhost:8080/webhook")

    # Assertions
    assert result is True
    mock_async_client.assert_called_once()
    mock_client_instance.post.assert_called_once()


@patch("cc_bridge.commands.webhook.asyncio.run")
@patch("cc_bridge.commands.webhook.set_webhook", new_callable=MagicMock)
@patch("cc_bridge.commands.webhook.get_webhook_info", new_callable=MagicMock)
@patch("cc_bridge.commands.webhook.delete_webhook", new_callable=MagicMock)
@patch("cc_bridge.commands.webhook.test_webhook", new_callable=MagicMock)
def test_main(mock_test, mock_delete, mock_get, mock_set, mock_run):
    """Test the main entry point."""
    # Configure asyncio.run to return the result of the coroutine-mock
    mock_run.side_effect = lambda x: x

    # Configure the mocks to return simple values
    mock_set.return_value = True
    mock_get.return_value = {"ok": True}
    mock_delete.return_value = True
    mock_test.return_value = True

    # Call the function with various arguments
    # Providing all arguments explicitly since direct calls don't process Typer defaults
    main(set="https://example.com", get=False, delete=False, test=None)
    assert mock_set.called
    assert mock_run.called

    mock_run.reset_mock()
    mock_set.reset_mock()
    main(set=None, get=True, delete=False, test=None)
    assert mock_get.called
    assert mock_run.called

    mock_run.reset_mock()
    mock_get.reset_mock()
    main(set=None, get=False, delete=True, test=None)
    assert mock_delete.called
    assert mock_run.called

    mock_run.reset_mock()
    mock_delete.reset_mock()
    main(set=None, get=False, delete=False, test="http://localhost")
    assert mock_test.called
    assert mock_run.called
