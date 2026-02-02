"""
Tests for server command.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from cc_bridge.commands import server
from cc_bridge.commands.server import (
    RateLimiter,
    app,
    get_instance_manager_dep,
    get_telegram_client_dep,
)


@pytest.mark.asyncio
async def test_root_endpoint():
    """Test root endpoint returns 404 for security (information disclosure prevention)."""
    # Root endpoint intentionally returns 404 to prevent information disclosure
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/")

        assert response.status_code == 404
        assert "Not found" in response.json()["detail"]


@pytest.mark.asyncio
async def test_health_endpoint():
    """Test health endpoint returns healthy status."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/health")

        assert response.status_code == 200
        assert response.json()["status"] == "healthy"


@pytest.mark.asyncio
@patch("cc_bridge.commands.server.get_config")
async def test_webhook_endpoint(mock_get_config):
    """Test webhook endpoint accepts updates."""
    # Mock config to allow any chat ID during this test
    mock_conf = MagicMock()
    mock_conf.get.return_value = None
    mock_get_config.return_value = mock_conf

    # Mock dependencies
    mock_manager = MagicMock()
    mock_manager.list_instances.return_value = []

    mock_telegram = MagicMock()
    mock_telegram.send_message = AsyncMock()

    app.dependency_overrides[get_instance_manager_dep] = lambda: mock_manager
    app.dependency_overrides[get_telegram_client_dep] = lambda: mock_telegram

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            payload = {
                "update_id": 12345,
                "message": {
                    "message_id": 1,
                    "from": {"id": 123456, "first_name": "Test"},
                    "chat": {"id": 123456, "type": "private"},
                    "date": 1234567890,
                    "text": "Test message",
                },
            }

            response = await client.post("/webhook", json=payload)

            assert response.status_code == 200
            # Response is "error" because no running Claude instances are expected
            assert response.json()["status"] == "error"
            assert "instance" in response.json()["reason"]

            # Close client explicitly
            await client.aclose()
    finally:
        # Clear overrides
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_webhook_empty_update_returns_400():
    """Test that empty update returns 400 Bad Request status code."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post("/webhook", json={})

        assert response.status_code == 400
        data = response.json()
        assert data["status"] == "error"
        assert data["reason"] == "Empty update"


@pytest.mark.asyncio
async def test_webhook_rate_limit_returns_429():
    """Test that rate limited requests return 429 Too Many Requests status code."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        payload = {
            "update_id": 12345,
            "message": {
                "message_id": 1,
                "from": {"id": 123456, "first_name": "Test"},
                "chat": {"id": 999999, "type": "private"},  # Use unique chat_id
                "date": 1234567890,
                "text": "Test message",
            },
        }

        # Create a rate limiter that's already exhausted
        # Store original rate limiter
        original_rate_limiter = server._rate_limiter

        # Create a strict rate limiter (0 requests allowed)
        server._rate_limiter = RateLimiter(requests=0, window=60)

        try:
            response = await client.post("/webhook", json=payload)

            assert response.status_code == 429
            data = response.json()
            assert data["status"] == "rate_limited"
            assert "retry_after" in data
            assert "message" in data
        finally:
            # Restore original rate limiter
            server._rate_limiter = original_rate_limiter


@pytest.mark.asyncio
async def test_webhook_message_too_long_returns_400():
    """Test that overly long messages return 400 Bad Request status code."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # Create a message that exceeds MAX_MESSAGE_LENGTH (4000)
        long_text = "x" * 4001

        payload = {
            "update_id": 12345,
            "message": {
                "message_id": 1,
                "from": {"id": 123456, "first_name": "Test"},
                "chat": {"id": 888888, "type": "private"},  # Use unique chat_id
                "date": 1234567890,
                "text": long_text,
            },
        }

        response = await client.post("/webhook", json=payload)

        assert response.status_code == 400
        data = response.json()
        assert data["status"] == "error"
        assert data["reason"] == "Message too long"


@pytest.mark.asyncio
async def test_webhook_request_too_large_returns_413():
    """Test that request size validation returns proper 413 status code."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # Send request with Content-Length header exceeding limit (10KB)
        response = await client.post(
            "/webhook",
            json={"update_id": 1},
            headers={"Content-Length": "100000"},  # 100KB, exceeds 10KB limit
        )

        assert response.status_code == 413
        data = response.json()
        assert data["status"] == "error"
        assert data["reason"] == "Request too large"
