#!/usr/bin/env python3
"""
Container agent script for bridging Claude Code with named pipes.

This script runs inside Docker containers and bridges communication between
the host system (via named pipes) and Claude Code (via stdin/stdout).
"""

import argparse
import asyncio

# Configure private logger to stderr to avoid polluting data stream (stdout)
import logging
import os
import signal
import sys
from pathlib import Path

# Private logger for this module
logger = logging.getLogger("container_agent")
logger.setLevel(logging.INFO)
# Remove any existing handlers to be sure
for h in logger.handlers[:]:
    logger.removeHandler(h)
_handler = logging.StreamHandler(sys.stderr)
_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)-8s] %(message)s"))
logger.addHandler(_handler)
# Prevent propagation to root logger just in case
logger.propagate = False


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
        claude_args: list[str] | None = None,
    ):
        """
        Initialize container agent.

        Args:
            claude_args: Additional arguments for Claude Code
        """
        self.claude_args = claude_args or []
        self.logger = logger
        self.process: asyncio.subprocess.Process | None = None
        self.running = False
        self._shutdown_event = asyncio.Event()

    async def start(self) -> None:
        """Start the agent: spawn Claude Code process."""
        self.logger.info("Starting container agent with standard I/O")

        self.running = True
        self._shutdown_event.clear()

        # Start Claude Code process
        await self._spawn_claude()

        # Start stdin/stdout I/O tasks
        stdin_reader = asyncio.create_task(self._read_from_stdin())
        process_reader = asyncio.create_task(self._read_from_process())

        # Wait for shutdown signal or process exit
        await self._shutdown_event.wait()

        # Cancel tasks
        stdin_reader.cancel()
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

    async def _read_from_stdin(self) -> None:
        """Read commands from stdin and send to Claude."""
        self.logger.debug("Starting stdin reader task")

        loop = asyncio.get_running_loop()
        queue = asyncio.Queue()

        # Use a separate thread for blocking stdin.readline()
        # as sys.stdin is not easily made async-ready on all platforms
        async def stdin_reader():
            while self.running:
                line = await loop.run_in_executor(None, sys.stdin.readline)
                if not line:
                    await queue.put(None)
                    break
                await queue.put(line)

        reader_task = asyncio.create_task(stdin_reader())

        try:
            while self.running:
                line = await queue.get()
                if line is None:
                    self.logger.info("Stdin reached EOF")
                    break

                command = line.strip()
                if command:
                    self.logger.info(f"Received command from host: {command[:50]}...")
                    await self._send_to_claude(command)

        except asyncio.CancelledError:
            self.logger.debug("Stdin reader task cancelled")
        except Exception as e:
            self.logger.error(f"Stdin reader task error: {e}")
        finally:
            reader_task.cancel()
            self.shutdown()

    async def _send_to_claude(self, command: str) -> None:
        """Run Claude in print mode with session continuity and relay output."""
        self.logger.info(f"Running Claude in print mode: {command[:50]}...")

        try:
            # Build arguments: continue session + print mode + global args + user command
            # Note: flags must precede the command string (-c)
            args = ["-p", *self.claude_args, "-c", command]

            # Start transient Claude process
            proc = await asyncio.create_subprocess_exec(
                "claude",
                *args,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            # Task to relay stderr to help debugging
            async def relay_stderr():
                if not proc.stderr:
                    return
                try:
                    while True:
                        # Use chunked read for stderr too
                        chunk = await proc.stderr.read(1024)
                        if not chunk:
                            break
                        log_line = chunk.decode("utf-8", errors="ignore").strip()
                        if log_line:
                            self.logger.info(f"[CLAUDE-STDERR] {log_line}")
                except Exception as e:
                    self.logger.error(f"Error in stderr relay: {e}")

            stderr_task = asyncio.create_task(relay_stderr())

            # Read and relay stdout
            if proc.stdout:
                try:
                    while True:
                        # Use chunked read instead of readline to avoid newline hangs
                        chunk = await proc.stdout.read(1024)
                        if not chunk:
                            break

                        sys.stdout.buffer.write(chunk)
                        sys.stdout.buffer.flush()
                        self.logger.info(f"Relayed {len(chunk)} bytes to host stdout")
                except Exception as e:
                    self.logger.error(f"Error in stdout relay: {e}")

            await proc.wait()
            self.logger.info(f"Claude process finished with code {proc.returncode}")
            stderr_task.cancel()

        except Exception as e:
            self.logger.error(f"Failed to execute Claude command: {e}")

    async def _read_from_process(self) -> None:
        """Legacy method (no longer used in print-mode refactor)."""
        pass

    async def _cleanup(self) -> None:
        """Cleanup resources: stop process."""
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
        if not self.running:
            return
        self.logger.info("Shutdown requested")
        self.running = False
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
        description="Container agent for Claude Code Docker Exec bridge"
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

    # Keep compatibility with old pipe arguments (ignore them)
    parser.add_argument("--input-pipe", help=argparse.SUPPRESS)
    parser.add_argument("--output-pipe", help=argparse.SUPPRESS)

    args = parser.parse_args()

    # Setup logging (stderr to not interfere with stdout I/O)
    if args.log_level:
        logger.setLevel(getattr(logging, args.log_level.upper()))

    # Create and start agent
    agent = ContainerAgent(
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
