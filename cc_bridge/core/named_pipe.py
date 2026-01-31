"""
Named Pipe (FIFO) communication channel for Docker containers.

This module provides bi-directional communication between the host system
and containerized Claude Code instances using Unix named pipes.
"""

import asyncio
import errno
import os
import warnings
from collections.abc import AsyncIterator
from contextlib import AbstractAsyncContextManager as AsyncContextManagerType
from pathlib import Path
from types import TracebackType

from cc_bridge.logging import get_logger

logger = get_logger(__name__)


class NamedPipeChannel(AsyncContextManagerType["NamedPipeChannel"]):
    """
    Bi-directional named pipe communication channel.

    Uses two FIFO pipes per instance:
    - {instance}.in.fifo - Host writes commands, container reads
    - {instance}.out.fifo - Container writes responses, host reads

    Note:
        This class supports both sync and async context managers.
        Prefer async context manager (`async with`) for async code.
    """

    def __init__(
        self,
        instance_name: str,
        pipe_dir: str = "/tmp/cc-bridge-pipes",
    ):
        """
        Initialize named pipe channel.

        Args:
            instance_name: Name of the Claude instance
            pipe_dir: Directory containing the pipe files
        """
        self.instance_name = instance_name
        self.pipe_dir = Path(pipe_dir)
        self.input_pipe_path = self.pipe_dir / f"{instance_name}.in.fifo"
        self.output_pipe_path = self.pipe_dir / f"{instance_name}.out.fifo"
        self.logger = get_logger(__name__)
        self._input_fd: int | None = None
        self._output_fd: int | None = None
        self._pipes_created = False

    def create_pipes(self) -> None:
        """
        Create the named pipe files.

        Creates the pipe directory and both FIFO files if they don't exist.
        Removes existing pipes if present.
        """
        self.pipe_dir.mkdir(parents=True, exist_ok=True)

        for pipe_path in [self.input_pipe_path, self.output_pipe_path]:
            if pipe_path.exists():
                # Remove existing pipe
                pipe_path.unlink()

            try:
                os.mkfifo(pipe_path, mode=0o660)
                self.logger.debug(f"Created named pipe: {pipe_path}")
            except OSError as e:
                raise RuntimeError(f"Failed to create pipe {pipe_path}: {e}") from e

        self._pipes_created = True
        self.logger.info(f"Named pipes created: {self.input_pipe_path}, {self.output_pipe_path}")

    async def write_command(self, text: str, timeout: float = 30.0) -> None:
        """
        Write a command to the input pipe.

        Opens the pipe for writing, writes the command, and closes.
        Uses async polling with timeout to avoid deadlock.

        Args:
            text: Command text to write
            timeout: Maximum time to wait for reader (seconds)

        Raises:
            RuntimeError: If pipe doesn't exist or write fails
            asyncio.TimeoutError: If no reader connects within timeout
        """
        if not self._pipes_created and not self.input_pipe_path.exists():
            raise RuntimeError("Input pipe does not exist. Call create_pipes() first.")

        self.logger.debug(f"Writing command to pipe: {text[:50]}...")

        # Use async loop to run potentially blocking operations
        loop = asyncio.get_running_loop()

        async def try_open_and_write() -> None:
            """Try to open pipe and write command with timeout."""
            start_time = loop.time()

            while True:
                try:
                    # Try non-blocking first
                    fd = await loop.run_in_executor(
                        None, lambda: os.open(self.input_pipe_path, os.O_WRONLY | os.O_NONBLOCK)
                    )

                    try:
                        # Write the command with newline
                        data = (text + "\n").encode("utf-8")
                        await loop.run_in_executor(None, lambda d=data, f=fd: os.write(f, d))
                        self.logger.debug(f"Command written successfully: {len(data)} bytes")
                        return
                    finally:
                        await loop.run_in_executor(None, lambda f=fd: os.close(f))

                except OSError as e:
                    # Check if we've exceeded timeout
                    elapsed = loop.time() - start_time
                    if elapsed > timeout:
                        raise asyncio.TimeoutError(
                            f"No reader connected to pipe {self.input_pipe_path} within {timeout}s"
                        ) from None

                    if e.errno == errno.ENXIO:
                        # No reader yet, wait and retry
                        self.logger.debug("No reader on pipe, waiting...")
                        await asyncio.sleep(0.1)
                    else:
                        raise RuntimeError(f"Failed to open pipe: {e}") from e

        try:
            await try_open_and_write()
        except asyncio.TimeoutError:
            raise
        except Exception as e:
            raise RuntimeError(f"Failed to write to pipe: {e}") from e

    async def read_response(self, timeout: float = 30.0) -> AsyncIterator[str]:
        """
        Read responses from the output pipe.

        Opens the pipe for reading and yields response chunks.
        Handles EOF when container exits.

        Args:
            timeout: Maximum time to wait for data in seconds

        Yields:
            Response lines as they arrive

        Raises:
            RuntimeError: If pipe doesn't exist or read fails
            asyncio.TimeoutError: If timeout is exceeded
        """
        if not self._pipes_created and not self.output_pipe_path.exists():
            raise RuntimeError("Output pipe does not exist. Call create_pipes() first.")

        self.logger.debug("Reading response from pipe...")

        try:
            # Open pipe for reading (non-blocking)
            fd = os.open(self.output_pipe_path, os.O_RDONLY | os.O_NONBLOCK)

            try:
                # Set up for async reading
                buffer = b""
                start_time = asyncio.get_running_loop().time()

                while True:
                    # Check timeout
                    elapsed = asyncio.get_running_loop().time() - start_time
                    if elapsed > timeout:
                        raise asyncio.TimeoutError(f"Read timeout after {timeout} seconds")

                    try:
                        # Try to read data
                        data = os.read(fd, 4096)
                        if data:
                            buffer += data
                            # Process complete lines
                            while b"\n" in buffer:
                                line, buffer = buffer.split(b"\n", 1)
                                line_str = line.decode("utf-8", errors="ignore")
                                if line_str:
                                    self.logger.debug(f"Read line: {line_str[:50]}...")
                                    yield line_str
                        else:
                            # EOF - pipe closed
                            if buffer:
                                line_str = buffer.decode("utf-8", errors="ignore")
                                if line_str:
                                    yield line_str
                            break

                    except BlockingIOError:
                        # No data available, wait a bit
                        await asyncio.sleep(0.1)

            finally:
                os.close(fd)

        except OSError as e:
            raise RuntimeError(f"Failed to read from pipe: {e}") from e

    async def send_and_receive(self, command: str, timeout: float = 30.0) -> AsyncIterator[str]:
        """
        Send command and stream response.

        Convenience method that combines write_command and read_response.

        Args:
            command: Command to send
            timeout: Maximum time to wait for response

        Yields:
            Response lines as they arrive
        """
        await self.write_command(command, timeout=timeout)
        async for line in self.read_response(timeout=timeout):
            yield line

    def close(self) -> None:
        """
        Close the named pipes and remove the pipe files.

        Should be called when the channel is no longer needed.
        """
        self.logger.info("Closing named pipe channel")

        for pipe_path in [self.input_pipe_path, self.output_pipe_path]:
            try:
                if pipe_path.exists():
                    pipe_path.unlink()
                    self.logger.debug(f"Removed pipe: {pipe_path}")
            except OSError as e:
                self.logger.warning(f"Failed to remove pipe {pipe_path}: {e}")

        # Try to remove the directory if it's empty
        try:
            if self.pipe_dir.exists() and not any(self.pipe_dir.iterdir()):
                self.pipe_dir.rmdir()
                self.logger.debug(f"Removed pipe directory: {self.pipe_dir}")
        except OSError:
            pass

        self._pipes_created = False

    def __enter__(self):
        """
        Synchronous context manager entry.

        Deprecated:
            Use async context manager (`async with`) instead.
        """
        warnings.warn(
            "Sync context manager is deprecated. Use 'async with' instead of 'with'.",
            DeprecationWarning,
            stacklevel=2,
        )
        self.create_pipes()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """
        Synchronous context manager exit.

        Deprecated:
            Use async context manager (`async with`) instead.
        """
        self.close()
        return False

    async def __aenter__(self) -> "NamedPipeChannel":
        """
        Async context manager entry.

        Returns:
            Self for use in async context manager.

        Example:
            >>> async with NamedPipeChannel("test") as channel:
            ...     await channel.send_command("hello")
        """
        self.create_pipes()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        """
        Async context manager exit with cleanup.

        Args:
            exc_type: Exception type if raised
            exc_val: Exception value if raised
            exc_tb: Exception traceback if raised
        """
        self.close()


__all__ = ["NamedPipeChannel"]
