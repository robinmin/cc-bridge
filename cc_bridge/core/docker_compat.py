"""
Docker compatibility module.

This module provides Docker SDK functionality for cc-bridge.
Docker SDK is a required dependency for cc-bridge.
"""

import docker as docker_module
from docker.errors import DockerException

from cc_bridge.logging import get_logger

logger = get_logger(__name__)

logger.info("Docker SDK is available")


def is_docker_available() -> bool:
    """
    Check if Docker SDK is available and functional.

    Returns:
        True if Docker SDK can be imported and used.

    Note:
        Docker SDK is a required dependency, so this always returns True
        if the module imported successfully. Otherwise, ImportError is raised.
    """
    return True


def get_docker_client():
    """
    Get a Docker client instance.

    Returns:
        Docker client instance.

    Raises:
        DockerException: If Docker daemon is not running or not accessible.
    """
    return docker_module.from_env()


def ensure_docker_available() -> None:
    """
    Ensure Docker is available, raise exception if not.

    Raises:
        DockerException: If Docker daemon is not running or not accessible.
        ImportError: If Docker SDK is not installed (raised at import time).

    Note:
        Docker SDK is a required dependency for cc-bridge.
        Docker daemon must be running for Docker features to work.
    """
    # Try to ping Docker daemon to verify it's running
    try:
        client = docker_module.from_env()
        client.ping()
    except DockerException as e:
        raise DockerException(
            "Docker daemon is not running or not accessible. "
            "Please start Docker and ensure it's accessible."
        ) from e


__all__ = [
    "DockerException",
    "docker_module",
    "ensure_docker_available",
    "get_docker_client",
    "is_docker_available",
]
