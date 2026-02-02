"""
Tests for hook-stop command.
"""

import pytest

from cc_bridge.commands.hook_stop import main, send_to_telegram


def test_send_to_telegram_with_valid_transcript(sample_transcript):
    """Test sending transcript to Telegram."""
    # Should not raise exception
    send_to_telegram(str(sample_transcript))


def test_send_to_telegram_with_missing_transcript(tmp_path):
    """Test error handling for missing transcript."""
    missing_transcript = tmp_path / "missing.md"

    with pytest.raises(FileNotFoundError):
        send_to_telegram(str(missing_transcript))


def test_main_returns_zero_on_success(sample_transcript):
    """Test main returns exit code 0 on success."""
    exit_code = main(str(sample_transcript))
    assert exit_code == 0


def test_main_returns_one_on_error(tmp_path, capsys):
    """Test main returns exit code 1 on error."""
    missing_transcript = tmp_path / "missing.md"
    exit_code = main(str(missing_transcript))

    assert exit_code == 1
    captured = capsys.readouterr()
    assert "Error" in captured.err
