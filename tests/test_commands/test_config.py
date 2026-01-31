"""
Tests for config command.
"""

import pytest

from cc_bridge.commands.config import delete_value, set_value


def test_get_value(test_config):
    """Test getting configuration value."""
    value = test_config.get("telegram.bot_token")
    assert value == "test_bot_token"


@pytest.mark.skip(
    reason="Config command tests not fully implemented - see docs/prompts/0009_config.md"
)
def test_set_value(test_config_dir):
    """Test setting configuration value."""
    # TODO: Implement config command tests (Task 0009)
    set_value("test_key", "test_value")
    # Verify value was set


@pytest.mark.skip(
    reason="Config command tests not fully implemented - see docs/prompts/0009_config.md"
)
def test_delete_value(test_config_dir):
    """Test deleting configuration value."""
    # TODO: Implement config command tests (Task 0009)
    # Set a value first, then delete it
    delete_value("test_key")
