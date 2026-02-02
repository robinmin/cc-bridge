"""
Tests for validation utilities.
"""

from pathlib import Path

import pytest

from cc_bridge.core.validation import (
    RESERVED_NAMES,
    get_safe_instance_path,
    safe_tmux_session_name,
    sanitize_docker_label,
    validate_instance_name,
)


class TestReservedNames:
    """Tests for RESERVED_NAMES constant."""

    def test_reserved_names_exist(self):
        """Test that RESERVED_NAMES is defined."""
        assert isinstance(RESERVED_NAMES, set)
        assert len(RESERVED_NAMES) > 0

    def test_common_reserved_names(self):
        """Test that common reserved names are present."""
        common_names = ["all", "list", "status", "help", "start", "stop", "restart"]
        for name in common_names:
            assert name in RESERVED_NAMES


class TestValidateInstanceName:
    """Tests for validate_instance_name function."""

    def test_valid_simple_name(self):
        """Test validation of simple valid name."""
        result = validate_instance_name("myinstance")
        assert result == "myinstance"

    def test_valid_with_numbers(self):
        """Test validation of name with numbers."""
        result = validate_instance_name("instance123")
        assert result == "instance123"

    def test_valid_with_underscore(self):
        """Test validation of name with underscore."""
        result = validate_instance_name("my_instance")
        assert result == "my_instance"

    def test_valid_with_hyphen(self):
        """Test validation of name with hyphen."""
        result = validate_instance_name("my-instance")
        assert result == "my-instance"

    def test_valid_max_length(self):
        """Test validation of name at max length (64 characters)."""
        name = "a" * 64
        result = validate_instance_name(name)
        assert result == name

    def test_empty_name_raises_error(self):
        """Test that empty name raises error."""
        with pytest.raises(ValueError, match="cannot be empty"):
            validate_instance_name("")

    def test_non_string_raises_error(self):
        """Test that non-string raises error."""
        with pytest.raises(ValueError, match="must be a string"):
            validate_instance_name(123)  # type: ignore

    def test_too_long_raises_error(self):
        """Test that name > 64 characters raises error."""
        name = "a" * 65
        with pytest.raises(ValueError, match="too long.*65 characters"):
            validate_instance_name(name)

    def test_reserved_name_raises_error(self):
        """Test that reserved names raise error."""
        for reserved in ["all", "list", "status"]:
            with pytest.raises(ValueError, match=f"'{reserved}' is reserved"):
                validate_instance_name(reserved)

    def test_reserved_name_case_insensitive(self):
        """Test that reserved names are case-insensitive."""
        with pytest.raises(ValueError, match="'ALL' is reserved"):
            validate_instance_name("ALL")

    def test_path_separator_raises_error(self):
        """Test that path separators raise error."""
        with pytest.raises(ValueError, match="cannot contain path separators"):
            validate_instance_name("my/instance")

    def test_backslash_separator_raises_error(self):
        """Test that backslash raises error."""
        with pytest.raises(ValueError, match="cannot contain path separators"):
            validate_instance_name("my\\instance")

    def test_dangerous_characters_raise_error(self):
        """Test that dangerous shell characters raise error."""
        for char in ["$", "&", "|", ";", "<", ">", "`", "(", ")", "{", "}"]:
            with pytest.raises(ValueError, match="dangerous characters"):
                validate_instance_name(f"my{char}instance")

    def test_null_byte_raises_error(self):
        """Test that null bytes raise error."""
        with pytest.raises(ValueError, match="cannot contain null bytes"):
            validate_instance_name("my\x00instance")

    def test_invalid_pattern_raises_error(self):
        """Test that invalid patterns raise error."""
        with pytest.raises(ValueError, match="Invalid instance name"):
            validate_instance_name("123instance")  # Cannot start with number

    def test_starts_with_number_raises_error(self):
        """Test that name starting with number raises error."""
        with pytest.raises(ValueError, match="Invalid instance name"):
            validate_instance_name("123instance")

    def test_returns_validated_name(self):
        """Test that function returns the validated name."""
        result = validate_instance_name("valid_name")
        assert result == "valid_name"


class TestGetSafeInstancePath:
    """Tests for get_safe_instance_path function."""

    def test_returns_safe_path(self):
        """Test that safe path is returned for valid input."""
        base_dir = Path("/tmp/cc-bridge")
        result = get_safe_instance_path(base_dir, "test-instance")
        # The function returns a resolved absolute path
        assert result.is_absolute()
        assert "test-instance" in str(result)

    def test_validates_instance_name(self):
        """Test that instance name is validated."""
        base_dir = Path("/tmp/cc-bridge")
        # Name starting with number fails pattern validation
        with pytest.raises(ValueError, match="Invalid instance name"):
            get_safe_instance_path(base_dir, "123invalid")

    def test_prevents_path_traversal_with_dotdot(self):
        """Test that path traversal with ../ is prevented."""
        base_dir = Path("/tmp/cc-bridge")
        # The instance name validation happens first, and ".." is invalid
        # because it doesn't match the pattern (doesn't start with letter)
        with pytest.raises(ValueError, match="Invalid instance name"):
            get_safe_instance_path(base_dir, "..etc")

    def test_prevents_absolute_path_traversal(self):
        """Test that absolute path traversal is prevented."""
        base_dir = Path("/tmp/cc-bridge")
        # Instance name validation happens first - "/" is a path separator
        with pytest.raises(ValueError, match="cannot contain path separators"):
            get_safe_instance_path(base_dir, "/etc/passwd")


class TestSanitizeDockerLabel:
    """Tests for sanitize_docker_label function."""

    def test_keeps_valid_label(self):
        """Test that valid labels are unchanged."""
        result = sanitize_docker_label("valid_label")
        assert result == "valid_label"

    def test_removes_dangerous_chars(self):
        """Test that dangerous characters are removed."""
        result = sanitize_docker_label("invalid@label#123")
        assert result == "invalid_label_123"

    def test_replaces_spaces_with_underscores(self):
        """Test that spaces are replaced with underscores."""
        result = sanitize_docker_label("my label")
        assert result == "my_label"

    def test_handles_multiple_dangerous_chars(self):
        """Test handling of multiple dangerous characters."""
        result = sanitize_docker_label("label@#$%^test")
        assert result == "label_____test"

    def test_removes_null_bytes(self):
        """Test that null bytes are removed."""
        result = sanitize_docker_label("label\x00test")
        assert result == "labeltest"
        assert "\x00" not in result

    def test_empty_after_sanitization_raises_error(self):
        """Test that empty result raises error."""
        # Characters that would all be sanitized to underscores are still OK
        # @#$%^ becomes _____ (5 underscores)
        result = sanitize_docker_label("@#$%^")
        assert result == "_____"
        # Only truly empty (or null bytes only) would raise error
        with pytest.raises(ValueError, match="empty after sanitization"):
            sanitize_docker_label("\x00\x00")

    def test_non_string_raises_error(self):
        """Test that non-string raises error."""
        with pytest.raises(ValueError, match="must be a string"):
            sanitize_docker_label(123)  # type: ignore

    def test_max_length(self):
        """Test that max length label is accepted."""
        # Create a label at max length (4096 characters)
        label = "a" * 4096
        result = sanitize_docker_label(label)
        assert result == label

    def test_too_long_raises_error(self):
        """Test that label > 4096 characters raises error."""
        label = "a" * 4097
        with pytest.raises(ValueError, match=r"too long \(max 4096 characters\): 4097"):
            sanitize_docker_label(label)


class TestSafeTmuxSessionName:
    """Tests for safe_tmux_session_name function."""

    def test_adds_prefix(self):
        """Test that prefix is added to instance name."""
        result = safe_tmux_session_name("myinstance")
        assert result == "claude-myinstance"

    def test_validates_instance_name(self):
        """Test that instance name is validated."""
        with pytest.raises(ValueError, match="Invalid instance name"):
            safe_tmux_session_name("123invalid")

    def test_prevents_colon(self):
        """Test that colons are prevented by validate_instance_name first."""
        # The colon is not in the valid pattern for instance names
        with pytest.raises(ValueError, match="Invalid instance name"):
            safe_tmux_session_name("my:instance")

    def test_prevents_dot(self):
        """Test that dots are prevented by validate_instance_name (not in valid pattern)."""
        # Dots are NOT in the valid pattern ^[a-zA-Z][a-zA-Z0-9_-]{0,63}$
        # So they fail at validate_instance_name stage
        with pytest.raises(ValueError, match="Invalid instance name"):
            safe_tmux_session_name("my.instance")

    def test_prevents_backslash(self):
        """Test that backslashes are prevented by validate_instance_name first."""
        # Backslash is a path separator, caught by validate_instance_name
        with pytest.raises(ValueError, match="cannot contain path separators"):
            safe_tmux_session_name("my\\instance")

    def test_returns_validated_name(self):
        """Test that function returns safe session name."""
        result = safe_tmux_session_name("valid-name")
        assert result == "claude-valid-name"
