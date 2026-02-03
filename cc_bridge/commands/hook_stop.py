"""
Hook-stop command implementation.

This module implements the Python Stop hook that reads Claude's
transcript and sends the response back to Telegram.

This replaces the bash hook with a cross-platform, testable solution.
"""

import asyncio
import sys
from pathlib import Path

from cc_bridge.config import get_config
from cc_bridge.constants import (
    TELEGRAM_MAX_MESSAGE_LENGTH,
    TELEGRAM_TRUNCATED_MESSAGE_SUFFIX,
)
from cc_bridge.core.telegram import TelegramClient
from cc_bridge.core.transcript import parse_claude_transcript
from cc_bridge.packages.logging import get_logger

__all__ = ["main", "send_to_telegram"]

logger = get_logger(__name__)


async def send_to_telegram_async(transcript_path: str) -> None:
    """
    Read Claude transcript and send response to Telegram (async version).

    Args:
        transcript_path: Path to Claude transcript file

    Raises:
        FileNotFoundError: If transcript file doesn't exist
        ValueError: If transcript format is invalid or chat_id not configured
    """
    transcript = Path(transcript_path)

    if not transcript.exists():
        raise FileNotFoundError(f"Transcript not found: {transcript_path}")

    # Read transcript
    content = transcript.read_text()

    # Parse transcript to extract Claude's response
    response = parse_claude_transcript(content)

    logger.info("Extracted Claude response", length=len(response))

    # Get configuration
    config = get_config()
    bot_token = config.get("telegram.bot_token")
    chat_id = config.get("telegram.chat_id")

    if not bot_token:
        raise ValueError("telegram.bot_token not configured")

    if not chat_id:
        raise ValueError("telegram.chat_id not configured")

    # Truncate response if needed
    if len(response) > TELEGRAM_MAX_MESSAGE_LENGTH:
        logger.warning(
            "Response too long, truncating",
            original_length=len(response),
            max_length=TELEGRAM_MAX_MESSAGE_LENGTH,
        )
        response = (
            response[
                : TELEGRAM_MAX_MESSAGE_LENGTH - len(TELEGRAM_TRUNCATED_MESSAGE_SUFFIX)
            ]
            + TELEGRAM_TRUNCATED_MESSAGE_SUFFIX
        )

    # Send to Telegram
    client = TelegramClient(bot_token)
    success = await client.send_message(int(chat_id), response)

    if not success:
        raise RuntimeError("Failed to send message to Telegram")

    logger.info("Response sent to Telegram successfully")


def send_to_telegram(transcript_path: str) -> None:
    """
    Read Claude transcript and send response to Telegram.

    This is a synchronous wrapper around the async implementation.

    Args:
        transcript_path: Path to Claude transcript file

    Raises:
        FileNotFoundError: If transcript file doesn't exist
        ValueError: If transcript format is invalid or chat_id not configured
    """
    asyncio.run(send_to_telegram_async(transcript_path))


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
    except FileNotFoundError as e:
        logger.error("Transcript file not found", error=str(e))
        print(f"Error: {e}", file=sys.stderr)
        return 1
    except ValueError as e:
        logger.error("Invalid transcript or configuration", error=str(e))
        print(f"Error: {e}", file=sys.stderr)
        return 1
    except RuntimeError as e:
        logger.error("Failed to send to Telegram", error=str(e))
        print(f"Error: {e}", file=sys.stderr)
        return 1
    except Exception as e:
        logger.error("Unexpected error in hook-stop", error=str(e), exc_info=True)
        print(f"Error: {e}", file=sys.stderr)
        return 1
