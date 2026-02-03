"""
Tests for Telegram client.
"""

import pytest


@pytest.mark.asyncio
async def test_send_message(mock_telegram_client):
    """Test sending message to Telegram."""
    result = await mock_telegram_client.send_message(
        chat_id=123456, text="Test message"
    )
    assert result["ok"] is True
    mock_telegram_client.send_message.assert_called_once()


@pytest.mark.asyncio
async def test_set_webhook(mock_telegram_client):
    """Test setting webhook."""
    result = await mock_telegram_client.set_webhook("https://example.com")
    assert result["ok"] is True
    mock_telegram_client.set_webhook.assert_called_once()


@pytest.mark.asyncio
async def test_get_webhook_info(mock_telegram_client):
    """Test getting webhook info."""
    result = await mock_telegram_client.get_webhook_info()
    assert result["ok"] is True
    assert "url" in result


@pytest.mark.asyncio
async def test_delete_webhook(mock_telegram_client):
    """Test deleting webhook."""
    result = await mock_telegram_client.delete_webhook()
    assert result["ok"] is True


@pytest.mark.asyncio
async def test_answer_callback_query(mock_telegram_client):
    """Test answering callback query."""
    result = await mock_telegram_client.answer_callback_query("callback_123", "Test")
    assert result["ok"] is True
