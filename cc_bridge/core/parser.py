"""
Message formatting and parsing for cc-bridge.

This module provides message formatting for:
- HTML formatting
- Code block detection
- Message sanitization
"""

import re
from html import escape


class MessageFormatter:
    """
    Format messages for Telegram and Claude Code.

    Handles HTML formatting, code blocks, and message sanitization.
    """

    def __init__(self) -> None:
        """Initialize message formatter."""
        self.code_block_pattern = re.compile(r"```(\w*)\n(.*?)```", re.DOTALL)
        self.inline_code_pattern = re.compile(r"`(.*?)`")
        self.url_pattern = re.compile(r"(https?://\S+)")
        self.bold_pattern = re.compile(r"\*\*(.*?)\*\*")
        self.italic_pattern = re.compile(r"\*(.*?)\*")
        self.strike_pattern = re.compile(r"~~(.*?)~~")
        self.underline_pattern = re.compile(r"__(.*?)__")
        self.code_placeholder = "___CODE_BLOCK___"

    def format_for_telegram(self, text: str) -> str:
        """
        Format message for Telegram (HTML).

        Args:
            text: Raw message text

        Returns:
            Formatted message with HTML tags
        """
        # Escape HTML special characters first
        text = escape(text)

        # Preserve code blocks (use <pre> tags)
        text = self._preserve_code_blocks(text)

        # Format URLs as links
        text = self._format_urls(text)

        # Format bold (Telegram uses <b>)
        text = self._format_bold(text)

        # Format italic (Telegram uses <i>)
        text = self._format_italic(text)

        # Format strikethrough (Telegram uses <s>)
        text = self._format_strikethrough(text)

        # Format underline (Telegram uses <u>)
        text = self._format_underline(text)

        # Format inline code (Telegram uses <code>)
        text = self._format_inline_code(text)

        return text

    def format_for_claude(self, text: str) -> str:
        """
        Format message for Claude Code.

        Args:
            text: Telegram message text

        Returns:
            Formatted message for Claude
        """
        # Remove HTML tags (Telegram formatting)
        text = self._remove_html_tags(text)

        # Convert HTML entities back to characters
        text = self._decode_html_entities(text)

        # Preserve code blocks
        text = self._restore_code_blocks_from_html(text)

        return text

    def extract_code_blocks(self, text: str) -> tuple[list[tuple[str, str]], str]:
        """
        Extract code blocks from message.

        Args:
            text: Message text

        Returns:
            Tuple of (code_blocks, text_without_code)
        """
        code_blocks: list[tuple[str, str]] = []
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
        # Remove null bytes
        text = text.replace("\x00", "")

        # Normalize whitespace (replace multiple spaces/newlines with single)
        text = re.sub(r"\s+", " ", text)

        # Remove control characters except newlines and tabs
        text = "".join(c for c in text if c in {"\n", "\t"} or not ord(c) < 32)

        # Trim leading/trailing whitespace
        text = text.strip()

        # Limit length (Telegram max is 4096)
        if len(text) > 4000:
            text = text[:4000] + "..."

        return text

    def _preserve_code_blocks(self, text: str) -> str:
        """
        Preserve code blocks during HTML formatting.

        Args:
            text: Message text

        Returns:
            Text with preserved code blocks
        """

        # Find all code blocks and replace with placeholders
        def replace_block(match: re.Match[str]) -> str:
            lang = match.group(1) or ""
            code = match.group(2)
            # Escape HTML in code but preserve structure
            escaped_code = escape(code)
            return f'<pre><code class="language-{lang}">{escaped_code}</code></pre>'

        return self.code_block_pattern.sub(replace_block, text)

    def _format_urls(self, text: str) -> str:
        """
        Format URLs as HTML links.

        Args:
            text: Message text

        Returns:
            Text with formatted URLs
        """

        def replace_url(match: re.Match[str]) -> str:
            url = match.group(1)
            return f'<a href="{url}">{url}</a>'

        return self.url_pattern.sub(replace_url, text)

    def _format_bold(self, text: str) -> str:
        """
        Format bold text with HTML.

        Args:
            text: Message text

        Returns:
            Text with bold formatting
        """

        # Only apply to text not already in HTML tags
        def replace_bold(match: re.Match[str]) -> str:
            content = match.group(1)
            # Don't format if already in HTML tag
            if "<" in content or ">" in content:
                return match.group(0)
            return f"<b>{content}</b>"

        return self.bold_pattern.sub(replace_bold, text)

    def _format_italic(self, text: str) -> str:
        """
        Format italic text with HTML.

        Args:
            text: Message text

        Returns:
            Text with italic formatting
        """

        def replace_italic(match: re.Match[str]) -> str:
            content = match.group(1)
            # Don't format if already in HTML tag
            if "<" in content or ">" in content:
                return match.group(0)
            return f"<i>{content}</i>"

        return self.italic_pattern.sub(replace_italic, text)

    def _format_strikethrough(self, text: str) -> str:
        """
        Format strikethrough text with HTML.

        Args:
            text: Message text

        Returns:
            Text with strikethrough formatting
        """

        def replace_strike(match: re.Match[str]) -> str:
            content = match.group(1)
            return f"<s>{content}</s>"

        return self.strike_pattern.sub(replace_strike, text)

    def _format_underline(self, text: str) -> str:
        """
        Format underline text with HTML.

        Args:
            text: Message text

        Returns:
            Text with underline formatting
        """

        def replace_underline(match: re.Match[str]) -> str:
            content = match.group(1)
            return f"<u>{content}</u>"

        return self.underline_pattern.sub(replace_underline, text)

    def _format_inline_code(self, text: str) -> str:
        """
        Format inline code with HTML.

        Args:
            text: Message text

        Returns:
            Text with inline code formatting
        """

        def replace_inline(match: re.Match[str]) -> str:
            code = match.group(1)
            return f"<code>{code}</code>"

        return self.inline_code_pattern.sub(replace_inline, text)

    def _remove_html_tags(self, text: str) -> str:
        """
        Remove HTML tags from text.

        Args:
            text: Message text with HTML

        Returns:
            Plain text
        """
        # Preserve code blocks first
        code_blocks: list[tuple[str, str]] = []
        placeholder = "___CODE_BLOCK{}___"

        def save_code_blocks(match: re.Match[str]) -> str:
            lang = match.group(1) or ""
            code = match.group(2)
            idx = len(code_blocks)
            code_blocks.append((lang, code))
            return placeholder.format(idx)

        # Save pre blocks
        pre_pattern = re.compile(r'<pre><code class="language-([^"]*)">([^<]*)</code></pre>')
        text = pre_pattern.sub(save_code_blocks, text)

        # Remove all other HTML tags
        text = re.sub(r"<[^>]+>", "", text)

        # Restore code blocks
        for idx, (lang, code) in enumerate(code_blocks):
            text = text.replace(placeholder.format(idx), f"```{lang}\n{code}\n```")

        return text

    def _decode_html_entities(self, text: str) -> str:
        """
        Decode HTML entities.

        Args:
            text: Text with HTML entities

        Returns:
            Text with decoded entities
        """
        # Common HTML entities
        entities = {
            "&amp;": "&",
            "&lt;": "<",
            "&gt;": ">",
            "&quot;": '"',
            "&apos;": "'",
            "&nbsp;": " ",
        }

        for entity, char in entities.items():
            text = text.replace(entity, char)

        return text

    def _restore_code_blocks_from_html(self, text: str) -> str:
        """
        Restore code blocks from HTML <pre> tags.

        Args:
            text: Text with HTML code blocks

        Returns:
            Text with markdown code blocks
        """

        # Convert <pre><code> to markdown code blocks
        def convert_pre_block(match: re.Match[str]) -> str:
            code = match.group(2)
            # Decode HTML entities in code
            code = self._decode_html_entities(code)
            return f"```\n{code}\n```"

        pre_pattern = re.compile(r'<pre><code class="language-([^"]*)">([^<]*)</code></pre>')
        return pre_pattern.sub(convert_pre_block, text)
