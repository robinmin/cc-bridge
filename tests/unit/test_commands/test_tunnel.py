"""
Tests for tunnel command.
"""

from unittest.mock import MagicMock, patch

import pytest

from cc_bridge.commands.tunnel import start_tunnel, stop_tunnel


class TestStartTunnel:
    """Tests for start_tunnel function."""

    @patch("cc_bridge.commands.tunnel.subprocess.Popen")
    @patch("cc_bridge.commands.tunnel.time")
    def test_start_tunnel_success(self, mock_time: MagicMock, mock_popen: MagicMock) -> None:
        """Test successful tunnel start."""
        # Mock time progression
        mock_time.time.side_effect = [0, 0.5]

        # Mock subprocess with cloudflared output
        mock_process = MagicMock()
        mock_process.stdout.readline.return_value = "https://abc123.trycloudflare.com\n"
        mock_process.poll.return_value = None  # Process still running
        mock_popen.return_value = mock_process

        url = start_tunnel(port=8080)

        assert url == "https://abc123.trycloudflare.com"
        # Verify Popen was called with correct arguments
        mock_popen.assert_called_once()
        call_args = mock_popen.call_args
        assert call_args[0][0] == ["cloudflared", "tunnel", "--url", "http://localhost:8080"]
        assert call_args[1]["text"] is True

    @patch("cc_bridge.commands.tunnel.subprocess.Popen")
    def test_start_tunnel_timeout(self, mock_popen: MagicMock) -> None:
        """Test tunnel start timeout."""
        # Mock subprocess that never produces URL
        mock_process = MagicMock()
        mock_process.stdout.readline.return_value = ""
        mock_process.poll.return_value = None
        mock_popen.return_value = mock_process

        with pytest.raises(RuntimeError, match="Timeout waiting for tunnel URL"):
            start_tunnel(port=8080, timeout=1)  # Use int for timeout

    @patch("cc_bridge.commands.tunnel.subprocess.Popen")
    def test_start_tunnel_cloudflared_not_found(self, mock_popen: MagicMock) -> None:
        """Test cloudflared not installed."""
        mock_popen.side_effect = FileNotFoundError()

        with pytest.raises(RuntimeError, match="cloudflared not found"):
            start_tunnel(port=8080)


class TestStopTunnel:
    """Tests for stop_tunnel function."""

    @patch("cc_bridge.commands.tunnel.subprocess.run")
    def test_stop_tunnel_success(self, mock_run: MagicMock) -> None:
        """Test successful tunnel stop."""
        # Mock pgrep finding cloudflared processes
        mock_run.return_value.returncode = 0
        mock_run.return_value.stdout = "12345\n67890\n"

        # Should not raise any exception
        stop_tunnel()

        # Verify pgrep was called
        assert mock_run.called
        call_args = list(mock_run.call_args_list)
        assert any("pgrep" in str(call) for call in call_args)

    @patch("cc_bridge.commands.tunnel.subprocess.run")
    def test_stop_tunnel_no_processes(self, mock_run: MagicMock) -> None:
        """Test stopping tunnel when no processes running."""
        # Mock pgrep finding no processes
        mock_run.return_value.returncode = 1
        mock_run.return_value.stdout = ""

        # Should not raise any exception
        stop_tunnel()
