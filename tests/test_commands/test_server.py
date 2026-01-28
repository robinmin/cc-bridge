"""
Tests for server command.
"""

import pytest
from httpx import AsyncClient, ASGITransport

from cc_bridge.commands.server import app


@pytest.mark.asyncio
async def test_root_endpoint():
    """Test root endpoint returns status ok."""
    # Use ASGITransport for FastAPI app testing
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/")

        assert response.status_code == 200
        assert response.json()["status"] == "ok"
        assert response.json()["service"] == "cc-bridge"


@pytest.mark.asyncio
async def test_health_endpoint():
    """Test health endpoint returns healthy status."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/health")

        assert response.status_code == 200
        assert response.json()["status"] == "healthy"


@pytest.mark.asyncio
async def test_webhook_endpoint():
    """Test webhook endpoint accepts updates."""
    # Create client directly without context manager to avoid closure issues
    transport = ASGITransport(app=app)
    client = AsyncClient(transport=transport, base_url="http://test")

    payload = {
        "update_id": 12345,
        "message": {
            "message_id": 1,
            "from": {"id": 123456, "first_name": "Test"},
            "chat": {"id": 123456, "type": "private"},
            "text": "Test message",
        },
    }

    response = await client.post("/webhook", json=payload)

    assert response.status_code == 200
    assert response.json()["status"] == "ok"

    # Close client explicitly
    await client.aclose()
