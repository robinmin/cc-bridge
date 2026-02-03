"""
Utility functions for the webhook server.

This module provides functions for sanitizing text for Telegram and
cleaning Claude Code output.
"""

import html

__all__ = ["sanitize_for_telegram", "clean_claude_output"]


def sanitize_for_telegram(text: str, parse_mode: str = "HTML") -> str:
    """
    Sanitize text for safe Telegram message sending.

    Prevents HTML/Markdown injection by escaping special characters.

    Args:
        text: Raw text to sanitize
        parse_mode: "HTML" or "Markdown" (default: "HTML")

    Returns:
        Sanitized text safe for the specified parse mode
    """
    if not text:
        return ""

    if parse_mode == "HTML":
        # Escape HTML entities: <, >, &, ", '
        return html.escape(text)
    elif parse_mode == "Markdown":
        # Escape Markdown special characters
        # From: https://core.telegram.org/bots/api#markdownv2-style
        special_chars = [
            "_",
            "*",
            "[",
            "]",
            "(",
            ")",
            "~",
            "`",
            ">",
            "#",
            "+",
            "-",
            "=",
            "|",
            "{",
            "}",
            ".",
            "!",
        ]
        result = text
        for char in special_chars:
            # Escape with backslash, but don't double-escape
            result = result.replace(f"\\{char}", f"\\\\{char}")
            result = result.replace(char, f"\\{char}")
        return result
    else:
        # No parse mode or unknown mode - return as-is
        return text


def clean_claude_output(output: str) -> str:
    """
    Clean Claude Code output for sending to Telegram.

    Removes prompts, extra whitespace, and formatting artifacts.

    Args:
        output: Raw output from Claude Code session

    Returns:
        Cleaned output string
    """
    if not output:
        return ""

    lines = output.split("\n")

    # Remove common prompt patterns and artifacts
    cleaned = []
    for line in lines:
        stripped = line.strip()

        # Skip empty lines at the start
        if not cleaned and not stripped:
            continue

        # Skip prompt lines (various Claude Code prompt styles)
        # - Just a prompt: ">", "> ", "»"
        # - Path prompt: "~/project> ", "/path> "
        # - Multi-char prompt that's mostly special chars
        if stripped in ("❯", ">", "»") or (  # noqa: RUF001
            stripped.startswith(("❯", ">", "»"))  # noqa: RUF001
            and len(stripped) < 20
            and sum(c.isalnum() or c.isspace() for c in stripped) < 5
        ):
            continue

        # Skip separator lines (───────)
        if len(stripped) > 10 and all(c in "─═━─│┌┐└┘" for c in stripped):
            continue

        cleaned.append(line)

    result = "\n".join(cleaned).strip()

    # Limit excessive blank lines
    while "\n\n\n" in result:
        result = result.replace("\n\n\n", "\n\n")

    # Sanitize for Telegram HTML mode to prevent injection
    result = sanitize_for_telegram(result, parse_mode="HTML")

    return result
