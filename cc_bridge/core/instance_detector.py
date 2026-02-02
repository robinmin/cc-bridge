"""
Instance type detection module for Claude instances.

This module provides automatic detection of instance types (tmux or Docker)
using metadata, container discovery, and process inspection.
"""

from datetime import datetime, timedelta
from pathlib import Path
from typing import Literal

from cc_bridge.core.docker_compat import is_docker_available
from cc_bridge.core.instances import get_instance_manager
from cc_bridge.packages.logging import get_logger

logger = get_logger(__name__)

# Type alias for instance types
InstanceType = Literal["tmux", "docker"]


class InstanceTypeDetector:
    """
    Detects the type of Claude instances.

    Uses multiple detection methods in priority order:
    1. Metadata check - Existing instance.type field
    2. Container check - Docker container discovery
    3. Process check - Tmux session existence
    4. Configuration fallback - docker.preferred setting
    5. Default - tmux for backward compatibility
    """

    def __init__(self, cache_ttl: int = 300):
        """
        Initialize instance type detector.

        Args:
            cache_ttl: Cache time-to-live in seconds (default: 5 minutes)
        """
        self.cache_ttl = cache_ttl
        self._cache: dict[str, tuple[InstanceType, datetime]] = {}

    def detect(self, name: str) -> InstanceType:
        """
        Detect the type of a Claude instance.

        Args:
            name: Instance name

        Returns:
            Instance type: "tmux" or "docker"
        """
        # Check cache first
        cached_type = self._get_from_cache(name)
        if cached_type:
            logger.debug(f"Using cached type for {name}: {cached_type}")
            return cached_type

        # Run detection in priority order
        instance_type = self._detect_from_metadata(name)
        if instance_type:
            self._update_cache(name, instance_type)
            return instance_type

        instance_type = self._detect_from_container(name)
        if instance_type:
            self._update_cache(name, instance_type)
            return instance_type

        instance_type = self._detect_from_process(name)
        if instance_type:
            self._update_cache(name, instance_type)
            return instance_type

        # Fallback to default
        instance_type = self._get_default_type()
        self._update_cache(name, instance_type)
        return instance_type

    def detect_with_confidence(self, name: str) -> tuple[InstanceType, str]:
        """
        Detect instance type with confidence level.

        Args:
            name: Instance name

        Returns:
            Tuple of (instance_type, confidence_level)
            Confidence levels: "high", "medium", "low"
        """
        # Check cache
        cached_type = self._get_from_cache(name)
        if cached_type:
            return cached_type, "high"

        # Metadata check is high confidence
        instance_type = self._detect_from_metadata(name)
        if instance_type:
            return instance_type, "high"

        # Container check is medium-high confidence
        instance_type = self._detect_from_container(name)
        if instance_type:
            return instance_type, "medium"

        # Process check is medium confidence
        instance_type = self._detect_from_process(name)
        if instance_type:
            return instance_type, "medium"

        # Default is low confidence
        instance_type = self._get_default_type()
        return instance_type, "low"

    def refresh(self, name: str) -> InstanceType:
        """
        Force refresh detection for an instance (bypasses cache).

        Args:
            name: Instance name

        Returns:
            Instance type: "tmux" or "docker"
        """
        self._invalidate_cache(name)
        return self.detect(name)

    def refresh_all(self) -> None:
        """Clear the entire detection cache."""
        self._cache.clear()
        logger.debug("Cleared detection cache")

    def _detect_from_metadata(self, name: str) -> InstanceType | None:
        """
        Detect instance type from existing metadata.

        Args:
            name: Instance name

        Returns:
            Instance type or None if not found
        """
        try:
            instance_manager = get_instance_manager()
            instance = instance_manager.get_instance(name)

            if instance and hasattr(instance, "instance_type"):
                logger.debug(f"Detected type from metadata: {name} -> {instance.instance_type}")
                return instance.instance_type

        except Exception as e:
            logger.debug(f"Metadata detection failed for {name}: {e}")

        return None

    def _detect_from_container(self, name: str) -> InstanceType | None:
        """
        Detect instance type from Docker container discovery.

        Args:
            name: Instance name

        Returns:
            "docker" if container found, None otherwise
        """
        if not is_docker_available():
            return None

        try:
            from cc_bridge.core.docker_compat import get_docker_client

            client = get_docker_client()

            # Try to find container by name
            try:
                container = client.containers.get(name)
                if container.status == "running":
                    logger.debug(f"Detected Docker container by name: {name}")
                    return "docker"
            except Exception:
                pass

            # Try with / prefix
            try:
                container = client.containers.get(f"/{name}")
                if container.status == "running":
                    logger.debug(f"Detected Docker container by name (with /): {name}")
                    return "docker"
            except Exception:
                pass

            # Try label-based discovery
            try:
                containers = client.containers.list(
                    filters={"label": f"cc-bridge.instance={name}"},
                    all=False,
                )
                if containers:
                    logger.debug(f"Detected Docker container by label: {name}")
                    return "docker"
            except Exception:
                pass

        except Exception as e:
            logger.debug(f"Container detection failed for {name}: {e}")

        return None

    def _detect_from_process(self, name: str) -> InstanceType | None:
        """
        Detect instance type from process/tmux session inspection.

        Args:
            name: Instance name

        Returns:
            "tmux" if tmux session found, None otherwise
        """
        try:
            import subprocess

            # Try to find tmux session
            session_name = f"claude-{name}"

            result = subprocess.run(
                ["tmux", "-S", self._get_tmux_socket(), "list-sessions"],
                capture_output=True,
                text=True,
                check=False,
            )

            if session_name in result.stdout:
                logger.debug(f"Detected tmux session: {name}")
                return "tmux"

        except Exception as e:
            logger.debug(f"Process detection failed for {name}: {e}")

        return None

    def _get_default_type(self) -> InstanceType:
        """
        Get default instance type from configuration.

        Returns:
            Default instance type
        """
        try:
            from cc_bridge.config import get_config

            config = get_config()
            docker_enabled = config.get("docker.enabled", False)
            docker_preferred = config.get("docker.preferred", False)

            if docker_enabled and docker_preferred and is_docker_available():
                logger.debug("Using default type: docker (from config)")
                return "docker"

        except Exception:
            pass

        logger.debug("Using default type: tmux")
        return "tmux"

    def _get_tmux_socket(self) -> str:
        """Get the tmux socket path for CC-Bridge."""
        return str(Path("~/.claude/bridge/tmux.sock").expanduser())

    def _get_from_cache(self, name: str) -> InstanceType | None:
        """Get instance type from cache if not expired."""
        if name not in self._cache:
            return None

        instance_type, timestamp = self._cache[name]
        if datetime.now() - timestamp < timedelta(seconds=self.cache_ttl):
            return instance_type

        # Cache expired, remove it
        del self._cache[name]
        return None

    def _update_cache(self, name: str, instance_type: InstanceType) -> None:
        """Update the detection cache."""
        self._cache[name] = (instance_type, datetime.now())

    def _invalidate_cache(self, name: str) -> None:
        """Invalidate cache entry for an instance."""
        if name in self._cache:
            del self._cache[name]


# Global detector instance
_detector: InstanceTypeDetector | None = None


def get_instance_detector() -> InstanceTypeDetector:
    """
    Get global instance detector singleton.

    Returns:
        InstanceTypeDetector instance
    """
    global _detector  # noqa: PLW0603
    if _detector is None:
        _detector = InstanceTypeDetector()
    return _detector


def reset_instance_detector() -> None:
    """
    Reset global instance detector singleton for testing.

    WARNING: Do not use in production code. This is only for tests
    to ensure clean state between test runs.
    """
    global _detector  # noqa: PLW0603
    _detector = None


def detect_instance_type(name: str) -> InstanceType:
    """
    Convenience function to detect instance type.

    Args:
        name: Instance name

    Returns:
        Instance type: "tmux" or "docker"
    """
    detector = get_instance_detector()
    return detector.detect(name)


__all__ = [
    "InstanceType",
    "InstanceTypeDetector",
    "detect_instance_type",
    "get_instance_detector",
]
