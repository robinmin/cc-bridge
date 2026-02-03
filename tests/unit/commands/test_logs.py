"""
Tests for logs command implementation.

Tests cover:
- LogFilter matching logic (level and pattern filtering)
- LogStreamer color formatting
- LogStreamer tail functionality
- stream_logs async function
- get_default_log_path configuration
"""

import re
from pathlib import Path
from unittest.mock import patch

import pytest

from cc_bridge.core.log_streamer import (
    DEFAULT_LOG_PATH,
    LogFilter,
    LogStreamer,
    get_default_log_path,
    stream_logs,
)


def strip_ansi(text: str) -> str:
    """Remove ANSI color codes from text."""
    ansi_escape = re.compile(r"\x1b\[[0-9;]*m")
    return ansi_escape.sub("", text)


class TestLogFilter:
    """Tests for LogFilter class."""

    def test_init_no_filters(self):
        """Test filter initialization without any filters."""
        filter_obj = LogFilter()
        assert filter_obj.level is None
        assert filter_obj.component is None
        assert filter_obj.pattern is None

    def test_init_with_level(self):
        """Test filter initialization with level."""
        filter_obj = LogFilter(level="ERROR")
        assert filter_obj.level == "ERROR"

    def test_init_with_pattern(self):
        """Test filter initialization with regex pattern."""
        filter_obj = LogFilter(pattern="webhook")
        assert filter_obj.pattern is not None

    def test_init_with_component(self):
        """Test filter initialization with component."""
        filter_obj = LogFilter(component="telegram")
        assert filter_obj.component == "telegram"

    def test_matches_no_filter(self):
        """Test that all lines match when no filter is set."""
        filter_obj = LogFilter()
        assert filter_obj.matches("Any log line")
        assert filter_obj.matches("Another line")

    def test_matches_level_error(self):
        """Test level filtering with ERROR level."""
        filter_obj = LogFilter(level="ERROR")
        assert filter_obj.matches("2024-01-01 ERROR: Something went wrong")
        assert filter_obj.matches("[ERROR] Critical failure")
        assert filter_obj.matches("ERROR - Database connection failed")

    def test_matches_level_below_threshold(self):
        """Test that lower level logs don't match ERROR filter."""
        filter_obj = LogFilter(level="ERROR")
        assert not filter_obj.matches("2024-01-01 INFO: Normal operation")
        assert not filter_obj.matches("[DEBUG] Detailed trace")
        assert not filter_obj.matches("WARNING - Minor issue")

    def test_matches_level_at_threshold(self):
        """Test that CRITICAL matches ERROR filter (higher priority)."""
        filter_obj = LogFilter(level="ERROR")
        assert filter_obj.matches("CRITICAL: System failure")

    def test_matches_pattern(self):
        """Test pattern filtering."""
        filter_obj = LogFilter(pattern="webhook")
        assert filter_obj.matches("Processing webhook update")
        assert filter_obj.matches("webhook delivery failed")
        assert not filter_obj.matches("Processing telegram update")

    def test_matches_pattern_regex(self):
        """Test pattern filtering with regex."""
        filter_obj = LogFilter(pattern=r"\d{3}")  # Match 3 digits
        assert filter_obj.matches("Status code: 404")
        assert filter_obj.matches("Error 500 occurred")
        assert not filter_obj.matches("Status code: OK")

    def test_matches_case_insensitive_level(self):
        """Test that level matching is case-insensitive."""
        filter_obj = LogFilter(level="error")
        assert filter_obj.matches("ERROR: Something")
        assert filter_obj.matches("error: Something")
        assert filter_obj.matches("Error: Something")

    def test_matches_level_priority_order(self):
        """Test level priority ordering."""
        filter_obj = LogFilter(level="WARNING")
        # WARNING should match WARNING, ERROR, CRITICAL
        assert filter_obj.matches("WARNING: Minor issue")
        assert filter_obj.matches("ERROR: Major issue")
        assert filter_obj.matches("CRITICAL: Critical issue")
        # But not DEBUG or INFO
        assert not filter_obj.matches("DEBUG: Trace")
        assert not filter_obj.matches("INFO: Normal")


class TestLogStreamer:
    """Tests for LogStreamer class."""

    def test_init(self, tmp_path: Path):
        """Test LogStreamer initialization."""
        log_file = tmp_path / "test.log"
        streamer = LogStreamer(log_file)
        assert streamer.log_file == log_file
        assert streamer.filter is None

    def test_init_with_filter(self, tmp_path: Path):
        """Test LogStreamer with filter."""
        log_file = tmp_path / "test.log"
        filter_obj = LogFilter(level="ERROR")
        streamer = LogStreamer(log_file, filter_obj)
        assert streamer.filter == filter_obj

    def test_init_expands_user(self, tmp_path: Path):
        """Test that ~ is expanded in log file path."""
        # Create a path with ~
        streamer = LogStreamer(Path("~/test.log"))
        # The path should be expanded (will be to actual home directory)
        assert str(streamer.log_file).startswith("/")

    def test_format_line_no_level(self):
        """Test formatting a line without log level."""
        streamer = LogStreamer(Path("/tmp/test.log"))
        result = streamer.format_line("Just a regular message")
        assert result == "Just a regular message"

    def test_format_line_empty_line(self):
        """Test formatting an empty line."""
        streamer = LogStreamer(Path("/tmp/test.log"))
        result = streamer.format_line("")
        assert result == ""

    def test_format_line_with_error_level(self):
        """Test formatting ERROR level log line."""
        streamer = LogStreamer(Path("/tmp/test.log"))
        result = streamer.format_line("ERROR: Something went wrong")
        # Should contain ANSI color codes
        assert "\033[31m" in result  # Red color for ERROR
        assert "\033[0m" in result  # Reset color
        assert "ERROR:" in result

    def test_format_line_with_info_level(self):
        """Test formatting INFO level log line."""
        streamer = LogStreamer(Path("/tmp/test.log"))
        result = streamer.format_line("INFO: Normal operation")
        assert "\033[32m" in result  # Green color for INFO
        assert "INFO:" in result

    def test_format_line_with_warning_level(self):
        """Test formatting WARNING level log line."""
        streamer = LogStreamer(Path("/tmp/test.log"))
        result = streamer.format_line("WARNING: Minor issue")
        assert "\033[33m" in result  # Yellow color for WARNING
        assert "WARNING:" in result

    def test_format_line_with_debug_level(self):
        """Test formatting DEBUG level log line."""
        streamer = LogStreamer(Path("/tmp/test.log"))
        result = streamer.format_line("DEBUG: Detailed trace")
        assert "\033[36m" in result  # Cyan color for DEBUG
        assert "DEBUG:" in result

    def test_format_line_with_critical_level(self):
        """Test formatting CRITICAL level log line."""
        streamer = LogStreamer(Path("/tmp/test.log"))
        result = streamer.format_line("CRITICAL: System failure")
        assert "\033[35m" in result  # Magenta color for CRITICAL
        assert "CRITICAL:" in result

    def test_format_line_bracketed_level(self):
        """Test formatting bracketed log level [ERROR]."""
        streamer = LogStreamer(Path("/tmp/test.log"))
        result = streamer.format_line("[ERROR] Something went wrong")
        assert "\033[31m" in result  # Red color
        assert "[ERROR]" in result

    def test_format_line_dash_level(self):
        """Test formatting dash-separated log level ERROR -."""
        streamer = LogStreamer(Path("/tmp/test.log"))
        result = streamer.format_line("ERROR - Something went wrong")
        assert "\033[31m" in result  # Red color
        assert "ERROR -" in result

    def test_format_line_json_level(self):
        """Test formatting JSON log level "ERROR"."""
        streamer = LogStreamer(Path("/tmp/test.log"))
        # JSON format requires the level to be at the start of the line with quotes
        result = streamer.format_line('"ERROR"')
        assert "\033[31m" in result  # Red color
        assert '"ERROR"' in result

    def test_tail_nonexistent_file(self, tmp_path: Path, capsys):
        """Test tailing a nonexistent file."""
        log_file = tmp_path / "nonexistent.log"
        streamer = LogStreamer(log_file)
        streamer.tail(lines=10)

        captured = capsys.readouterr()
        assert "Log file not found" in captured.out

    def test_tail_with_filter(self, tmp_path: Path, capsys):
        """Test tailing with log filter applied."""
        log_file = tmp_path / "test.log"
        log_file.write_text(
            "DEBUG: Trace line\n"
            "INFO: Normal line\n"
            "ERROR: Error line\n"
            "WARNING: Warning line\n"
            "CRITICAL: Critical line\n"
        )

        filter_obj = LogFilter(level="ERROR")
        streamer = LogStreamer(log_file, filter_obj)
        streamer.tail(lines=10)

        captured = capsys.readouterr()
        stripped_output = strip_ansi(captured.out)
        # Should only show ERROR and CRITICAL (higher priority)
        assert "DEBUG: Trace line" not in stripped_output
        assert "INFO: Normal line" not in stripped_output
        assert "WARNING: Warning line" not in stripped_output
        assert "ERROR: Error line" in stripped_output
        assert "CRITICAL: Critical line" in stripped_output

    def test_tail_lines_limit(self, tmp_path: Path, capsys):
        """Test tailing with limited lines."""
        log_file = tmp_path / "test.log"
        log_file.write_text("Line 1\n" "Line 2\n" "Line 3\n" "Line 4\n" "Line 5\n")

        streamer = LogStreamer(log_file)
        streamer.tail(lines=3)

        captured = capsys.readouterr()
        # Should only show last 3 lines
        assert "Line 1" not in captured.out
        assert "Line 2" not in captured.out
        assert "Line 3" in captured.out
        assert "Line 4" in captured.out
        assert "Line 5" in captured.out

    def test_tail_all_lines_when_less_than_requested(self, tmp_path: Path, capsys):
        """Test tailing when file has fewer lines than requested."""
        log_file = tmp_path / "test.log"
        log_file.write_text("Line 1\nLine 2\n")

        streamer = LogStreamer(log_file)
        streamer.tail(lines=10)

        captured = capsys.readouterr()
        # Should show all available lines
        assert "Line 1" in captured.out
        assert "Line 2" in captured.out


class TestStreamLogs:
    """Tests for stream_logs async function."""

    @pytest.mark.asyncio
    async def test_stream_logs_nonexistent_file(self, tmp_path: Path, capsys):
        """Test streaming logs when file doesn't exist."""
        log_file = tmp_path / "nonexistent.log"

        await stream_logs(str(log_file), follow=False, lines=10)

        captured = capsys.readouterr()
        assert "Log file not found" in captured.out

    @pytest.mark.asyncio
    async def test_stream_logs_creates_directory(self, tmp_path: Path, capsys):
        """Test that streaming creates log directory if it doesn't exist."""
        log_file = tmp_path / "logs" / "test.log"

        await stream_logs(str(log_file), follow=False, lines=0)

        captured = capsys.readouterr()
        assert "Log file not found" in captured.out
        assert "Creating log file directory" in captured.out
        # Directory should be created
        assert log_file.parent.exists()

    @pytest.mark.asyncio
    async def test_stream_logs_with_tail(self, tmp_path: Path, capsys):
        """Test streaming logs with tail (no follow)."""
        log_file = tmp_path / "test.log"
        log_file.write_text("Line 1\nLine 2\nLine 3\n")

        await stream_logs(str(log_file), follow=False, lines=2)

        captured = capsys.readouterr()
        # Should show last 2 lines
        assert "Line 2" in captured.out
        assert "Line 3" in captured.out

    @pytest.mark.asyncio
    async def test_stream_logs_with_filter(self, tmp_path: Path, capsys):
        """Test streaming logs with filter applied."""
        log_file = tmp_path / "test.log"
        log_file.write_text("DEBUG: Trace\n" "INFO: Normal\n" "ERROR: Error\n")

        log_filter = LogFilter(level="ERROR")
        await stream_logs(str(log_file), follow=False, lines=10, log_filter=log_filter)

        captured = capsys.readouterr()
        stripped_output = strip_ansi(captured.out)
        # Should only show ERROR
        assert "DEBUG: Trace" not in stripped_output
        assert "INFO: Normal" not in stripped_output
        assert "ERROR: Error" in stripped_output


class TestGetDefaultLogPath:
    """Tests for get_default_log_path function."""

    def test_get_default_log_path_from_config(self):
        """Test getting log path from configuration."""
        with patch("cc_bridge.core.log_streamer.get_config") as mock_config:
            mock_config.return_value.get.return_value = "/custom/path/bridge.log"
            result = get_default_log_path()
            assert result == "/custom/path/bridge.log"

    def test_get_default_log_path_fallback(self):
        """Test fallback to DEFAULT_LOG_PATH when config has no value."""
        with patch("cc_bridge.core.log_streamer.get_config") as mock_config:
            # Mock the config.get() to return None for "logging.file"
            # which should trigger the default value
            mock_config.return_value.get.side_effect = lambda key, default=None: (
                default if key == "logging.file" else None
            )
            result = get_default_log_path()
            assert result == DEFAULT_LOG_PATH

    def test_default_log_path_constant(self):
        """Test that DEFAULT_LOG_PATH is set correctly."""
        assert DEFAULT_LOG_PATH == "~/.claude/bridge/logs/bridge.log"
