"""
Tests for config command.
"""

from pathlib import Path
from unittest.mock import MagicMock, patch

from cc_bridge.commands.config import delete_value, set_value


def test_get_value(test_config):
    """Test getting configuration value."""
    value = test_config.get("telegram.bot_token")
    assert value == "test_bot_token"


def test_set_value(test_config_dir: Path) -> None:
    """Test setting configuration value."""
    # We need to test that set_value creates a Config and calls set/save
    # Since Config() uses default path, we mock Config to verify behavior
    with patch("cc_bridge.commands.config.Config") as mock_config_class:
        mock_config = MagicMock()
        mock_config_class.return_value = mock_config

        set_value("test.key", "test_value")

        # Verify Config was instantiated
        mock_config_class.assert_called_once()
        # Verify set was called
        mock_config.set.assert_called_once_with("test.key", "test_value")
        # Verify save was called
        mock_config.save.assert_called_once()


def test_delete_value(test_config_dir: Path) -> None:
    """Test deleting configuration value."""
    # Similar approach - mock Config to verify behavior
    with patch("cc_bridge.commands.config.Config") as mock_config_class:
        mock_config = MagicMock()
        mock_config_class.return_value = mock_config

        delete_value("test.key")

        # Verify Config was instantiated
        mock_config_class.assert_called_once()
        # Verify delete was called
        mock_config.delete.assert_called_once_with("test.key")
        # Verify save was called
        mock_config.save.assert_called_once()
