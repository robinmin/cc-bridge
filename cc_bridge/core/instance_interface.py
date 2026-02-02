"""
Abstract interface for Claude instance adapters.

This module defines the polymorphic interface for interacting with
different types of Claude instances (tmux, Docker, etc.).
"""

import asyncio
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from typing import Any

from cc_bridge.logging import get_logger
from cc_bridge.models.instances import ClaudeInstance

logger = get_logger(__name__)


class InstanceInterface(ABC):
    """
    Abstract base class for Claude instance adapters.

    This interface defines the contract for all instance types,
    allowing polymorphic handling of tmux and Docker instances.
    """

    def __init__(self, instance: ClaudeInstance):
        """
        Initialize instance adapter.

        Args:
            instance: ClaudeInstance record
        """
        self.instance = instance
        self.logger = get_logger(__name__)

    @abstractmethod
    async def send_command(self, text: str) -> AsyncIterator[str]:
        """
        Send a command to the instance and stream the response.

        Args:
            text: Command text to send

        Yields:
            Response chunks as they arrive

        Raises:
            InstanceOperationError: If command fails
        """
        pass

    @abstractmethod
    async def send_command_and_wait(self, text: str, timeout: float = 30.0) -> tuple[bool, str]:
        """
        Send a command and wait for completion.

        Args:
            text: Command text to send
            timeout: Maximum time to wait in seconds

        Returns:
            Tuple of (success: bool, output: str)
        """
        pass

    @abstractmethod
    def is_running(self) -> bool:
        """
        Check if the instance is currently running.

        Returns:
            True if instance is running, False otherwise
        """
        pass

    @abstractmethod
    def get_info(self) -> dict[str, Any]:
        """
        Get instance metadata and information.

        Returns:
            Dictionary with instance information
        """
        pass

    @abstractmethod
    def cleanup(self) -> None:
        """
        Release resources held by this adapter.

        Called when adapter is no longer needed.
        """
        pass


class InstanceOperationError(Exception):
    """Base exception for instance operation errors."""

    def __init__(self, message: str, instance_name: str, original_error: Exception | None = None):
        """
        Initialize instance operation error.

        Args:
            message: Error message
            instance_name: Name of the instance
            original_error: Original exception if applicable
        """
        self.instance_name = instance_name
        self.original_error = original_error
        super().__init__(f"[{instance_name}] {message}")


class TmuxInstance(InstanceInterface):
    """
    Adapter for tmux-based Claude instances.

    Uses tmux session management to interact with Claude Code.
    """

    def __init__(self, instance: ClaudeInstance):
        """
        Initialize tmux instance adapter.

        Args:
            instance: ClaudeInstance with instance_type="tmux"
        """
        super().__init__(instance)
        if instance.instance_type != "tmux":
            raise InstanceOperationError(
                f"Expected tmux instance, got {instance.instance_type}",
                instance.name,
            )
        if instance.tmux_session is None:
            raise InstanceOperationError(
                "tmux_session cannot be None for tmux instance",
                instance.name,
            )
        self.tmux_session: str = instance.tmux_session

    async def send_command(self, text: str) -> AsyncIterator[str]:  # type: ignore[override]
        """Send command to tmux session and stream response."""
        from cc_bridge.core.tmux import TmuxSession

        session = TmuxSession(session_name=self.tmux_session)
        success, output = await session.send_command_and_wait(text)

        if success:
            yield output
        else:
            raise InstanceOperationError(
                f"Command failed: {output}",
                self.instance.name,
            )

    async def send_command_and_wait(
        self,
        text: str,
        timeout: float = 30.0,
    ) -> tuple[bool, str]:
        """Send command to tmux session and wait for completion."""
        from cc_bridge.core.tmux import TmuxSession

        session = TmuxSession(session_name=self.tmux_session)
        return await session.send_command_and_wait(text, timeout)

    def is_running(self) -> bool:
        """Check if tmux session is running."""
        from cc_bridge.core.tmux import TmuxSession

        session = TmuxSession(session_name=self.tmux_session)
        return session.session_exists()

    def get_info(self) -> dict[str, Any]:
        """Get tmux instance information."""
        from cc_bridge.core.tmux import TmuxSession

        session = TmuxSession(session_name=self.tmux_session)

        return {
            "type": "tmux",
            "name": self.instance.name,
            "session": self.tmux_session,
            "pid": self.instance.pid,
            "cwd": self.instance.cwd,
            "status": "running" if session.session_exists() else "stopped",
        }

    def cleanup(self) -> None:
        """No resources to clean up for tmux instances."""
        pass


class DockerInstance(InstanceInterface):
    """
    Adapter for Docker-based Claude instances.

    Uses 'docker exec' streams to communicate with the containerized agent.
    """

    def __init__(
        self,
        instance: ClaudeInstance,
        _pipe_dir: str | None = None,
    ):
        """
        Initialize Docker instance adapter.

        Args:
            instance: ClaudeInstance with instance_type="docker"
            pipe_dir: (Deprecated) Directory containing named pipe files
        """
        super().__init__(instance)
        if instance.instance_type != "docker":
            raise InstanceOperationError(
                f"Expected docker instance, got {instance.instance_type}",
                instance.name,
            )

        self.docker_client = None
        self.process: asyncio.subprocess.Process | None = None
        self._lock = asyncio.Lock()
        self._background_tasks: set[asyncio.Task] = set()

    async def _ensure_process(self) -> None:
        """Ensure the 'docker exec' process is running."""
        async with self._lock:
            if self.process is not None:
                if self.process.returncode is None:
                    return
                self.process = None

            self.logger.info(f"Starting 'docker exec' for container {self.instance.container_id}")

            # Start the container agent via docker exec
            # We set PYTHONPATH to ensure it uses the volume-mounted code
            # Capture stderr to help debug agent communication
            self.process = await asyncio.create_subprocess_exec(
                "docker",
                "exec",
                "-i",
                "-e",
                "PYTHONPATH=.",
                str(self.instance.container_id),
                "python3",
                "-m",
                "cc_bridge.agents.container_agent",
                "--log-level",
                "DEBUG",
                "--claude-args=--allow-dangerously-skip-permissions",
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            # Start a task to relay agent stderr to our logger
            task = asyncio.create_task(self._relay_agent_stderr())
            self._background_tasks.add(task)
            task.add_done_callback(self._background_tasks.discard)

    async def _relay_agent_stderr(self) -> None:
        """Relay agent stderr to the main server logs."""
        if not self.process or not self.process.stderr:
            return

        try:
            while True:
                line = await self.process.stderr.readline()
                if not line:
                    break

                log_line = line.decode("utf-8", errors="ignore").strip()
                if log_line:
                    self.logger.info(f"[AGENT] {log_line}")

        except Exception as e:
            self.logger.error(f"Error relaying agent stderr: {e}")

    async def send_command(self, text: str) -> AsyncIterator[str]:  # type: ignore[override]
        """Send command to Docker container via exec stream."""
        if not self.is_running():
            raise InstanceOperationError(
                "Container is not running",
                self.instance.name,
            )

        await self._ensure_process()

        if not self.process or not self.process.stdin or not self.process.stdout:
            raise InstanceOperationError(
                "Failed to establish communication stream",
                self.instance.name,
            )

        try:
            # Send command to agent stdin
            data = (text + "\n").encode("utf-8")
            self.process.stdin.write(data)
            await self.process.stdin.drain()

            # Read response from agent stdout
            while True:
                # Use chunked read instead of readline to avoid hangs on non-newline output
                chunk = await asyncio.wait_for(self.process.stdout.read(1024), timeout=30.0)
                if not chunk:
                    break

                yield chunk.decode("utf-8", errors="ignore")

                if self.process.returncode is not None:
                    break

        except asyncio.TimeoutError:
            self.logger.warning("Read from exec stream timed out")
        except Exception as e:
            self.logger.error(f"Error in exec stream: {e}")
            raise InstanceOperationError(
                f"Command failed: {e}",
                self.instance.name,
                e,
            ) from e

    async def send_command_and_wait(self, text: str, timeout: float = 30.0) -> tuple[bool, str]:  # noqa: ARG002
        """Send command to Docker container and wait for completion."""
        try:
            output_parts = []
            async for line in self.send_command(text):
                output_parts.append(line)

            output = "".join(output_parts)
            return True, output

        except Exception as e:
            return False, str(e)

    def is_running(self) -> bool:
        """Check if Docker container is running."""
        if not self.docker_client:
            return False

        try:
            container = self.docker_client.containers.get(self.instance.container_id)
            return container.status == "running"
        except Exception:
            return False

    def get_info(self) -> dict[str, Any]:
        """Get Docker container information."""
        if not self.docker_client:
            return {
                "type": "docker",
                "name": self.instance.name,
                "status": "error",
                "error": "Docker client not available",
            }

        try:
            container = self.docker_client.containers.get(self.instance.container_id)
            attrs = container.attrs

            return {
                "type": "docker",
                "name": self.instance.name,
                "container_id": self.instance.container_id,
                "container_name": self.instance.container_name,
                "image_name": self.instance.image_name,
                "network": self.instance.docker_network,
                "status": container.status,
                "created": attrs.get("Created"),
                "ports": attrs.get("NetworkSettings", {}).get("Ports", {}),
            }
        except Exception as e:
            return {
                "type": "docker",
                "name": self.instance.name,
                "status": "error",
                "error": str(e),
            }

    def cleanup(self) -> None:
        """Clean up exec process."""
        if self.process:
            import contextlib

            with contextlib.suppress(Exception):
                self.process.terminate()


def get_instance_adapter(instance: ClaudeInstance) -> InstanceInterface:
    """
    Factory function to create appropriate instance adapter.

    Args:
        instance: ClaudeInstance record

    Returns:
        InstanceInterface adapter for the instance type

    Raises:
        ValueError: If instance type is unknown
    """
    if instance.instance_type == "tmux":
        return TmuxInstance(instance)
    elif instance.instance_type == "docker":
        return DockerInstance(instance)
    else:
        raise ValueError(f"Unknown instance type: {instance.instance_type}")


__all__ = [
    "DockerInstance",
    "InstanceInterface",
    "InstanceOperationError",
    "TmuxInstance",
    "get_instance_adapter",
]
