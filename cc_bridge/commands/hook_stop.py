"""
Hook-stop command implementation.

This module implements the Python Stop hook that reads Claude's
transcript and sends the response back to Telegram.

This replaces the bash hook with a cross-platform, testable solution.
"""

import sys
from pathlib import Path


def send_to_telegram(transcript_path: str) -> None:
    """
    Read Claude transcript and send response to Telegram.

    Args:
        transcript_path: Path to Claude transcript file

    Raises:
        FileNotFoundError: If transcript file doesn't exist
        ValueError: If transcript format is invalid
    """
    # TODO: Implement transcript reading and Telegram sending (Task 0006)
    transcript = Path(transcript_path)

    if not transcript.exists():
        raise FileNotFoundError(f"Transcript not found: {transcript_path}")

    # Read transcript
    content = transcript.read_text()

    # TODO: Parse transcript to extract Claude's response
    # TODO: Send response to Telegram via httpx
    print(f"Transcript content length: {len(content)}")


def main(transcript_path: str) -> int:
    """
    Main entry point for hook-stop command.

    Args:
        transcript_path: Path to Claude transcript file

    Returns:
        Exit code (0 for success, 1 for error)
    """
    try:
        send_to_telegram(transcript_path)
        return 0
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
