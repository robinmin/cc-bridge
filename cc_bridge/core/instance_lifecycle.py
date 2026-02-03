"""
Instance lifecycle utilities for cc-bridge.

This module provides reusable helper functions for instance lifecycle management,
including validation, detection, and tmux-related utilities.
"""

import subprocess
from pathlib import Path

from cc_bridge.config import get_config
from cc_bridge.core.docker_compat import is_docker_available
from cc_bridge.core.validation import safe_tmux_session_name
from cc_bridge.models.instances import ClaudeInstance
from cc_bridge.packages.logging import get_logger

logger = get_logger(__name__)

# Constants
DEFAULT_TMUX_SOCKET_PATH = "~/.claude/bridge/tmux.sock"

__all__ = [
    "get_tmux_socket_path",
    "is_tmux_available",
    "get_session_name",
    "validate_working_directory",
    "detect_instance_type",
    "DEFAULT_TMUX_SOCKET_PATH",
]


def get_tmux_socket_path() -> str:
    """
    Get the tmux socket path for CC-Bridge.

    Returns:
        Absolute path to the tmux socket file
    """
    return str(Path.home() / ".claude" / "bridge" / "tmux.sock")


def is_tmux_available() -> bool:
    """
    Check if tmux is available on the system.

    Returns:
        True if tmux is installed and available, False otherwise
    """
    try:
        subprocess.run(["tmux", "-V"], capture_output=True, check=True)
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False


def get_session_name(name: str) -> str:
    """
    Generate a safe tmux session name from an instance name.

    Args:
        name: Instance name (will be validated)

    Returns:
        tmux session name with 'claude-' prefix

    Raises:
        ValueError: If instance name is invalid
    """
    return safe_tmux_session_name(name)


def validate_working_directory(cwd: str) -> tuple[bool, str]:
    """
    Validate and create working directory if needed.

    Args:
        cwd: Working directory path

    Returns:
        Tuple of (is_valid, absolute_path or error_message)

    Examples:
        >>> validate_working_directory("~/projects")
        (True, "/home/user/projects")

        >>> validate_working_directory("/nonexistent/path")
        (True, "/nonexistent/path")  # Creates directory

        >>> validate_working_directory("/etc/passwd")
        (False, "Path exists but is not a directory: /etc/passwd")
    """
    path = Path(cwd).expanduser().absolute()

    if path.exists() and not path.is_dir():
        return False, f"Path exists but is not a directory: {cwd}"

    if not path.exists():
        try:
            path.mkdir(parents=True, exist_ok=True)
            logger.info("Created working directory", path=str(path))
        except OSError as e:
            return False, f"Cannot create directory: {e}"

    return True, str(path)


def detect_instance_type(
    explicit_type: str | None,
    existing_instance: ClaudeInstance | None,
) -> str:
    """
    Detect the instance type to use (tmux or docker).

    Detection priority:
    1. Explicitly specified type
    2. Existing instance's type
    3. Configuration preferences (docker.enabled + docker.preferred)
    4. Default to tmux for backward compatibility

    Args:
        explicit_type: Explicitly specified type (tmux|docker|auto)
        existing_instance: Existing instance if any

    Returns:
        Instance type: "tmux" or "docker"

    Examples:
        >>> detect_instance_type("docker", None)
        'docker'

        >>> detect_instance_type(None, existing_instance_with_type)
        'tmux'  # From existing instance

        >>> detect_instance_type("auto", None)
        'tmux'  # Default if Docker not configured/preferred
    """
    # If explicit type provided, use it
    if explicit_type and explicit_type != "auto":
        return explicit_type

    # If existing instance has a type, use it
    if existing_instance and hasattr(existing_instance, "instance_type"):
        return existing_instance.instance_type

    # Check configuration
    config = get_config()
    docker_enabled = config.get("docker.enabled", False)
    docker_preferred = config.get("docker.preferred", False)

    if docker_enabled and docker_preferred and is_docker_available():
        return "docker"

    # Default to tmux for backward compatibility
    return "tmux"
