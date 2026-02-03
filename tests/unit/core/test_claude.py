"""
Tests for Claude Code integration.
"""

# ruff: noqa: PLC0415 (intentional lazy imports in tests)
import pytest

from cc_bridge.core.transcript import (
    ClaudeTranscript,
    clear_pending_flag,
    get_pending_flag_path,
    is_pending,
    set_pending_flag,
)


def test_transcript_read(sample_transcript):
    """Test reading transcript."""
    transcript = ClaudeTranscript(str(sample_transcript))
    content = transcript.read()
    assert "Hello, how are you?" in content


def test_transcript_get_last_response(sample_transcript):
    """Test extracting last response from transcript."""
    transcript = ClaudeTranscript(str(sample_transcript))
    response = transcript.get_last_response()
    assert len(response) > 0
    assert "I'm doing well" in response


def test_transcript_get_conversation_history(sample_transcript):
    """Test extracting conversation history."""
    transcript = ClaudeTranscript(str(sample_transcript))
    history = transcript.get_conversation_history()
    assert len(history) == 2
    assert history[0]["role"] == "user"
    assert history[1]["role"] == "assistant"


def test_transcript_missing_file():
    """Test error handling for missing transcript."""
    transcript = ClaudeTranscript("nonexistent.md")
    with pytest.raises(FileNotFoundError):
        transcript.read()


def test_pending_flag_path():
    """Test getting pending flag path."""
    path = get_pending_flag_path()
    assert path.name == "pending"


def test_set_and_clear_pending_flag(tmp_path):
    """Test setting and clearing pending flag."""
    # Override path for testing
    import cc_bridge.core.transcript as transcript_module

    original_path = transcript_module.get_pending_flag_path
    transcript_module.get_pending_flag_path = lambda: tmp_path / "pending"  # type: ignore[assignment]

    try:
        set_pending_flag()
        assert is_pending() is True

        clear_pending_flag()
        assert is_pending() is False
    finally:
        transcript_module.get_pending_flag_path = original_path
