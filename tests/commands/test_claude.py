"""
Tests for claude command.
"""

from datetime import datetime
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from typer.testing import CliRunner

from cc_bridge.commands.claude import (
    _get_session_name,
    _validate_working_directory,
    app,
)


class TestValidateWorkingDirectory:
    """Test working directory validation."""

    def test_validate_existing_directory(self, tmp_path: Path):
        """Should accept existing directory."""
        is_valid, result = _validate_working_directory(str(tmp_path))
        assert is_valid is True
        assert result == str(tmp_path)

    def test_validate_creates_directory(self, tmp_path: Path):
        """Should create non-existent directory."""
        new_dir = tmp_path / "new_project"
        is_valid, result = _validate_working_directory(str(new_dir))

        assert is_valid is True
        assert result == str(new_dir.absolute())
        assert new_dir.exists()

    def test_validate_expands_tilde(self):
        """Should expand ~ to home directory."""
        is_valid, result = _validate_working_directory("~/test")
        assert is_valid is True
        assert "~" not in result

    def test_validate_rejects_file(self, tmp_path: Path):
        """Should reject path that is a file."""
        test_file = tmp_path / "test.txt"
        test_file.write_text("test")

        is_valid, result = _validate_working_directory(str(test_file))
        assert is_valid is False
        assert "not a directory" in result


class TestGetSessionName:
    """Test session name generation."""

    def test_session_name_format(self):
        """Should generate correct session name format."""
        assert _get_session_name("test") == "claude-test"
        assert _get_session_name("my-project") == "claude-my-project"
        assert _get_session_name("instance_1") == "claude-instance_1"


class TestClaudeCommand:
    """Test claude command integration."""

    @pytest.fixture
    def mock_instance_manager(self):
        """Mock instance manager."""
        with patch("cc_bridge.commands.claude.get_instance_manager") as mock:
            manager = MagicMock()
            mock.return_value = manager
            yield manager

    @pytest.fixture
    def mock_tmux_available(self):
        """Mock tmux availability check."""
        with patch("cc_bridge.commands.claude._is_tmux_available") as mock:
            mock.return_value = True
            yield mock

    def test_start_new_instance(self, mock_instance_manager, mock_tmux_available, tmp_path: Path):
        """Should start new instance successfully."""
        from typer.testing import CliRunner  # noqa: PLC0415

        runner = CliRunner()
        mock_instance_manager.get_instance.return_value = None
        mock_instance_manager.create_instance.return_value = MagicMock(
            name="test", tmux_session="claude-test", cwd=str(tmp_path)
        )

        # Mock subprocess calls
        with patch("cc_bridge.commands.claude.subprocess.run") as mock_run:
            # Mock tmux session creation
            mock_run.return_value = MagicMock(
                stdout="12345\n"  # PID
            )

            result = runner.invoke(app, ["start", "test", "--cwd", str(tmp_path)])

            assert result.exit_code == 0
            mock_instance_manager.create_instance.assert_called_once()

    def test_start_existing_instance_fails(self, mock_instance_manager, mock_tmux_available):
        """Should fail when instance already exists and is running."""

        runner = CliRunner()
        # Mock that a running instance with this name already exists
        existing_instance = MagicMock()
        existing_instance.name = "test"
        mock_instance_manager.get_instance.return_value = existing_instance
        # Mock get_instance_status to return "running"
        mock_instance_manager.get_instance_status.return_value = "running"

        result = runner.invoke(app, ["start", "test"])

        assert result.exit_code == 1
        assert "already running" in result.stdout

    def test_start_without_tmux_fails(self):
        """Should fail when tmux is not available."""

        runner = CliRunner()

        with patch("cc_bridge.commands.claude._is_tmux_available") as mock:
            mock.return_value = False
            result = runner.invoke(app, ["start", "test"])

            assert result.exit_code == 1
            assert "tmux is not installed" in result.stdout

    def test_list_no_instances(self, mock_instance_manager):
        """Should handle no instances gracefully."""

        runner = CliRunner()
        mock_instance_manager.list_instances.return_value = []

        result = runner.invoke(app, ["list"])

        assert result.exit_code == 0
        assert "No Claude instances found" in result.stdout

    def test_list_with_instances(self, mock_instance_manager):
        """Should list all instances."""

        runner = CliRunner()

        instance1 = MagicMock(
            name="test1",
            tmux_session="claude-test1",
            cwd="/home/user/project1",
            created_at=datetime.now(),
            last_activity=None,
        )
        instance2 = MagicMock(
            name="test2",
            tmux_session="claude-test2",
            cwd="/home/user/project2",
            created_at=datetime.now(),
            last_activity=datetime.now(),
        )

        mock_instance_manager.list_instances.return_value = [instance1, instance2]
        mock_instance_manager.get_instance_status.side_effect = ["running", "stopped"]

        result = runner.invoke(app, ["list"])

        assert result.exit_code == 0
        assert "test1" in result.stdout
        assert "test2" in result.stdout

    def test_stop_nonexistent_instance_fails(self, mock_instance_manager):
        """Should fail when stopping non-existent instance."""

        runner = CliRunner()
        mock_instance_manager.get_instance.return_value = None

        result = runner.invoke(app, ["stop", "nonexistent"])

        assert result.exit_code == 1
        assert "not found" in result.stdout

    def test_attach_nonexistent_instance_fails(self, mock_instance_manager):
        """Should fail when attaching to non-existent instance."""

        runner = CliRunner()
        mock_instance_manager.get_instance.return_value = None

        result = runner.invoke(app, ["attach", "nonexistent"])

        assert result.exit_code == 1
        assert "not found" in result.stdout
