"""
Tests for setup command.
"""

import pytest
from unittest.mock import MagicMock, patch, AsyncMock

from cc_bridge.commands.setup import run_setup_enhanced


@pytest.mark.asyncio
async def test_run_setup_enhanced():
    """Test enhanced setup wizard initialization."""
    # Mock user inputs and external services
    with patch("builtins.input", side_effect=["test_token", "y", "y"]):
        with patch("cc_bridge.commands.setup._fetch_chat_id", return_value=12345):
            with patch("cc_bridge.commands.tunnel.start_tunnel", return_value="https://test.trycloudflare.com"):
                with patch("cc_bridge.commands.setup._setup_webhook", new=AsyncMock(return_value=True)):
                    with patch("cc_bridge.commands.setup._setup_crontab", return_value=True):
                        with patch("cc_bridge.commands.setup._save_env_file"):
                            config = await run_setup_enhanced()
                            assert config is not None
