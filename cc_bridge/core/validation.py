"""
Validation utilities for cc-bridge.

This module provides validation functions for user input to prevent
security vulnerabilities like path traversal and command injection.
"""

import re
from pathlib import Path

# Safe instance name pattern:
# - Must start with a letter
# - Can contain letters, numbers, underscores, and hyphens
# - Maximum 64 characters (Docker label limit)
INSTANCE_NAME_PATTERN = re.compile(r"^[a-zA-Z][a-zA-Z0-9_-]{0,63}$")

# Reserved names that cannot be used as instance names
RESERVED_NAMES = {
    "all",
    "list",
    "status",
    "help",
    "start",
    "stop",
    "restart",
    "attach",
    "default",
    "null",
    "none",
    "true",
    "false",
}


def validate_instance_name(name: str) -> str:
    """
    Validate instance name is safe for use in paths, commands, and Docker labels.

    Args:
        name: Instance name to validate

    Returns:
        The validated name

    Raises:
        ValueError: If name is invalid
    """
    if not name:
        raise ValueError("Instance name cannot be empty")

    if not isinstance(name, str):
        raise ValueError("Instance name must be a string")

    # Check length
    if len(name) > 64:
        raise ValueError(f"Instance name too long (max 64 characters): {len(name)} characters")

    # Check for reserved names (case-insensitive)
    if name.lower() in RESERVED_NAMES:
        raise ValueError(f"Instance name '{name}' is reserved and cannot be used")

    # Check for path separators
    if "/" in name or "\\" in name:
        raise ValueError("Instance name cannot contain path separators (/ or \\)")

    # Check for shell metacharacters that could be used in command injection
    dangerous_chars = {"$", "&", "|", ";", "<", ">", "`", "(", ")", "{", "}"}
    if any(char in name for char in dangerous_chars):
        raise ValueError(
            f"Instance name contains dangerous characters: {set(name) & dangerous_chars}"
        )

    # Check for null bytes
    if "\x00" in name:
        raise ValueError("Instance name cannot contain null bytes")

    # Validate against safe pattern
    if not INSTANCE_NAME_PATTERN.match(name):
        raise ValueError(
            f"Invalid instance name: {name}. "
            "Must start with a letter, contain only alphanumeric characters, "
            "underscores, and hyphens (max 64 characters)."
        )

    return name


def get_safe_instance_path(base_dir: Path, instance_name: str) -> Path:
    """
    Get a safe file path for an instance, preventing path traversal attacks.

    Args:
        base_dir: Base directory for instance files
        instance_name: Validated instance name

    Returns:
        Safe path for the instance

    Raises:
        ValueError: If path traversal is detected
    """
    # Validate the instance name first
    validate_instance_name(instance_name)

    # Construct the path
    instance_path = (base_dir / instance_name).resolve()

    # Ensure the path is within the base directory
    base_resolved = base_dir.resolve()

    try:
        if not instance_path.is_relative_to(base_resolved):
            raise ValueError(
                f"Path traversal detected: instance name '{instance_name}' "
                f"would escape base directory '{base_dir}'"
            )
    except AttributeError:
        # Python < 3.9 doesn't have is_relative_to, use alternative check
        try:
            instance_path.relative_to(base_resolved)
        except ValueError:
            raise ValueError(
                f"Path traversal detected: instance name '{instance_name}' "
                f"would escape base directory '{base_dir}'"
            ) from None

    return instance_path


def sanitize_docker_label(value: str) -> str:
    """
    Sanitize a value for use as a Docker label.

    Docker labels have strict requirements:
    - Must match regex: [a-zA-Z0-9_.-]
    - Maximum 4096 characters

    Args:
        value: Value to sanitize

    Returns:
        Sanitized value safe for Docker labels

    Raises:
        ValueError: If value cannot be sanitized
    """
    if not isinstance(value, str):
        raise ValueError("Docker label value must be a string")

    if len(value) > 4096:
        raise ValueError(f"Docker label value too long (max 4096 characters): {len(value)}")

    # Remove null bytes and other dangerous characters
    value = value.replace("\x00", "")

    # Docker allows only specific characters in label values
    # Replace invalid characters with underscores
    sanitized = re.sub(r"[^a-zA-Z0-9_.-]", "_", value)

    # Ensure the result is not empty after sanitization
    if not sanitized:
        raise ValueError("Docker label value is empty after sanitization")

    return sanitized


def safe_tmux_session_name(instance_name: str) -> str:
    """
    Generate a safe tmux session name from an instance name.

    Args:
        instance_name: Validated instance name

    Returns:
        Safe tmux session name
    """
    # Validate the instance name first
    validate_instance_name(instance_name)

    # tmux session names have restrictions:
    # - Cannot contain certain special characters
    # - Maximum length is around 500 characters, but we'll be conservative

    # Prefix with 'claude-' to avoid conflicts and make it clear
    session_name = f"claude-{instance_name}"

    # tmux doesn't allow these characters in session names
    # (already prevented by validate_instance_name, but double-check)
    forbidden = {".", ":", "\\"}
    if any(char in session_name for char in forbidden):
        raise ValueError(f"Instance name cannot contain: {' '.join(forbidden)}")

    return session_name
