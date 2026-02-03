"""
Claude Code integration for cc-bridge.

This module provides integration with Claude Code including
transcript parsing and response extraction.
"""

import re
from pathlib import Path


def parse_claude_transcript(transcript: str) -> str:
    """
    Parse Claude Code transcript to extract Claude's response.

    The transcript format typically has:
    1. User message/input at the start
    2. Claude's response (the main content we want)
    3. Possibly prompt artifacts at the end

    This function is used by the hook-stop command to extract
    Claude's response from the transcript file.

    Args:
        transcript: Full transcript content

    Returns:
        Extracted Claude response text

    Raises:
        ValueError: If transcript format is invalid
    """
    if not transcript:
        raise ValueError("Transcript is empty")

    lines = transcript.split("\n")

    # Find where Claude's response starts
    # Look for patterns that indicate the start of Claude's response
    response_start_idx = 0

    # Pattern 1: Look for Claude's role indicator (common in newer Claude Code)
    for i, line in enumerate(lines):
        if line.strip().startswith("Claude:") or line.strip().startswith("## Claude"):
            response_start_idx = i + 1
            break

    # Pattern 2: Look for the first non-empty line after user input markers
    if response_start_idx == 0:
        # Skip user input lines (often marked with >, User:, or just the prompt)
        for i, line in enumerate(lines):
            stripped = line.strip()
            # Skip prompt patterns and empty lines
            if not stripped:
                continue
            # Skip user input indicators
            if stripped.startswith((">", "User:", "You:", "Prompt:")):
                continue
            # Skip git-like prompts (~/path>)
            if re.match(r"^~/?.*>\s*$", stripped):
                continue
            # This should be the start of Claude's response
            response_start_idx = i
            break

    # Extract Claude's response
    response_lines = []
    for line in lines[response_start_idx:]:
        stripped = line.strip()

        # Stop at end markers
        if (stripped in ("", ">", "»") or stripped.startswith((">", "»"))) and (
            len(stripped) < 20 and sum(c.isalnum() for c in stripped) < 5
        ):
            break

        # Skip separator lines (───────)
        if len(stripped) > 10 and all(c in "─═━─│┌┐└┘" for c in stripped):
            continue

        response_lines.append(line)

    response = "\n".join(response_lines).strip()

    if not response:
        raise ValueError("Could not extract Claude response from transcript")

    # Clean up excessive blank lines
    while "\n\n\n" in response:
        response = response.replace("\n\n\n", "\n\n")

    return response


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
        content = self.read()
        lines = content.split("\n")

        messages = []
        current_role = None
        current_content = []

        for line in lines:
            if line.strip() in ["[user]", "[assistant]"]:
                if current_role and current_content:
                    messages.append(
                        {"role": current_role, "content": "\n".join(current_content)}
                    )
                current_role = line.strip().strip("[]")
                current_content = []
            else:
                current_content.append(line)

        if current_role and current_content:
            messages.append(
                {"role": current_role, "content": "\n".join(current_content)}
            )

        return messages


def get_pending_flag_path() -> Path:
    """
    Get path to pending flag file.

    The pending flag indicates that a message was initiated
    from Telegram and should be responded to.

    Returns:
        Path to pending flag file
    """
    return Path.home() / ".claude" / "bridge" / "pending"


def set_pending_flag() -> None:
    """
    Set pending flag to indicate Telegram-initiated message.
    """
    flag_path = get_pending_flag_path()
    flag_path.parent.mkdir(parents=True, exist_ok=True)
    flag_path.touch()


def clear_pending_flag() -> None:
    """
    Clear pending flag after responding to Telegram.
    """
    flag_path = get_pending_flag_path()
    if flag_path.exists():
        flag_path.unlink()


def is_pending() -> bool:
    """
    Check if there's a pending Telegram-initiated message.

    Returns:
        True if pending flag exists
    """
    return get_pending_flag_path().exists()


__all__ = [
    "ClaudeTranscript",
    "parse_claude_transcript",
    "get_pending_flag_path",
    "set_pending_flag",
    "clear_pending_flag",
    "is_pending",
]
