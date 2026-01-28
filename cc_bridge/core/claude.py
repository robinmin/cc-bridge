"""
Claude Code integration for cc-bridge.

This module provides integration with Claude Code including
transcript parsing and response extraction.
"""

from pathlib import Path


class ClaudeTranscript:
    """
    Claude Code transcript parser.

    Parses Claude transcript files to extract messages and responses.
    """

    def __init__(self, transcript_path: str):
        """
        Initialize transcript parser.

        Args:
            transcript_path: Path to transcript file
        """
        self.transcript_path = Path(transcript_path)

    def read(self) -> str:
        """
        Read transcript file.

        Returns:
            Transcript content

        Raises:
            FileNotFoundError: If transcript doesn't exist
        """
        # TODO: Implement transcript reading (Task 0004)
        if not self.transcript_path.exists():
            raise FileNotFoundError(f"Transcript not found: {self.transcript_path}")

        return self.transcript_path.read_text()

    def get_last_response(self) -> str:
        """
        Extract Claude's last response from transcript.

        Returns:
            Last response text

        Raises:
            ValueError: If transcript format is invalid
        """
        # TODO: Implement response extraction (Task 0004)
        content = self.read()

        # Parse transcript to find last assistant message
        # Transcript format: [user]\n...\n[assistant]\n...\n
        lines = content.split("\n")

        # Find last [assistant] section
        last_assistant_idx = -1
        for i, line in enumerate(lines):
            if line.strip() == "[assistant]":
                last_assistant_idx = i

        if last_assistant_idx == -1:
            return ""

        # Extract text after [assistant]
        response_lines = []
        for line in lines[last_assistant_idx + 1 :]:
            if line.startswith("["):
                break
            response_lines.append(line)

        return "\n".join(response_lines).strip()

    def get_conversation_history(self) -> list[dict]:
        """
        Extract conversation history from transcript.

        Returns:
            List of message dictionaries with 'role' and 'content'
        """
        # TODO: Implement conversation history extraction (Task 0004)
        content = self.read()
        lines = content.split("\n")

        messages = []
        current_role = None
        current_content = []

        for line in lines:
            if line.strip() in ["[user]", "[assistant]"]:
                if current_role and current_content:
                    messages.append({"role": current_role, "content": "\n".join(current_content)})
                current_role = line.strip().strip("[]")
                current_content = []
            else:
                current_content.append(line)

        if current_role and current_content:
            messages.append({"role": current_role, "content": "\n".join(current_content)})

        return messages


def get_pending_flag_path() -> Path:
    """
    Get path to pending flag file.

    The pending flag indicates that a message was initiated
    from Telegram and should be responded to.

    Returns:
        Path to pending flag file
    """
    # TODO: Implement pending flag path (Task 0004)
    return Path.home() / ".claude" / "bridge" / "pending"


def set_pending_flag() -> None:
    """
    Set pending flag to indicate Telegram-initiated message.
    """
    # TODO: Implement pending flag setting (Task 0004)
    flag_path = get_pending_flag_path()
    flag_path.parent.mkdir(parents=True, exist_ok=True)
    flag_path.touch()


def clear_pending_flag() -> None:
    """
    Clear pending flag after responding to Telegram.
    """
    # TODO: Implement pending flag clearing (Task 0004)
    flag_path = get_pending_flag_path()
    if flag_path.exists():
        flag_path.unlink()


def is_pending() -> bool:
    """
    Check if there's a pending Telegram-initiated message.

    Returns:
        True if pending flag exists
    """
    # TODO: Implement pending flag check (Task 0004)
    return get_pending_flag_path().exists()
