"""
Claude instance management core module.

This module handles the lifecycle and metadata management of Claude Code
instances running in tmux sessions.
"""

import json
import os
from datetime import datetime
from pathlib import Path

from cc_bridge.logging import get_logger
from cc_bridge.models.instances import ClaudeInstance, InstancesData

logger = get_logger(__name__)


class InstanceManager:
    """
    Manager for Claude Code instances.

    Handles instance lifecycle, metadata persistence, and tmux integration.
    """

    DEFAULT_INSTANCES_FILE = "~/.claude/bridge/instances.json"

    def __init__(self, instances_file: str | None = None):
        """
        Initialize instance manager.

        Args:
            instances_file: Path to instances JSON file
        """
        self.instances_file = Path(instances_file or self.DEFAULT_INSTANCES_FILE).expanduser()
        self.instances_file.parent.mkdir(parents=True, exist_ok=True)
        self._instances: dict[str, ClaudeInstance] = {}
        self._load()

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

    def create_instance(
        self, name: str, tmux_session: str, cwd: str | None = None
    ) -> ClaudeInstance:
        """
        Create a new instance metadata.

        Args:
            name: Instance name
            tmux_session: tmux session name
            cwd: Working directory

        Returns:
            Created ClaudeInstance
        """
        instance = ClaudeInstance(name=name, tmux_session=tmux_session, cwd=cwd, status="created")
        self._instances[name] = instance
        self._save()
        return instance

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

    def update_instance(self, name: str, **kwargs) -> ClaudeInstance | None:
        """
        Update instance attributes.

        Args:
            name: Instance name
            **kwargs: Attributes to update

        Returns:
        Updated ClaudeInstance or None
        """
        instance = self._instances.get(name)
        if instance:
            for key, value in kwargs.items():
                setattr(instance, key, value)
            self._save()
        return instance

    def delete_instance(self, name: str) -> bool:
        """
        Delete instance.

        Args:
            name: Instance name

        Returns:
            True if deleted, False if not found
        """
        if name in self._instances:
            del self._instances[name]
            self._save()
            return True
        return False

    def get_instance_status(self, name: str) -> str:
        """
        Get instance status by checking PID.

        Args:
            name: Instance name

        Returns:
            Status string: "running", "stopped", or "crashed"
        """
        instance = self._instances.get(name)
        if not instance:
            return "not_found"

        if instance.pid is None:
            return "no_pid"

        try:
            # Check if process is running
            os.kill(instance.pid, 0)  # Signal 0 doesn't actually send signal
            return "running"
        except OSError:
            return "stopped"

    def update_instance_activity(self, name: str) -> None:
        """
        Update last activity timestamp for instance.

        Args:
            name: Instance name
        """
        instance = self._instances.get(name)
        if instance:
            instance.last_activity = datetime.now()
            self._save()


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
