"""
Tests for health command.
"""

import pytest

from cc_bridge.commands.health import check_tmux, run_all_checks


@pytest.mark.asyncio
async def test_run_all_checks():
    """Test running all health checks."""
    result = await run_all_checks()

    assert "status" in result
    assert "checks" in result
    assert "telegram" in result["checks"]
    assert "tmux" in result["checks"]
    assert "hook" in result["checks"]


def test_check_tmux_with_valid_session():
    """Test tmux health check with valid session."""
    result = check_tmux("test_claude")

    assert "status" in result
    # Status will be "unknown" until implemented


def test_check_tmux_with_missing_session():
    """Test tmux health check with missing session."""
    result = check_tmux("nonexistent_session")

    assert "status" in result
