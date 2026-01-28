"""
Message formatting and parsing for cc-bridge.

This module provides message formatting for:
- HTML formatting
- Code block detection
- Message sanitization
"""

import re


class MessageFormatter:
    """
    Format messages for Telegram and Claude Code.

    Handles HTML formatting, code blocks, and message sanitization.
    """

    def __init__(self):
        """Initialize message formatter."""
        self.code_block_pattern = re.compile(r"```(\w+)?\n(.*?)```", re.DOTALL)
        self.inline_code_pattern = re.compile(r"`(.*?)`")

    def format_for_telegram(self, text: str) -> str:
        """
        Format message for Telegram (HTML).

        Args:
            text: Raw message text

        Returns:
            Formatted message with HTML tags
        """
        # TODO: Implement Telegram formatting (Task 0004)
        # Escape HTML special characters
        text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

        # Preserve code blocks
        text = self._preserve_code_blocks(text)

        # Format bold, italic, etc.
        # Add HTML formatting as needed

        return text

    def format_for_claude(self, text: str) -> str:
        """
        Format message for Claude Code.

        Args:
            text: Telegram message text

        Returns:
            Formatted message for Claude
        """
        # TODO: Implement Claude formatting (Task 0004)
        # Remove Telegram-specific formatting
        # Convert to plain text or Markdown

        return text

    def extract_code_blocks(self, text: str) -> tuple[list[str], str]:
        """
        Extract code blocks from message.

        Args:
            text: Message text

        Returns:
            Tuple of (code_blocks, text_without_code)
        """
        # TODO: Implement code block extraction (Task 0004)
        code_blocks = []
        matches = self.code_block_pattern.findall(text)

        for lang, code in matches:
            code_blocks.append((lang or "", code))

        # Remove code blocks from text
        text_without_code = self.code_block_pattern.sub("", text)

        return code_blocks, text_without_code

    def sanitize_message(self, text: str) -> str:
        """
        Sanitize message for safe processing.

        Args:
            text: Raw message text

        Returns:
            Sanitized message
        """
        # TODO: Implement message sanitization (Task 0004)
        # Remove potentially harmful content
        # Limit length
        # Normalize whitespace

        # Remove null bytes
        text = text.replace("\x00", "")

        # Limit length (Telegram max is 4096)
        if len(text) > 4000:
            text = text[:4000] + "..."

        return text.strip()

    def _preserve_code_blocks(self, text: str) -> str:
        """
        Preserve code blocks during HTML formatting.

        Args:
            text: Message text

        Returns:
            Text with preserved code blocks
        """
        # TODO: Implement code block preservation (Task 0004)
        # Wrap code blocks in <pre> tags
        # Handle inline code

        return text
