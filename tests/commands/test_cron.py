"""
Tests for crontab management.
"""

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from cc_bridge.commands.cron import CrontabManager


class TestCrontabManager:
    """Test CrontabManager class."""

    @pytest.fixture
    def crontab_manager(self):
        """Create crontab manager for testing."""
        return CrontabManager()

    @pytest.fixture
    def mock_subprocess_run(self):
        """Mock subprocess.run."""
        with patch("subprocess.run") as mock:
            yield mock

    def test_validate_entry_valid(self, crontab_manager):
        """Should validate correct crontab entry."""
        assert crontab_manager._validate_entry("0 * * * * command") is True
        assert crontab_manager._validate_entry("*/5 * * * * command") is True
        assert crontab_manager._validate_entry("0 0 * * * command") is True

    def test_validate_entry_invalid(self, crontab_manager):
        """Should reject invalid crontab entries."""
        assert crontab_manager._validate_entry("invalid") is False
        assert crontab_manager._validate_entry("0 * * *") is False  # Missing command
        assert crontab_manager._validate_entry("* * * * *") is False  # Missing command

    def test_get_current_crontab(self, crontab_manager, mock_subprocess_run):
        """Should retrieve current crontab."""
        mock_subprocess_run.return_value = MagicMock(
            stdout="0 * * * * job1\n*/5 * * * * job2",
            returncode=0
        )

        lines = crontab_manager._get_current_crontab()

        assert len(lines) == 2
        assert lines[0] == "0 * * * * job1"
        assert lines[1] == "*/5 * * * * job2"

    def test_get_current_crontab_empty(self, crontab_manager, mock_subprocess_run):
        """Should handle empty crontab."""
        mock_subprocess_run.return_value = MagicMock(
            stdout="",
            returncode=0
        )

        lines = crontab_manager._get_current_crontab()

        assert lines == []

    def test_get_current_crontab_error(self, crontab_manager):
        """Should handle crontab read error."""
        with patch("subprocess.run") as mock_run:
            mock_run.side_effect = FileNotFoundError("crontab not found")

            lines = crontab_manager._get_current_crontab()

            assert lines == []

    def test_backup_crontab(self, crontab_manager, mock_subprocess_run, tmp_path: Path):
        """Should backup crontab to file."""
        mock_subprocess_run.return_value = MagicMock(
            stdout="0 * * * * job1",
            returncode=0
        )

        with patch("pathlib.Path.home", return_value=tmp_path):
            lines = crontab_manager._backup_crontab()

            backup_file = tmp_path / ".claude" / "bridge" / "crontab.backup"
            assert backup_file.exists()
            assert backup_file.read_text() == "0 * * * * job1"
            assert lines == ["0 * * * * job1"]

    def test_add_entry_success(self, crontab_manager, mock_subprocess_run, tmp_path: Path):
        """Should add entry to crontab."""
        mock_subprocess_run.return_value = MagicMock(returncode=0)

        with patch("pathlib.Path.home", return_value=tmp_path):
            result = crontab_manager.add_entry("0 * * * * test-command")

            assert result is True
            # Verify crontab - was called
            mock_subprocess_run.assert_called()

    def test_add_entry_invalid_fails(self, crontab_manager):
        """Should reject invalid entry."""
        result = crontab_manager.add_entry("invalid-entry", validate=True)
        assert result is False

    def test_add_entry_skip_validation(self, crontab_manager, mock_subprocess_run):
        """Should add entry without validation if requested."""
        mock_subprocess_run.return_value = MagicMock(returncode=0)

        with patch("pathlib.Path.home"):
            result = crontab_manager.add_entry("custom-entry", validate=False)
            assert result is True

    def test_remove_entry_success(self, crontab_manager, mock_subprocess_run):
        """Should remove CC-BRIDGE entries from crontab."""
        mock_subprocess_run.return_value = MagicMock(
            stdout=f"""# Other entry
{CrontabManager.CC_BRIDGE_MARKER}
*/5 * * * * health-check
{CrontabManager.CC_BRIDGE_MARKER_END}
# Another entry
""",
            returncode=0
        )

        crontab_manager.remove_entry()

        # Verify new crontab was written
        mock_subprocess_run.assert_called()

    def test_has_entries_true(self, crontab_manager, mock_subprocess_run):
        """Should detect CC-BRIDGE entries."""
        mock_subprocess_run.return_value = MagicMock(
            stdout=f"{CrontabManager.CC_BRIDGE_MARKER}\n*/5 * * * * test",
            returncode=0
        )

        assert crontab_manager.has_entries() is True

    def test_has_entries_false(self, crontab_manager, mock_subprocess_run):
        """Should return False when no CC-BRIDGE entries."""
        mock_subprocess_run.return_value = MagicMock(
            stdout="# Other crontab entry",
            returncode=0
        )

        assert crontab_manager.has_entries() is False

    def test_restore_backup_success(self, crontab_manager, mock_subprocess_run, tmp_path: Path):
        """Should restore crontab from backup."""
        backup_content = "0 * * * * restored-entry\n*/5 * * * * another-entry"

        with patch("pathlib.Path.home", return_value=tmp_path):
            # Create backup file
            backup_file = tmp_path / ".claude" / "bridge" / "crontab.backup"
            backup_file.parent.mkdir(parents=True, exist_ok=True)
            backup_file.write_text(backup_content)

            result = crontab_manager.restore_backup()

            assert result is True
            # Verify crontab was restored
            mock_subprocess_run.assert_called()

    def test_restore_backup_no_file(self, crontab_manager, tmp_path: Path):
        """Should handle missing backup file."""
        with patch("pathlib.Path.home", return_value=tmp_path):
            result = crontab_manager.restore_backup()
            assert result is False
