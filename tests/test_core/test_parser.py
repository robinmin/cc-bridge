"""
Tests for message formatter.
"""

from cc_bridge.core.parser import MessageFormatter


def test_formatter_initialization():
    """Test message formatter initialization."""
    formatter = MessageFormatter()
    assert formatter is not None


def test_sanitize_message():
    """Test message sanitization."""
    formatter = MessageFormatter()
    text = "Test message with null\x00 byte"
    sanitized = formatter.sanitize_message(text)
    assert "\x00" not in sanitized


def test_sanitize_long_message():
    """Test sanitization limits message length."""
    formatter = MessageFormatter()
    long_text = "a" * 5000
    sanitized = formatter.sanitize_message(long_text)
    assert len(sanitized) <= 4000 + len("...")


def test_extract_code_blocks():
    """Test extracting code blocks from message."""
    formatter = MessageFormatter()
    text = "Here's some code:\n```python\nprint('hello')\n```\nAnd some text"
    code_blocks, _remaining = formatter.extract_code_blocks(text)

    assert len(code_blocks) == 1
    assert code_blocks[0][0] == "python"
    assert "print('hello')" in code_blocks[0][1]


def test_extract_multiple_code_blocks():
    """Test extracting multiple code blocks."""
    formatter = MessageFormatter()
    text = "```python\na = 1\n```\nText\n```javascript\nb = 2\n```"
    code_blocks, _remaining = formatter.extract_code_blocks(text)

    assert len(code_blocks) == 2
    assert code_blocks[0][0] == "python"
    assert code_blocks[1][0] == "javascript"
