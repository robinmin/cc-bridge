"""
Claude instance management core module.

This module handles the lifecycle and metadata management of Claude Code
instances running in tmux sessions or Docker containers.
"""

import asyncio
import json
import os
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

from cc_bridge.core.validation import validate_instance_name
from cc_bridge.logging import get_logger
from cc_bridge.models.instances import ClaudeInstance, InstancesData

logger = get_logger(__name__)

# Status cache TTL (time-to-live) - refresh status after this duration
STATUS_TTL = timedelta(seconds=30)


@dataclass
class CachedStatus:
    """
    Cached status with timestamp for staleness detection.

    Attributes:
        status: The status string ("running", "stopped", etc.)
        timestamp: When the status was fetched
    """

    status: str
    timestamp: datetime

    @property
    def is_stale(self) -> bool:
        """Check if cached status is stale (older than TTL)."""
        return datetime.now() - self.timestamp > STATUS_TTL


class InstanceManager:
    """
    Manager for Claude Code instances.

    Handles instance lifecycle, metadata persistence, and integration
    with tmux sessions and Docker containers.
    """

    DEFAULT_INSTANCES_FILE = "~/.claude/bridge/instances.json"

    def __init__(
        self,
        instances_file: str | None = None,
        auto_discover: bool = True,
        docker_enabled: bool = True,
    ):
        """
        Initialize instance manager.

        Args:
            instances_file: Path to instances JSON file
            auto_discover: Whether to auto-discover Docker instances on init
            docker_enabled: Whether Docker instances are enabled
        """
        self.instances_file = Path(instances_file or self.DEFAULT_INSTANCES_FILE).expanduser()
        self.instances_file.parent.mkdir(parents=True, exist_ok=True)
        self._instances: dict[str, ClaudeInstance] = {}
        self._auto_discover = auto_discover
        self._docker_enabled = docker_enabled
        self._lock = asyncio.Lock()  # Lock for thread-safe instance modifications
        self._status_cache: dict[str, CachedStatus] = {}  # Status cache with TTL
        self._load()

        # Note: Docker auto-discovery skipped in __init__ (sync context)
        # Use refresh_discovery() method to manually trigger discovery

    def _load(self) -> None:
        """Load instances from JSON file."""
        if self.instances_file.exists():
            try:
                data = json.loads(self.instances_file.read_text())
                instances_data = InstancesData.model_validate(data)
                self._instances = instances_data.instances
                logger.debug("Loaded instances", instances=list(self._instances.keys()))
            except Exception as e:
                logger.warning("Failed to load instances", error=str(e))
                self._instances = {}

    def _save(self) -> None:
        """Save instances to JSON file."""
        try:
            data = InstancesData(instances=self._instances).model_dump(mode="json")
            self.instances_file.write_text(json.dumps(data, indent=2))
            logger.debug("Saved instances", instances=list(self._instances.keys()))
        except Exception as e:
            logger.error("Failed to save instances", error=str(e))

    async def create_instance(
        self,
        name: str,
        instance_type: str = "tmux",
        tmux_session: str | None = None,
        cwd: str | None = None,
        container_id: str | None = None,
        container_name: str | None = None,
        image_name: str | None = None,
        docker_network: str | None = None,
    ) -> ClaudeInstance:
        """
        Create a new instance metadata.

        Args:
            name: Instance name
            instance_type: Instance type ("tmux" or "docker")
            tmux_session: tmux session name (for tmux instances)
            cwd: Working directory (for tmux instances)
            container_id: Docker container ID (for docker instances)
            container_name: Docker container name (for docker instances)
            image_name: Docker image name (for docker instances)
            docker_network: Docker network name (for docker instances)

        Returns:
            Created ClaudeInstance

        Raises:
            ValueError: If instance name is invalid
        """
        # Validate instance name for security
        validate_instance_name(name)

        if instance_type == "tmux":
            if not tmux_session:
                raise ValueError("tmux_session is required for tmux instances")
            instance = ClaudeInstance(
                name=name,
                instance_type="tmux",
                tmux_session=tmux_session,
                cwd=cwd,
                status="created",
            )
        elif instance_type == "docker":
            if not container_id:
                raise ValueError("container_id is required for docker instances")
            instance = ClaudeInstance(
                name=name,
                instance_type="docker",
                container_id=container_id,
                container_name=container_name,
                image_name=image_name,
                docker_network=docker_network,
                status="created",
            )
        else:
            raise ValueError(f"Unknown instance type: {instance_type}")

        # Acquire lock before modifying _instances
        async with self._lock:
            self._instances[name] = instance
            self._save()
        logger.info(f"Created {instance_type} instance: {name}")
        return instance

    async def create_docker_instance(
        self,
        name: str,
        container_id: str,
        container_name: str | None = None,
        image_name: str | None = None,
        docker_network: str | None = None,
    ) -> ClaudeInstance:
        """
        Create a new Docker instance metadata.

        Convenience method for creating Docker instances.

        Args:
            name: Instance name
            container_id: Docker container ID
            container_name: Docker container name
            image_name: Docker image name
            docker_network: Docker network name

        Returns:
            Created ClaudeInstance
        """
        return await self.create_instance(
            name=name,
            instance_type="docker",
            container_id=container_id,
            container_name=container_name,
            image_name=image_name,
            docker_network=docker_network,
        )

    def get_instance(self, name: str) -> ClaudeInstance | None:
        """
        Get instance by name.

        Args:
            name: Instance name

        Returns:
            ClaudeInstance or None
        """
        return self._instances.get(name)

    def list_instances(self) -> list[ClaudeInstance]:
        """
        List all instances.

        Returns:
            List of all ClaudeInstance objects
        """
        return list(self._instances.values())

    async def update_instance(self, name: str, **kwargs) -> ClaudeInstance | None:
        """
        Update instance attributes.

        Args:
            name: Instance name
            **kwargs: Attributes to update

        Returns:
        Updated ClaudeInstance or None
        """
        async with self._lock:
            instance = self._instances.get(name)
            if instance:
                for key, value in kwargs.items():
                    setattr(instance, key, value)
                self._save()
            return instance

    async def delete_instance(self, name: str) -> bool:
        """
        Delete instance.

        Args:
            name: Instance name

        Returns:
            True if deleted, False if not found
        """
        async with self._lock:
            if name in self._instances:
                del self._instances[name]
                self._save()
                return True
            return False

    async def aget_instance_status(self, name: str, force_refresh: bool = False) -> str:
        """
        Get instance status by checking PID or container.

        Uses caching with TTL to minimize expensive runtime checks.
        Updates instance metadata when status changes.

        Args:
            name: Instance name
            force_refresh: Bypass cache and force status check

        Returns:
            Status string: "running", "stopped", "crashed", or "not_found"
        """
        instance = self._instances.get(name)
        if not instance:
            return "not_found"

        # Check cache first (unless force_refresh)
        cached = self._status_cache.get(name)
        if not force_refresh and cached and not cached.is_stale:
            return cached.status

        # Cache miss, stale, or force refresh - fetch actual status
        actual_status = await self._afetch_actual_status(instance)

        # Update cache
        self._status_cache[name] = CachedStatus(status=actual_status, timestamp=datetime.now())

        # Update metadata if status changed
        if instance.status != actual_status:
            try:
                await self.update_instance_status(name, actual_status)
            except Exception as e:
                # Log but don't fail status check if metadata update fails
                logger.warning(f"Failed to update instance metadata: {e}")

        return actual_status

    async def _afetch_actual_status(self, instance: ClaudeInstance) -> str:
        """
        Fetch actual status from runtime state (tmux or Docker).

        Args:
            instance: ClaudeInstance to check

        Returns:
            Actual status string
        """
        if instance.instance_type == "docker":
            # Check Docker container status
            try:
                from cc_bridge.core.docker_compat import get_docker_client

                # Docker SDK is blocking, wrap in executor for hygiene if in event loop
                loop = asyncio.get_running_loop()
                client = await loop.run_in_executor(None, get_docker_client)

                def get_status():
                    container = client.containers.get(instance.container_id)
                    return container.status

                return await loop.run_in_executor(None, get_status)
            except Exception:
                return "stopped"
        else:
            # Tmux instance - check PID
            if instance.pid is None:
                return "no_pid"

            try:
                # Check if process is running
                os.kill(instance.pid, 0)  # Signal 0 doesn't actually send signal
                return "running"
            except OSError:
                return "stopped"

    async def update_instance_activity(self, name: str) -> None:
        """
        Update last activity timestamp for instance.

        Args:
            name: Instance name
        """
        async with self._lock:
            instance = self._instances.get(name)
            if instance:
                instance.last_activity = datetime.now()
                self._save()

    async def _discover_docker_instances(self) -> list[ClaudeInstance]:
        """
        Discover Docker instances and add them to the manager.

        Returns:
            List of discovered instances
        """
        try:
            from cc_bridge.core.docker_discovery import DockerDiscoverer

            discoverer = DockerDiscoverer()
            discovered = discoverer.discover_all()

            # Acquire lock before modifying _instances
            async with self._lock:
                for instance in discovered:
                    # Add or update instance
                    if instance.name not in self._instances:
                        self._instances[instance.name] = instance
                        logger.info(f"Discovered Docker instance: {instance.name}")
                    else:
                        # Update existing instance's status
                        existing = self._instances[instance.name]
                        existing.status = instance.status
                        logger.debug(f"Updated Docker instance status: {instance.name}")

                if discovered:
                    self._save()

            return discovered

        except Exception as e:
            logger.warning(f"Docker discovery failed: {e}")
            return []

    async def refresh_discovery(self) -> list[ClaudeInstance]:
        """
        Manually refresh Docker instance discovery.

        Returns:
            List of newly discovered instances
        """
        return await self._discover_docker_instances()

    def list_tmux_instances(self) -> list[ClaudeInstance]:
        """
        List only tmux instances.

        Returns:
            List of tmux ClaudeInstance objects
        """
        return [i for i in self._instances.values() if i.instance_type == "tmux"]

    def list_docker_instances(self) -> list[ClaudeInstance]:
        """
        List only Docker instances.

        Returns:
            List of docker ClaudeInstance objects
        """
        return [i for i in self._instances.values() if i.instance_type == "docker"]

    def get_docker_instance(self, name: str) -> ClaudeInstance | None:
        """
        Get Docker instance by name.

        Args:
            name: Instance name

        Returns:
            ClaudeInstance or None
        """
        instance = self._instances.get(name)
        if instance and instance.instance_type == "docker":
            return instance
        return None

    async def update_instance_status(self, name: str, status: str) -> None:
        """
        Update instance status.

        Args:
            name: Instance name
            status: New status ("running", "stopped", "crashed")
        """
        async with self._lock:
            instance = self._instances.get(name)
            if instance:
                instance.status = status
                self._save()
                logger.debug(f"Updated instance status: {name} -> {status}")

    async def cleanup_stopped_instances(self, instance_type: str | None = None) -> int:
        """
        Remove stopped instances from the manager.

        Args:
            instance_type: Optional filter by instance type

        Returns:
            Number of instances removed
        """
        async with self._lock:
            to_remove = []

            for name, instance in self._instances.items():
                if instance.status == "stopped" and (
                    instance_type is None or instance.instance_type == instance_type
                ):
                    to_remove.append(name)

            for name in to_remove:
                del self._instances[name]
                logger.info(f"Removed stopped instance: {name}")

            if to_remove:
                self._save()

            return len(to_remove)


# Global instance manager instance
_instance_manager: InstanceManager | None = None


def get_instance_manager() -> InstanceManager:
    """
    Get global instance manager singleton.

    Returns:
        InstanceManager instance
    """
    global _instance_manager  # noqa: PLW0603
    if _instance_manager is None:
        _instance_manager = InstanceManager()
    return _instance_manager


def reset_instance_manager() -> None:
    """
    Reset global instance manager singleton for testing.

    WARNING: Do not use in production code. This is only for tests
    to ensure clean state between test runs.
    """
    global _instance_manager  # noqa: PLW0603
    _instance_manager = None
