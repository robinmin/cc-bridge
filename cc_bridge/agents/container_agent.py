#!/usr/bin/env python3
"""
Container agent script for bridging Claude Code with named pipes.

This script runs inside Docker containers and bridges communication between
the host system (via named pipes) and Claude Code (via stdin/stdout).
"""

import argparse
import asyncio
import os
import signal
import sys
from contextlib import contextmanager
from pathlib import Path

from cc_bridge.logging import get_logger, setup_logging

logger = get_logger(__name__)


@contextmanager
def open_fd(path: str | Path, flags: int):
    """
    Context manager for low-level file descriptor operations.

    Ensures file descriptors are properly closed even if exceptions occur.

    Args:
        path: Path to open
        flags: os.open() flags (e.g., os.O_RDONLY)

    Yields:
        File descriptor integer
    """
    fd = os.open(str(path), flags)
    try:
        yield fd
    finally:
        os.close(fd)


class ContainerAgent:
    """
    Agent that bridges named pipes to Claude Code stdin/stdout.

    Reads commands from input pipe, sends to Claude Code process,
    and writes responses back to output pipe.
    """

    def __init__(
        self,
        input_pipe: str,
        output_pipe: str,
        claude_args: list[str] | None = None,
    ):
        """
        Initialize container agent.

        Args:
            input_pipe: Path to input named pipe (read commands from)
            output_pipe: Path to output named pipe (write responses to)
            claude_args: Additional arguments for Claude Code
        """
        self.input_pipe_path = Path(input_pipe)
        self.output_pipe_path = Path(output_pipe)
        self.claude_args = claude_args or []
        self.logger = logger
        self.process: asyncio.subprocess.Process | None = None
        self.running = False
        self._shutdown_event = asyncio.Event()

    async def start(self) -> None:
        """Start the agent: open pipes and spawn Claude Code process."""
        self.logger.info(
            f"Starting container agent: input={self.input_pipe_path}, "
            f"output={self.output_pipe_path}"
        )

        # Verify pipes exist
        if not self.input_pipe_path.exists():
            raise RuntimeError(f"Input pipe does not exist: {self.input_pipe_path}")
        if not self.output_pipe_path.exists():
            raise RuntimeError(f"Output pipe does not exist: {self.output_pipe_path}")

        self.running = True
        self._shutdown_event.clear()

        # Start Claude Code process
        await self._spawn_claude()

        # Start pipe I/O tasks
        pipe_reader = asyncio.create_task(self._read_from_pipe())
        process_reader = asyncio.create_task(self._read_from_process())

        # Wait for shutdown signal
        await self._shutdown_event.wait()

        # Cancel tasks
        pipe_reader.cancel()
        process_reader.cancel()

        # Cleanup
        await self._cleanup()

    async def _spawn_claude(self) -> None:
        """Spawn Claude Code as a subprocess."""
        self.logger.info("Spawning Claude Code process")

        try:
            # Spawn Claude with stdin/stdout pipes
            self.process = await asyncio.create_subprocess_exec(
                "claude",
                *self.claude_args,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            self.logger.info(f"Claude Code process started: PID={self.process.pid}")

        except Exception as e:
            self.logger.error(f"Failed to spawn Claude Code: {e}")
            raise

    async def _read_from_pipe(self) -> None:
        """Read commands from input pipe and send to Claude."""
        self.logger.debug("Starting pipe reader task")

        try:
            # Open pipe for reading (blocking mode)
            loop = asyncio.get_running_loop()
            fd = await loop.run_in_executor(
                None, lambda: os.open(self.input_pipe_path, os.O_RDONLY)
            )

            try:
                buffer = b""
                while self.running:
                    try:
                        # Read data from pipe
                        data = await loop.run_in_executor(None, lambda: os.read(fd, 4096))

                        if not data:
                            # EOF - pipe closed
                            self.logger.info("Input pipe closed")
                            break

                        buffer += data

                        # Process complete lines
                        while b"\n" in buffer:
                            line, buffer = buffer.split(b"\n", 1)
                            command = line.decode("utf-8", errors="ignore")

                            if command:
                                self.logger.debug(f"Received command: {command[:50]}...")
                                await self._send_to_claude(command)

                    except Exception as e:
                        if self.running:
                            self.logger.error(f"Error reading from pipe: {e}")
                        break

            finally:
                await loop.run_in_executor(None, lambda: os.close(fd))

        except asyncio.CancelledError:
            self.logger.debug("Pipe reader task cancelled")
        except Exception as e:
            self.logger.error(f"Pipe reader task error: {e}")

    async def _send_to_claude(self, command: str) -> None:
        """Send command to Claude Code process."""
        if not self.process or not self.process.stdin:
            self.logger.warning("Cannot send command: process not available")
            return

        try:
            data = (command + "\n").encode("utf-8")
            self.process.stdin.write(data)
            await self.process.stdin.drain()
            self.logger.debug(f"Command sent to Claude: {len(data)} bytes")

        except Exception as e:
            self.logger.error(f"Failed to send command to Claude: {e}")

    async def _read_from_process(self) -> None:
        """Read output from Claude and write to output pipe."""
        self.logger.debug("Starting process reader task")

        if not self.process or not self.process.stdout:
            self.logger.warning("Cannot read from process: stdout not available")
            return

        try:
            # Open pipe for writing
            loop = asyncio.get_event_loop()
            fd = await loop.run_in_executor(
                None, lambda: os.open(self.output_pipe_path, os.O_WRONLY | os.O_NONBLOCK)
            )

            try:
                while self.running:
                    try:
                        # Read line from Claude stdout
                        line = await asyncio.wait_for(
                            self.process.stdout.readline(),
                            timeout=1.0,
                        )

                        if not line:
                            # EOF - Claude process exited
                            self.logger.info("Claude process exited")
                            break

                        response = line.decode("utf-8", errors="ignore")
                        self.logger.debug(f"Claude output: {response[:50]}...")

                        # Write to output pipe (retry if would block)
                        data = line
                        while data:
                            try:
                                written = await loop.run_in_executor(None, os.write, fd, data)
                                data = data[written:]
                            except BlockingIOError:
                                await asyncio.sleep(0.1)

                    except asyncio.TimeoutError:
                        # No data available, continue
                        continue
                    except Exception as e:
                        if self.running:
                            self.logger.error(f"Error reading from Claude: {e}")
                        break

            finally:
                await loop.run_in_executor(None, lambda: os.close(fd))

        except asyncio.CancelledError:
            self.logger.debug("Process reader task cancelled")
        except Exception as e:
            self.logger.error(f"Process reader task error: {e}")

    async def _cleanup(self) -> None:
        """Cleanup resources: stop process, close connections."""
        self.logger.info("Cleaning up agent resources")

        self.running = False

        # Stop Claude process
        if self.process:
            try:
                self.process.terminate()
                await asyncio.sleep(0.5)
                if self.process.returncode is None:
                    self.process.kill()
                await self.process.wait()
                self.logger.info("Claude process terminated")
            except Exception as e:
                self.logger.error(f"Error terminating Claude process: {e}")

    def shutdown(self) -> None:
        """Signal the agent to shutdown."""
        self.logger.info("Shutdown requested")
        self._shutdown_event.set()


def setup_signal_handlers(agent: ContainerAgent) -> None:
    """Setup signal handlers for graceful shutdown."""

    def signal_handler(signum, frame):
        logger.info(f"Received signal {signum}, initiating shutdown")
        agent.shutdown()

    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)


def main() -> int:
    """Main entry point for container agent."""

    parser = argparse.ArgumentParser(
        description="Container agent for Claude Code named pipe bridge"
    )
    parser.add_argument(
        "--input-pipe",
        default="/tmp/cc-bridge-pipes/claude.in.fifo",
        help="Path to input named pipe",
    )
    parser.add_argument(
        "--output-pipe",
        default="/tmp/cc-bridge-pipes/claude.out.fifo",
        help="Path to output named pipe",
    )
    parser.add_argument(
        "--claude-args",
        nargs="*",
        default=[],
        help="Additional arguments for Claude Code",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="Log level",
    )

    args = parser.parse_args()

    # Setup logging
    setup_logging(level=args.log_level, log_format="text")

    # Create and start agent
    agent = ContainerAgent(
        input_pipe=args.input_pipe,
        output_pipe=args.output_pipe,
        claude_args=args.claude_args,
    )

    setup_signal_handlers(agent)

    try:
        asyncio.run(agent.start())
        return 0
    except KeyboardInterrupt:
        logger.info("Interrupted by user")
        agent.shutdown()
        return 0
    except Exception as e:
        logger.exception(f"Agent failed: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
