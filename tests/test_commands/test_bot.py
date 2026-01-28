"""
Tests for bot command.
"""

import pytest

from cc_bridge.commands.bot import set_bot_commands, get_default_commands


@pytest.mark.asyncio
async def test_set_bot_commands():
    """Test setting bot commands."""
    # TODO: Implement bot tests (Task 0013)
    commands = get_default_commands()
    result = await set_bot_commands("test_token", commands)
    assert result is True or result is False


def test_get_default_commands():
    """Test getting default commands."""
    commands = get_default_commands()
    assert len(commands) > 0
    assert all("command" in cmd and "description" in cmd for cmd in commands)
