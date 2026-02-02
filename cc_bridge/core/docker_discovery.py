"""
Docker container discovery module for Claude Code instances.

This module provides functionality to discover Docker containers that are
running Claude Code, using labels, image names, and process inspection.
"""

from datetime import datetime

from cc_bridge.core.docker_compat import (
    ensure_docker_available,
    get_docker_client,
    is_docker_available,
)
from cc_bridge.models.instances import ClaudeInstance
from cc_bridge.packages.logging import get_logger

logger = get_logger(__name__)


class DockerDiscoverer:
    """
    Discovers Docker containers running Claude Code.

    Supports multiple discovery methods:
    1. Label-based: Containers with cc-bridge.instance label
    2. Image-based: Containers using cc-bridge or claude-code images
    3. Process-based: Containers with claude process running
    """

    def __init__(
        self,
        container_label: str = "cc-bridge.instance",
        image_patterns: list[str] | None = None,
    ):
        """
        Initialize Docker discoverer.

        Args:
            container_label: Label to filter containers by
            image_patterns: List of image name patterns to search for
        """
        self.container_label = container_label
        self.image_patterns = image_patterns or ["cc-bridge", "claude-code"]

    def discover_all(self) -> list[ClaudeInstance]:
        """
        Discover all Docker instances using all available methods.

        Returns:
            List of discovered ClaudeInstance records

        Raises:
            RuntimeError: If Docker is not available
        """
        ensure_docker_available()

        discovered = {}
        client = get_docker_client()

        # Try label-based discovery (most reliable)
        for instance in self._discover_by_label(client):
            if instance.name not in discovered:
                discovered[instance.name] = instance
                logger.info(f"Discovered Docker instance by label: {instance.name}")

        # Try image-based discovery
        for instance in self._discover_by_image(client):
            if instance.name not in discovered:
                discovered[instance.name] = instance
                logger.info(f"Discovered Docker instance by image: {instance.name}")

        # Try process-based discovery (fallback)
        for instance in self._discover_by_process(client):
            if instance.name not in discovered:
                discovered[instance.name] = instance
                logger.info(f"Discovered Docker instance by process: {instance.name}")

        logger.info(f"Total Docker instances discovered: {len(discovered)}")
        return list(discovered.values())

    def _discover_by_label(self, client) -> list[ClaudeInstance]:
        """
        Discover containers by label filter.

        Args:
            client: Docker client

        Returns:
            List of ClaudeInstance records
        """
        instances = []

        try:
            containers = client.containers.list(
                filters={"label": self.container_label},
                all=False,  # Only running containers
            )

            for container in containers:
                instance = self._container_to_instance(container)
                if instance:
                    instances.append(instance)

        except Exception as e:
            logger.warning(f"Label-based discovery failed: {e}")

        return instances

    def _discover_by_image(self, client) -> list[ClaudeInstance]:
        """
        Discover containers by image name patterns.

        Args:
            client: Docker client

        Returns:
            List of ClaudeInstance records
        """
        instances = []

        try:
            containers = client.containers.list(all=False)  # Only running containers

            for container in containers:
                image_name = container.image.tags[0] if container.image.tags else ""
                if any(pattern in image_name for pattern in self.image_patterns):
                    instance = self._container_to_instance(container)
                    if instance:
                        instances.append(instance)

        except Exception as e:
            logger.warning(f"Image-based discovery failed: {e}")

        return instances

    def _discover_by_process(self, client) -> list[ClaudeInstance]:
        """
        Discover containers by process inspection.

        Args:
            client: Docker client

        Returns:
            List of ClaudeInstance records
        """
        instances = []

        try:
            containers = client.containers.list(all=False)  # Only running containers

            for container in containers:
                # Check if container has a 'claude' process running
                try:
                    top_output = container.top(ps_args="aux")
                    if top_output and "Processes" in top_output:
                        processes = top_output["Processes"]
                        if any("claude" in str(process) for process in processes):
                            instance = self._container_to_instance(container)
                            if instance:
                                instances.append(instance)
                except Exception:
                    # Process inspection may fail for some containers
                    continue

        except Exception as e:
            logger.warning(f"Process-based discovery failed: {e}")

        return instances

    def _container_to_instance(self, container) -> ClaudeInstance | None:
        """
        Convert a Docker container to ClaudeInstance record.

        Args:
            container: Docker container object

        Returns:
            ClaudeInstance or None if conversion fails
        """
        try:
            # Get instance name from label first, then container name
            labels = container.labels or {}
            instance_name = labels.get(self.container_label) or container.name

            # Handle name conflicts by adding -docker suffix if needed
            if instance_name.startswith("/"):
                instance_name = instance_name.lstrip("/")

            # Get network name
            network_name = None
            if container.attrs.get("NetworkSettings"):
                networks = container.attrs["NetworkSettings"].get("Networks", {})
                if networks:
                    network_name = next(iter(networks.keys()))

            return ClaudeInstance(
                name=instance_name,
                instance_type="docker",
                status="running" if container.status == "running" else "stopped",
                container_id=container.id,
                container_name=container.name,
                image_name=container.image.tags[0] if container.image.tags else container.image.id,
                docker_network=network_name,
                created_at=datetime.now(),
            )

        except Exception as e:
            logger.warning(f"Failed to convert container {container.id} to instance: {e}")
            return None

    def discover_by_name(self, name: str) -> ClaudeInstance | None:
        """
        Discover a specific Docker instance by name.

        Args:
            name: Instance name to search for

        Returns:
            ClaudeInstance or None if not found

        Raises:
            RuntimeError: If Docker is not available
        """
        ensure_docker_available()

        client = get_docker_client()

        try:
            # Try to find container by name
            container = client.containers.get(name)
            return self._container_to_instance(container)
        except Exception:
            # Try with / prefix
            try:
                container = client.containers.get(f"/{name}")
                return self._container_to_instance(container)
            except Exception as e:
                logger.debug(f"Container not found: {name}: {e}")
                return None


__all__ = ["DockerDiscoverer", "is_docker_available"]
