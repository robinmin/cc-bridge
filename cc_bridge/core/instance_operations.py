"""
Instance lifecycle operations for Claude Code instances.

This module contains the business logic for starting, stopping, and managing
Claude Code instances running in tmux sessions or Docker containers.

The commands/claude.py module should be a thin CLI wrapper around these functions.
"""

import shlex
import subprocess
from pathlib import Path

from cc_bridge.core.docker_compat import is_docker_available
from cc_bridge.core.instance_lifecycle import (
    get_session_name,
    get_tmux_socket_path,
    is_tmux_available,
    validate_working_directory,
)
from cc_bridge.core.instances import InstanceManager
from cc_bridge.packages.logging import get_logger

logger = get_logger(__name__)

__all__ = [
    "InstanceOperations",
    "start_tmux_instance",
    "start_docker_instance",
    "stop_tmux_instance",
    "stop_docker_instance",
    "check_tmux_session_exists",
]


class InstanceOperations:
    """
    Core instance lifecycle operations.

    Provides business logic for starting and stopping Claude Code instances
    in tmux sessions or Docker containers.
    """

    def __init__(self, instance_manager: InstanceManager):
        """
        Initialize operations handler.

        Args:
            instance_manager: Instance manager for persistence
        """
        self.instance_manager = instance_manager

    async def start_tmux_instance(
        self,
        name: str,
        cwd: str | None = None,
        tmux_session: str | None = None,
    ) -> dict:
        """
        Start a tmux-based Claude instance.

        Args:
            name: Instance name
            cwd: Working directory (defaults to current directory)
            tmux_session: tmux session name (auto-generated if None)

        Returns:
            Dictionary with success status and instance details

        Raises:
            RuntimeError: If tmux is not available or start fails
            ValueError: If working directory is invalid
        """
        if not is_tmux_available():
            raise RuntimeError("tmux is not installed")

        # Validate working directory
        if cwd:
            is_valid, result = validate_working_directory(cwd)
            if not is_valid:
                raise ValueError(f"Invalid working directory: {result}")
            work_dir = result
        else:
            work_dir = str(Path.cwd())

        # Generate session name if not provided
        if not tmux_session:
            tmux_session = get_session_name(name)

        # Create instance metadata
        await self.instance_manager.create_instance(
            name=name,
            instance_type="tmux",
            tmux_session=tmux_session,
            cwd=work_dir,
        )

        # Start tmux session
        tmux_socket = get_tmux_socket_path()
        socket_dir = Path(tmux_socket).parent
        socket_dir.mkdir(parents=True, exist_ok=True)

        try:
            # Create new tmux session
            cmd = [
                "tmux",
                "-S",
                tmux_socket,
                "new-session",
                "-d",  # Start detached
                "-s",
                tmux_session,
                "-n",
                "claude",
            ]

            # Set working directory and start Claude Code
            safe_dir = shlex.quote(work_dir)
            cmd.extend([f"cd {safe_dir} && claude"])

            subprocess.run(cmd, check=True)

            # Get the PID of the tmux session leader
            result = subprocess.run(
                [
                    "tmux",
                    "-S",
                    tmux_socket,
                    "list-panes",
                    "-t",
                    tmux_session,
                    "-F",
                    "#{pane_pid}",
                ],
                capture_output=True,
                text=True,
                check=True,
            )
            pid = int(result.stdout.strip())

            # Update instance with PID and status
            await self.instance_manager.update_instance(name, pid=pid, status="running")

            logger.info(
                "Started tmux instance",
                name=name,
                session=tmux_session,
                pid=pid,
                cwd=work_dir,
            )

            return {
                "success": True,
                "name": name,
                "type": "tmux",
                "session": tmux_session,
                "pid": pid,
                "cwd": work_dir,
            }

        except subprocess.CalledProcessError as e:
            logger.error("Failed to start tmux session", error=str(e))
            await self.instance_manager.delete_instance(name)
            raise RuntimeError(f"Failed to start tmux session: {e}") from e

    async def start_docker_instance(self, name: str) -> dict:
        """
        Start a Docker-based Claude instance.

        This discovers an existing Docker container with the cc-bridge.instance
        label and starts it if it's not already running.

        Args:
            name: Instance name (must match container label)

        Returns:
            Dictionary with success status and instance details

        Raises:
            RuntimeError: If Docker is not available or container not found
        """
        if not is_docker_available():
            raise RuntimeError("Docker is not available")

        # Try to discover the instance
        discovered = await self.instance_manager.refresh_discovery()
        target_instance = next((inst for inst in discovered if inst.name == name), None)

        if not target_instance:
            raise RuntimeError(
                f"No Docker container found for instance '{name}'. "
                f"Create a container with the cc-bridge.instance label first."
            )

        # Check if we need to start it
        status = await self.instance_manager.aget_instance_status(name)
        if status != "running":
            logger.info("Starting Docker container", name=name, status=status)

            from cc_bridge.core.docker_compat import get_docker_client

            client = get_docker_client()
            container = client.containers.get(target_instance.container_id)
            container.start()

            logger.info("Started Docker instance", name=name)

        return {
            "success": True,
            "name": name,
            "type": "docker",
            "container_id": target_instance.container_id,
        }

    async def start_instance(
        self,
        name: str,
        cwd: str | None = None,
        instance_type: str = "auto",
        attach_immediately: bool = False,
    ) -> dict:
        """
        High-level method to start an instance (handles existence checks).

        Args:
            name: Instance name
            cwd: Working directory
            instance_type: "tmux", "docker", or "auto"
            attach_immediately: For tmux, whether to return attach info

        Returns:
            Result dictionary

        Raises:
            RuntimeError: If status check or start fails
            ValueError: If instance is already running
        """
        from cc_bridge.core.instance_lifecycle import detect_instance_type

        # Check if instance already exists
        existing_instance = self.instance_manager.get_instance(name)
        if existing_instance:
            status = await self.instance_manager.aget_instance_status(name)
            if status == "running":
                raise ValueError(f"Instance '{name}' is already running.")
            else:
                # Instance exists but is stopped, clean up metadata
                logger.debug(f"Cleaning up metadata for stopped instance '{name}'")
                await self.instance_manager.delete_instance(name)

        # Detect instance type
        detected_type = detect_instance_type(instance_type, existing_instance)

        if detected_type == "docker":
            return await self.start_docker_instance(name)
        else:
            return await self.start_tmux_instance(name, cwd)

    async def stop_instance(self, name: str) -> dict:
        """
        High-level method to stop an instance.

        Args:
            name: Instance name

        Returns:
            Result dictionary

        Raises:
            RuntimeError: If stop fails
            ValueError: If instance not found
        """
        instance = self.instance_manager.get_instance(name)
        if not instance:
            raise ValueError(f"Instance '{name}' not found.")

        instance_type = getattr(instance, "instance_type", "tmux")

        if instance_type == "docker":
            return await self.stop_docker_instance(name, instance.container_id or "")
        else:
            return await self.stop_tmux_instance(name, instance.tmux_session or "")

    async def restart_instance(self, name: str) -> dict:
        """
        High-level method to restart an instance.

        Args:
            name: Instance name

        Returns:
            Result dictionary
        """
        instance = self.instance_manager.get_instance(name)
        if not instance:
            raise ValueError(f"Instance '{name}' not found.")

        cwd = instance.cwd
        instance_type = instance.instance_type
        status = await self.instance_manager.aget_instance_status(name)

        if status == "running":
            await self.stop_instance(name)

        return await self.start_instance(name, cwd=cwd, instance_type=instance_type)

    async def stop_tmux_instance(self, name: str, tmux_session: str) -> dict:
        """
        Stop a tmux-based Claude instance.

        Args:
            name: Instance name
            tmux_session: tmux session name

        Returns:
            Dictionary with success status

        Raises:
            RuntimeError: If stopping fails
        """
        tmux_socket = get_tmux_socket_path()

        # Check if tmux session actually exists
        session_exists = check_tmux_session_exists(tmux_session, tmux_socket)

        if session_exists:
            try:
                # Kill tmux session
                subprocess.run(
                    ["tmux", "-S", tmux_socket, "kill-session", "-t", tmux_session],
                    check=True,
                )

                # Remove instance metadata
                await self.instance_manager.delete_instance(name)

                logger.info("Stopped tmux instance", name=name, session=tmux_session)

                return {"success": True, "name": name, "type": "tmux"}

            except subprocess.CalledProcessError as e:
                logger.error("Failed to stop tmux session", error=str(e))
                raise RuntimeError(f"Failed to stop tmux session: {e}") from e
        else:
            # Session doesn't exist, just remove metadata
            logger.info(
                "Tmux session not found, removing metadata only",
                name=name,
                session=tmux_session,
            )
            await self.instance_manager.delete_instance(name)

            return {
                "success": True,
                "name": name,
                "type": "tmux",
                "session_existed": False,
            }

    async def stop_docker_instance(self, name: str, container_id: str) -> dict:
        """
        Stop a Docker-based Claude instance.

        Args:
            name: Instance name
            container_id: Docker container ID

        Returns:
            Dictionary with success status

        Raises:
            RuntimeError: If stopping fails
        """
        if not is_docker_available():
            raise RuntimeError("Docker is not available")

        try:
            from cc_bridge.core.docker_compat import get_docker_client

            client = get_docker_client()
            container = client.containers.get(container_id)

            # Stop the container
            container.stop()

            # Remove instance metadata
            await self.instance_manager.delete_instance(name)

            logger.info("Stopped Docker instance", name=name, container_id=container_id)

            return {"success": True, "name": name, "type": "docker"}

        except Exception as e:
            logger.error("Failed to stop Docker container", error=str(e))
            raise RuntimeError(f"Failed to stop container: {e}") from e


# Convenience functions for backward compatibility


def check_tmux_session_exists(session_name: str, tmux_socket: str) -> bool:
    """
    Check if a tmux session exists.

    Args:
        session_name: tmux session name to check
        tmux_socket: Path to tmux socket

    Returns:
        True if session exists, False otherwise
    """
    try:
        result = subprocess.run(
            ["tmux", "-S", tmux_socket, "list-sessions"],
            capture_output=True,
            text=True,
            check=False,
        )
        return result.stdout is not None and session_name in result.stdout
    except Exception:
        return False


async def start_tmux_instance(
    name: str,
    instance_manager: InstanceManager,
    cwd: str | None = None,
    tmux_session: str | None = None,
) -> dict:
    """
    Convenience function to start a tmux instance.

    Args:
        name: Instance name
        instance_manager: Instance manager
        cwd: Working directory
        tmux_session: tmux session name

    Returns:
        Result dictionary from InstanceOperations.start_tmux_instance
    """
    ops = InstanceOperations(instance_manager)
    return await ops.start_tmux_instance(name, cwd, tmux_session)


async def start_docker_instance(name: str, instance_manager: InstanceManager) -> dict:
    """
    Convenience function to start a Docker instance.

    Args:
        name: Instance name
        instance_manager: Instance manager

    Returns:
        Result dictionary from InstanceOperations.start_docker_instance
    """
    ops = InstanceOperations(instance_manager)
    return await ops.start_docker_instance(name)


async def stop_tmux_instance(
    name: str,
    instance_manager: InstanceManager,
    tmux_session: str,
) -> dict:
    """
    Convenience function to stop a tmux instance.

    Args:
        name: Instance name
        instance_manager: Instance manager
        tmux_session: tmux session name

    Returns:
        Result dictionary from InstanceOperations.stop_tmux_instance
    """
    ops = InstanceOperations(instance_manager)
    return await ops.stop_tmux_instance(name, tmux_session)


async def stop_docker_instance(
    name: str, instance_manager: InstanceManager, container_id: str
) -> dict:
    """
    Convenience function to stop a Docker instance.

    Args:
        name: Instance name
        instance_manager: Instance manager
        container_id: Docker container ID

    Returns:
        Result dictionary from InstanceOperations.stop_docker_instance
    """
    ops = InstanceOperations(instance_manager)
    return await ops.stop_docker_instance(name, container_id)
