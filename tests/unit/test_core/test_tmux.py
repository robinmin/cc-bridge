"""
Tests for tmux session manager.
"""

from cc_bridge.core.tmux import TmuxSession


def test_session_initialization():
    """Test tmux session initialization."""
    session = TmuxSession("test_session")
    assert session.session_name == "test_session"


def test_session_exists(mock_tmux_session):
    """Test checking if session exists."""
    result = mock_tmux_session.session_exists()
    assert result is True
    mock_tmux_session.session_exists.assert_called_once()


def test_send_keys(mock_tmux_session):
    """Test sending keys to session."""
    mock_tmux_session.send_keys("test command")
    mock_tmux_session.send_keys.assert_called_once_with("test command")


def test_send_command(mock_tmux_session):
    """Test sending command to session."""
    mock_tmux_session.send_command("test command")
    # send_command calls send_keys once with enter=True
    mock_tmux_session.send_keys.assert_called_once_with("test command", enter=True)


def test_get_session_output(mock_tmux_session):
    """Test getting session output."""
    output = mock_tmux_session.get_session_output()
    assert output == "Test output"
    mock_tmux_session.get_session_output.assert_called_once()
