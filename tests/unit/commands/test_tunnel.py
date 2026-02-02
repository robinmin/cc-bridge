"""
Tests for tunnel command enhancements.
"""

# ruff: noqa: PLC0415 (intentional lazy imports in tests)
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from cc_bridge.commands.tunnel import parse_tunnel_url, start_tunnel, stop_tunnel


class TestParseTunnelUrl:
    """Test tunnel URL parsing."""

    def test_parse_valid_url(self):
        """Should extract URL from cloudflared output."""
        output = """
2024-01-27T10:00:00Z INFO Starting tunnel...
2024-01-27T10:00:01Z INFO https://abc123.trycloudflare.com
2024-01-27T10:00:02Z INFO Tunnel running
        """
        url = parse_tunnel_url(output)
        assert url == "https://abc123.trycloudflare.com"

    def test_parse_url_with_hyphens(self):
        """Should handle URLs with hyphens."""
        output = "Your tunnel URL is: https://abc-def-123.trycloudflare.com"
        url = parse_tunnel_url(output)
        assert url == "https://abc-def-123.trycloudflare.com"

    def test_parse_no_url_in_output(self):
        """Should return None when no URL found."""
        output = "Some other output without tunnel URL"
        url = parse_tunnel_url(output)
        assert url is None

    def test_parse_empty_output(self):
        """Should handle empty output."""
        url = parse_tunnel_url("")
        assert url is None


class TestStartTunnel:
    """Test tunnel starting."""

    def test_start_tunnel_success(self):
        """Should start tunnel and return URL."""
        mock_process = MagicMock()
        mock_process.poll.return_value = None
        mock_process.stdout.readline.side_effect = [
            "Starting tunnel...\n",
            "https://test123.trycloudflare.com\n",
            "Tunnel running...\n",
        ]

        with patch("cc_bridge.commands.tunnel.subprocess.Popen", return_value=mock_process):
            url = start_tunnel(port=8080, timeout=5)
            assert url == "https://test123.trycloudflare.com"

    def test_start_tunnel_timeout(self):
        """Should timeout if URL not found."""
        mock_process = MagicMock()
        mock_process.poll.return_value = None
        mock_process.stdout.readline.side_effect = [
            "Starting tunnel...\n",
            "Still waiting...\n",
        ]

        with (
            patch("cc_bridge.commands.tunnel.subprocess.Popen", return_value=mock_process),
            pytest.raises(RuntimeError, match="Timeout"),
        ):
            start_tunnel(port=8080, timeout=1)

    def test_start_tunnel_cloudflared_not_found(self):
        """Should raise error if cloudflared not installed."""
        with (
            patch("cc_bridge.commands.tunnel.subprocess.Popen", side_effect=FileNotFoundError),
            pytest.raises(RuntimeError, match="cloudflared not found"),
        ):
            start_tunnel(port=8080)


class TestStopTunnel:
    """Test tunnel stopping."""

    def test_stop_tunnel_success(self):
        """Should stop cloudflared processes."""
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "12345\n67890\n"

        with patch("cc_bridge.commands.tunnel.subprocess.run", return_value=mock_result):
            stop_tunnel()
            # Should have been called to find and kill processes
            # No exception means success

    def test_stop_tunnel_no_processes(self):
        """Should handle no running processes."""
        mock_result = MagicMock()
        mock_result.returncode = 1  # pgrep found nothing
        mock_result.stdout = ""

        with patch("cc_bridge.commands.tunnel.subprocess.run", return_value=mock_result):
            # Should not raise error
            stop_tunnel()

    def test_stop_tunnel_error(self):
        """Should raise error on failure."""
        with (
            patch("cc_bridge.commands.tunnel.subprocess.run", side_effect=Exception("Kill failed")),
            pytest.raises(RuntimeError),
        ):
            stop_tunnel()


class TestSetWebhook:
    """Test webhook setting."""

    @pytest.mark.asyncio
    async def test_set_webhook_success(self):
        """Should set webhook successfully."""
        from cc_bridge.commands.tunnel import set_webhook

        mock_response = MagicMock()
        mock_response.json.return_value = {"ok": True}

        with patch("httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__.return_value.post = AsyncMock(
                return_value=mock_response
            )

            result = await set_webhook("https://test.trycloudflare.com", "test_token")

            assert result is True

    @pytest.mark.asyncio
    async def test_set_webhook_failure(self):
        """Should handle webhook setting failure."""
        from cc_bridge.commands.tunnel import set_webhook

        mock_response = MagicMock()
        mock_response.json.return_value = {"ok": False, "description": "Error"}

        with patch("httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__.return_value.post = AsyncMock(
                return_value=mock_response
            )

            result = await set_webhook("https://test.trycloudflare.com", "test_token")

            assert result is False
