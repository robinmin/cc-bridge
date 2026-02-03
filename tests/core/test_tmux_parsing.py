import pytest
from unittest.mock import MagicMock, patch
from cc_bridge.core.tmux import TmuxSession


@pytest.mark.asyncio
@patch("cc_bridge.core.tmux.TmuxSession.session_exists", return_value=True)
@patch("cc_bridge.core.tmux.TmuxSession.send_command", return_value=True)
async def test_tmux_delta_extraction(mock_send, mock_exists):
    session = TmuxSession(session_name="test")

    # Simulate content BEFORE command
    before_content = "Previous conversation\n❯ "

    # Simulate content AFTER command
    # 1. Command echo
    # 2. Response
    # 3. New prompt
    after_content = (
        "Previous conversation\n"
        "❯ test-command\n"
        "This is the new response\n"
        "from Claude.\n"
        "❯ "
    )

    # Mock get_session_output to return before then after
    # Because send_command_and_wait polls, we need to ensure it sees the change
    # We use a list iterator but we need to handle if it's called more times
    # Actually, simpler: just return the iterator, but we might run out.
    # Better: A function that returns consistent values based on call count

    call_count = 0

    def side_effect():
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return before_content
        return after_content

    session.get_session_output = MagicMock(side_effect=side_effect)  # type: ignore

    # We need to patch asyncio.sleep to avoid waiting
    with patch("asyncio.sleep", return_value=None):
        success, result = await session.send_command_and_wait(
            "test-command", timeout=5.0
        )

    assert success is True
    assert result == "This is the new response\nfrom Claude."


@pytest.mark.asyncio
@patch("cc_bridge.core.tmux.TmuxSession.session_exists", return_value=True)
@patch("cc_bridge.core.tmux.TmuxSession.send_command", return_value=True)
async def test_tmux_delta_extraction_with_separators(mock_send, mock_exists):
    session = TmuxSession(session_name="test")

    before_content = "❯ "
    after_content = (
        "❯ complex-command\n"
        "─── Response ───\n"
        "Important Info\n"
        "━━━━━━━━━━━━━━━━\n"
        "❯ "
    )

    call_count = 0

    def side_effect():
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return before_content
        return after_content

    session.get_session_output = MagicMock(side_effect=side_effect)  # type: ignore

    with patch("asyncio.sleep", return_value=None):
        success, result = await session.send_command_and_wait(
            "complex-command", timeout=5.0
        )

    # Separator with text is now preserved, pure UI separator is filtered
    assert success is True
    assert result == "─── Response ───\nImportant Info"
