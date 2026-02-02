"""
Abstract interface for Claude instance adapters.

This module defines the polymorphic interface for interacting with
different types of Claude instances (tmux, Docker, etc.).
"""

import asyncio
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from typing import Any

from cc_bridge.models.instances import ClaudeInstance
from cc_bridge.packages.logging import get_logger

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
    async def start(self) -> bool:
        """
        Start the instance if it is not running.

        Returns:
            True if instance is now running, False otherwise
        """
        pass

    @abstractmethod
    async def interrupt(self) -> bool:
        """
        Send an interrupt (Ctrl+C) to the instance.

        Returns:
            True if successful, False otherwise
        """
        pass

    @abstractmethod
    async def clear_conversation(self) -> bool:
        """
        Clear the conversation history.

        Returns:
            True if successful, False otherwise
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

    async def start(self) -> bool:
        """Start the tmux session."""
        if self.is_running():
            return True

        self.logger.info(f"Attempting to start tmux session '{self.tmux_session}'")

        # We can't easily call _start_tmux_instance from here without
        # circular imports or moving logic.
        # For now, we'll try to run the command directly via shell if possible,
        # but tmux instances are usually started via CLI.
        # A better way is to implement this in a shared core module.
        self.logger.warning(
            "Auto-start for tmux instances is not yet fully implemented in the adapter"
        )
        return False

    async def interrupt(self) -> bool:
        """Send Ctrl+C to tmux session."""
        from cc_bridge.core.tmux import TmuxSession

        session = TmuxSession(session_name=self.tmux_session)
        return session.send_keys("C-C")

    async def clear_conversation(self) -> bool:
        """Send /clear to Claude in tmux."""
        from cc_bridge.core.tmux import TmuxSession

        session = TmuxSession(session_name=self.tmux_session)
        # Send /clear command
        return session.send_command("/clear")

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

    Supports two communication modes:
    - fifo: Uses named pipes for bidirectional communication with daemon agent
    - exec: Uses 'docker exec' streams (legacy mode)
    """

    def __init__(
        self,
        instance: ClaudeInstance,
        pipe_dir: str | None = None,
    ):
        """
        Initialize Docker instance adapter.

        Args:
            instance: ClaudeInstance with instance_type="docker"
            pipe_dir: Directory containing named pipe files (default: from config)
        """
        super().__init__(instance)
        if instance.instance_type != "docker":
            raise InstanceOperationError(
                f"Expected docker instance, got {instance.instance_type}",
                instance.name,
            )

        # Import here to avoid circular dependency
        from cc_bridge.config import get_config

        config = get_config()

        # Determine communication mode (from instance or config default)
        self.communication_mode = instance.communication_mode or config.get("docker", {}).get(
            "communication_mode", "fifo"
        )

        # Pipe directory for FIFO communication
        self.pipe_dir = pipe_dir or config.get("docker", {}).get("pipe_dir", "/tmp/cc-bridge/pipes")

        # Expand ${PROJECT_NAME} in pipe_dir
        project_name = config.get("project_name", "cc-bridge")
        self.pipe_dir = self.pipe_dir.replace("${PROJECT_NAME}", project_name)

        self.docker_client = None
        try:
            from cc_bridge.core.docker_compat import get_docker_client

            self.docker_client = get_docker_client()
        except Exception as e:
            self.logger.warning(f"Failed to initialize Docker client: {e}")

        self.process: asyncio.subprocess.Process | None = None
        self._lock = asyncio.Lock()
        self._background_tasks: set[asyncio.Task] = set()

        # FIFO communication components
        self._pipe_channel = None
        self._fifo_initialized = False

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

    async def _ensure_fifo_initialized(self) -> None:
        """Ensure FIFO pipes are created and ready."""
        if self._fifo_initialized:
            return

        from cc_bridge.core.named_pipe import NamedPipeChannel

        self._pipe_channel = NamedPipeChannel(
            instance_name=self.instance.name,
            pipe_dir=self.pipe_dir,
        )
        self._pipe_channel.create_pipes()
        self._fifo_initialized = True
        self.logger.info(
            f"FIFO pipes created: {self._pipe_channel.input_pipe_path}, "
            f"{self._pipe_channel.output_pipe_path}"
        )

    async def _send_command_fifo(self, text: str) -> AsyncIterator[str]:
        """Send command via named pipes (daemon mode) with session tracking."""
        if not self.is_running():
            raise InstanceOperationError(
                "Container is not running",
                self.instance.name,
            )

        await self._ensure_fifo_initialized()

        if not self._pipe_channel:
            raise InstanceOperationError(
                "FIFO channel not initialized",
                self.instance.name,
            )

        # Import session tracker for FIFO mode
        from cc_bridge.core.session_tracker import get_session_tracker

        session_tracker = get_session_tracker()
        request_id = None
        response_buffer = []

        try:
            # Start request in session tracker
            request_id, session = await session_tracker.start_request(self.instance.name, text)

            # Send command and stream response via FIFO
            async for line in self._pipe_channel.send_and_receive(
                command=text,
                timeout=60.0,  # Longer timeout for daemon mode
            ):
                response_buffer.append(line)
                yield line

            # Complete request successfully
            await session_tracker.complete_request(
                self.instance.name,
                request_id,
                "".join(response_buffer),
                error=None,
            )

        except asyncio.TimeoutError:
            self.logger.warning("FIFO communication timed out")
            # Complete request with error
            if request_id:
                await session_tracker.complete_request(
                    self.instance.name,
                    request_id,
                    "".join(response_buffer),
                    error="Request timeout",
                )
            raise InstanceOperationError(
                "FIFO communication timed out",
                self.instance.name,
            ) from None
        except Exception as e:
            self.logger.error(f"FIFO communication error: {e}")
            # Complete request with error
            if request_id:
                await session_tracker.complete_request(
                    self.instance.name,
                    request_id,
                    "".join(response_buffer),
                    error=str(e),
                )
            raise InstanceOperationError(
                f"FIFO command failed: {e}",
                self.instance.name,
                e,
            ) from e

    async def _send_command_exec(self, text: str) -> AsyncIterator[str]:
        """Send command via docker exec (legacy mode)."""
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

    async def send_command(self, text: str) -> AsyncIterator[str]:  # type: ignore[override]
        """Send command to Docker container via configured communication mode."""
        # Route to appropriate implementation based on communication mode
        if self.communication_mode == "fifo":
            self.logger.debug(f"Using FIFO mode for command to {self.instance.name}")
            async for line in self._send_command_fifo(text):
                yield line
        else:  # exec mode (legacy)
            self.logger.debug(f"Using exec mode for command to {self.instance.name}")
            async for line in self._send_command_exec(text):
                yield line

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
            # Try once more to initialize
            try:
                from cc_bridge.core.docker_compat import get_docker_client

                self.docker_client = get_docker_client()
            except Exception:
                return False

        if not self.docker_client:
            return False

        try:
            container = self.docker_client.containers.get(self.instance.container_id)
            return container.status == "running"
        except Exception:
            return False

    async def start(self) -> bool:
        """Start the Docker container."""
        async with self._lock:
            if self.is_running():
                return True

            if not self.docker_client:
                return False

            self.logger.info(f"Attempting to start Docker container {self.instance.container_id}")
            try:
                container = self.docker_client.containers.get(self.instance.container_id)
                container.start()
                # Wait a moment for status to update
                await asyncio.sleep(1)
                # Refresh container status
                container.reload()
                return container.status == "running"
            except Exception as e:
                self.logger.error(f"Failed to start Docker container: {e}")
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

            info = {
                "type": "docker",
                "name": self.instance.name,
                "container_id": self.instance.container_id,
                "container_name": self.instance.container_name,
                "image_name": self.instance.image_name,
                "network": self.instance.docker_network,
                "status": container.status,
                "communication_mode": self.communication_mode,
                "pipe_dir": self.pipe_dir if self.communication_mode == "fifo" else None,
                "fifo_initialized": self._fifo_initialized,
                "created": attrs.get("Created"),
                "ports": attrs.get("NetworkSettings", {}).get("Ports", {}),
            }

            # Add session state if in FIFO mode
            if self.communication_mode == "fifo":
                import asyncio

                async def get_session_state():
                    from cc_bridge.core.session_tracker import get_session_tracker

                    session_tracker = get_session_tracker()
                    return await session_tracker.get_status(self.instance.name)

                # Try to get session state (may fail in sync context)
                try:
                    loop = asyncio.get_running_loop()
                    task = loop.create_task(get_session_state())
                    session_info = loop.run_until_complete(task)
                    if session_info:
                        info["session"] = session_info
                except RuntimeError:
                    # No event loop running, skip session info
                    pass

            return info
        except Exception as e:
            return {
                "type": "docker",
                "name": self.instance.name,
                "status": "error",
                "error": str(e),
            }

    async def interrupt(self) -> bool:
        """Send Ctrl+C to Docker container process."""
        if self.communication_mode == "fifo":
            # In FIFO mode, we send the raw Ctrl+C character
            try:
                # \x03 is the ASCII character for Ctrl+C
                if self._pipe_channel is not None:
                    await self._pipe_channel.write_raw(b"\x03")  # type: ignore[union-attr]
                    return True
                return False
            except Exception as e:
                self.logger.error(f"Failed to send interrupt to FIFO: {e}")
                return False
        else:
            # In exec mode, we send it to the process stdin
            await self._ensure_process()
            if self.process and self.process.stdin:
                try:
                    self.process.stdin.write(b"\x03")
                    await self.process.stdin.drain()
                    return True
                except Exception as e:
                    self.logger.error(f"Failed to send interrupt to exec stdin: {e}")
                    return False
            return False

    async def clear_conversation(self) -> bool:
        """Send /clear command to Claude in Docker."""
        try:
            async for _ in self.send_command("/clear"):
                pass
            return True
        except Exception:
            return False

    async def get_session_info(self) -> dict[str, Any] | None:
        """Get session state information for FIFO mode instances."""
        if self.communication_mode != "fifo":
            return None

        from cc_bridge.core.session_tracker import get_session_tracker

        session_tracker = get_session_tracker()
        return await session_tracker.get_status(self.instance.name)

    async def get_session_history(self, limit: int = 10) -> list[dict[str, Any]]:
        """Get conversation history for FIFO mode instances."""
        if self.communication_mode != "fifo":
            return []

        from cc_bridge.core.session_tracker import get_session_tracker

        session_tracker = get_session_tracker()
        return await session_tracker.get_history(self.instance.name, limit)

    def cleanup(self) -> None:
        """Clean up exec process, FIFO pipes, and session state."""
        # Clean up exec process
        if self.process:
            import contextlib

            with contextlib.suppress(Exception):
                self.process.terminate()

        # Clean up FIFO pipes
        if self._pipe_channel:
            import contextlib

            with contextlib.suppress(Exception):
                self._pipe_channel.close()
            self._fifo_initialized = False
            self.logger.info("FIFO pipes cleaned up")

        # Clean up session state (async cleanup in sync context)
        if self.communication_mode == "fifo":
            import asyncio
            import contextlib

            async def _cleanup_session():
                from cc_bridge.core.session_tracker import get_session_tracker

                session_tracker = get_session_tracker()
                await session_tracker.remove_session(self.instance.name)
                self.logger.info(f"Session cleaned up for {self.instance.name}")

            # Try to run async cleanup if loop is available
            with contextlib.suppress(RuntimeError):
                asyncio.get_running_loop().create_task(_cleanup_session())
                # Don't wait for cleanup, just schedule it


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
