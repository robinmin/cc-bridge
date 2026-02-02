#!/usr/bin/env python3
"""
Container agent script for bridging Claude Code with named pipes.

This script runs inside Docker containers and bridges communication between
the host system (via stdin/stdout) and Claude Code (in persistent normal mode).

IMPORTANT: Runs Claude Code in persistent normal mode with
--dangerously-skip-permissions for Docker resource isolation security.
"""

import argparse
import asyncio
import json
import logging
import signal
import sys
import time

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


class ClaudeProcessManager:
    """
    Manages a persistent Claude Code process in normal mode.

    Handles process spawning, health monitoring, crash recovery,
    and graceful shutdown with --dangerously-skip-permissions.
    """

    def __init__(
        self,
        claude_args: list[str] | None = None,
        log_level: str = "INFO",
    ):
        """
        Initialize the Claude process manager.

        Args:
            claude_args: Additional arguments for Claude Code
            log_level: Logging level
        """
        self.claude_args = claude_args or []
        self.log_level = log_level
        self.logger = logger

        # Process management
        self.process: asyncio.subprocess.Process | None = None
        self._running = False
        self._background_tasks: set[asyncio.Task] = set()

        # Health monitoring
        self._health_check_interval = 5.0
        self._last_health_check = 0.0
        self._last_activity = time.time()

        # Crash recovery with exponential backoff
        self._restart_count = 0
        self._max_restarts = 5
        self._restart_backoff = 1.0
        self._max_backoff = 30.0

        # Shutdown coordination
        self._shutdown_event = asyncio.Event()

    async def start(self) -> None:
        """Start the persistent Claude process and I/O forwarding."""
        self.logger.info("Starting Claude process manager in daemon mode")
        self._running = True
        self._shutdown_event.clear()

        # Start the Claude process
        await self._spawn_claude()

        # Start stdin/stdout forwarding tasks
        stdin_task = asyncio.create_task(self._forward_stdin_to_claude())
        stdout_task = asyncio.create_task(self._forward_claude_to_stdout())
        health_task = asyncio.create_task(self._health_monitor())

        # Wait for shutdown signal
        await self._shutdown_event.wait()

        # Cancel all tasks
        stdin_task.cancel()
        stdout_task.cancel()
        health_task.cancel()

        # Cleanup
        await self._cleanup()

    async def _spawn_claude(self) -> None:
        """Spawn Claude Code in persistent normal mode."""
        self.logger.info("Spawning Claude Code in normal persistent mode")

        try:
            # Build command with --dangerously-skip-permissions for Docker isolation
            cmd = [
                "claude",
                "--dangerously-skip-permissions",  # Safe in Docker isolation
                *self.claude_args,
            ]

            self.logger.debug(f"Claude command: {' '.join(cmd)}")

            # Spawn Claude with stdin/stdout pipes for persistent communication
            self.process = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            self.logger.info(f"Claude Code process started: PID={self.process.pid}")

            # Start stderr relay task
            task = asyncio.create_task(self._relay_claude_stderr())
            self._background_tasks.add(task)
            task.add_done_callback(self._background_tasks.discard)

        except Exception as e:
            self.logger.error(f"Failed to spawn Claude Code: {e}")
            raise

    async def _relay_claude_stderr(self) -> None:
        """Relay Claude stderr to our stderr for debugging."""
        if not self.process or not self.process.stderr:
            return

        try:
            while True:
                line = await self.process.stderr.readline()
                if not line:
                    break

                log_line = line.decode("utf-8", errors="ignore").strip()
                if log_line:
                    self.logger.info(f"[CLAUDE-STDERR] {log_line}")

        except Exception as e:
            self.logger.error(f"Error relaying Claude stderr: {e}")

    async def _forward_stdin_to_claude(self) -> None:
        """Read from stdin and forward to Claude stdin."""
        self.logger.debug("Starting stdin to Claude forwarding")

        loop = asyncio.get_running_loop()

        try:
            while self._running:
                # Use run_in_executor for blocking readline
                line = await loop.run_in_executor(None, sys.stdin.readline)
                if not line:
                    self.logger.info("Stdin reached EOF, triggering shutdown")
                    self._shutdown_event.set()
                    break

                command = line.strip()
                if command:
                    self.logger.info(f"Received command from host: {command[:50]}...")
                    self._last_activity = time.time()

                    if self.process and self.process.stdin:
                        data = (command + "\n").encode("utf-8")
                        self.process.stdin.write(data)
                        await self.process.stdin.drain()
                        self.logger.debug(f"Forwarded {len(data)} bytes to Claude")

        except asyncio.CancelledError:
            self.logger.debug("Stdin forwarding task cancelled")
        except Exception as e:
            self.logger.error(f"Error in stdin forwarding: {e}")
            self._shutdown_event.set()

    async def _forward_claude_to_stdout(self) -> None:
        """Read from Claude stdout and forward to stdout."""
        self.logger.debug("Starting Claude to stdout forwarding")

        try:
            while self._running:
                if not self.process or not self.process.stdout:
                    await asyncio.sleep(0.1)
                    continue

                # Read chunk from Claude stdout
                chunk = await self.process.stdout.read(1024)
                if not chunk:
                    self.logger.warning("Claude stdout closed")
                    # Claude might have crashed, trigger health check
                    break

                # Forward to host stdout
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
                self._last_activity = time.time()
                self.logger.debug(f"Relayed {len(chunk)} bytes from Claude")

        except asyncio.CancelledError:
            self.logger.debug("Stdout forwarding task cancelled")
        except Exception as e:
            self.logger.error(f"Error in stdout forwarding: {e}")

    async def _health_monitor(self) -> None:
        """Monitor Claude process health and auto-restart if needed."""
        self.logger.debug("Starting health monitor")

        while self._running:
            try:
                await asyncio.sleep(self._health_check_interval)

                if not self.process:
                    self.logger.warning("Process is None, attempting restart")
                    await self._attempt_restart()
                    continue

                # Check if process is still running
                if self.process.returncode is not None:
                    self.logger.warning(
                        f"Claude process exited with code {self.process.returncode}"
                    )
                    await self._attempt_restart()
                    continue

                # Check for recent activity
                idle_time = time.time() - self._last_activity
                if idle_time > 300:  # 5 minutes idle
                    self.logger.debug(f"Process idle for {idle_time:.0f}s")

            except asyncio.CancelledError:
                break
            except Exception as e:
                self.logger.error(f"Error in health monitor: {e}")

    async def _attempt_restart(self) -> None:
        """Attempt to restart Claude with exponential backoff."""
        if self._restart_count >= self._max_restarts:
            self.logger.error(f"Max restarts ({self._max_restarts}) reached, giving up")
            self._shutdown_event.set()
            return

        # Calculate backoff with exponential increase
        backoff = min(
            self._restart_backoff * (2**self._restart_count),
            self._max_backoff,
        )
        self._restart_count += 1

        self.logger.warning(
            f"Restarting Claude in {backoff:.1f}s "
            f"(attempt {self._restart_count}/{self._max_restarts})"
        )

        await asyncio.sleep(backoff)

        try:
            # Clean up old process
            if self.process:
                try:
                    self.process.terminate()
                    await asyncio.sleep(0.5)
                    if self.process.returncode is None:
                        self.process.kill()
                    await self.process.wait()
                except Exception:
                    pass

            # Spawn new process
            await self._spawn_claude()
            self.logger.info("Claude process restarted successfully")

        except Exception as e:
            self.logger.error(f"Failed to restart Claude: {e}")

    async def _cleanup(self) -> None:
        """Cleanup resources and stop Claude process."""
        self.logger.info("Cleaning up Claude process manager")
        self._running = False

        if self.process:
            try:
                self.logger.info("Terminating Claude process...")
                self.process.terminate()

                # Wait for graceful shutdown
                await asyncio.sleep(0.5)

                # Force kill if still running
                if self.process.returncode is None:
                    self.logger.warning("Claude did not terminate gracefully, killing...")
                    self.process.kill()

                await self.process.wait()
                self.logger.info("Claude process terminated")

            except Exception as e:
                self.logger.error(f"Error terminating Claude: {e}")

    def get_status(self) -> dict:
        """Get current status of the process manager."""
        return {
            "mode": "daemon",
            "running": self._running,
            "claude_pid": self.process.pid if self.process else None,
            "claude_returncode": self.process.returncode if self.process else None,
            "restart_count": self._restart_count,
            "last_activity": self._last_activity,
            "idle_seconds": time.time() - self._last_activity,
        }

    def shutdown(self) -> None:
        """Signal shutdown."""
        self.logger.info("Shutdown requested")
        self._running = False
        self._shutdown_event.set()


class ContainerAgent:
    """
    Agent that bridges host communication to Claude Code.

    Supports two modes:
    - daemon: Persistent Claude process with bidirectional stdin/stdout
    - legacy: One-shot print mode commands (original behavior)
    """

    def __init__(
        self,
        claude_args: list[str] | None = None,
        mode: str = "daemon",
        log_level: str = "INFO",
    ):
        """
        Initialize container agent.

        Args:
            claude_args: Additional arguments for Claude Code
            mode: Operating mode ("daemon" or "legacy")
            log_level: Logging level
        """
        self.claude_args = claude_args or []
        self.mode = mode
        self.log_level = log_level
        self.logger = logger

        # Mode-specific components
        self.claude_manager: ClaudeProcessManager | None = None
        self.running = False
        self._shutdown_event = asyncio.Event()

        if self.mode == "daemon":
            self.claude_manager = ClaudeProcessManager(
                claude_args=self.claude_args,
                log_level=self.log_level,
            )

    async def start(self) -> None:
        """Start the agent."""
        self.logger.info(f"Starting container agent in {self.mode} mode")
        self.running = True
        self._shutdown_event.clear()

        if self.mode == "daemon" and self.claude_manager:
            # Daemon mode: Run persistent Claude process
            await self.claude_manager.start()
        else:
            # Legacy mode: One-shot print mode commands
            await self._run_legacy_mode()

    async def _run_legacy_mode(self) -> None:
        """Run legacy one-shot print mode (original behavior)."""
        self.logger.info("Running in legacy mode (one-shot print mode)")

        loop = asyncio.get_running_loop()
        queue = asyncio.Queue()

        # Stdin reader task
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
                    self.logger.info(f"Received command: {command[:50]}...")
                    await self._send_to_claude_print_mode(command)

        except asyncio.CancelledError:
            self.logger.debug("Legacy mode task cancelled")
        except Exception as e:
            self.logger.error(f"Legacy mode error: {e}")
        finally:
            reader_task.cancel()
            self._shutdown_event.set()

    async def _send_to_claude_print_mode(self, command: str) -> None:
        """Run Claude in print mode with session continuity (legacy)."""
        self.logger.info(f"Running Claude in print mode: {command[:50]}...")

        try:
            # Build arguments: print mode + global args + user command
            args = ["-p", *self.claude_args, "-c", command]

            # Start transient Claude process
            proc = await asyncio.create_subprocess_exec(
                "claude",
                *args,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            # Task to relay stderr
            async def relay_stderr():
                if not proc.stderr:
                    return
                try:
                    while True:
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
                        chunk = await proc.stdout.read(1024)
                        if not chunk:
                            break

                        sys.stdout.buffer.write(chunk)
                        sys.stdout.buffer.flush()
                        self.logger.debug(f"Relayed {len(chunk)} bytes to host")
                except Exception as e:
                    self.logger.error(f"Error in stdout relay: {e}")

            await proc.wait()
            self.logger.info(f"Claude process finished with code {proc.returncode}")
            stderr_task.cancel()

        except Exception as e:
            self.logger.error(f"Failed to execute Claude command: {e}")

    async def _cleanup(self) -> None:
        """Cleanup resources."""
        self.logger.info("Cleaning up agent resources")
        self.running = False

        if self.claude_manager:
            await self.claude_manager._cleanup()

    def shutdown(self) -> None:
        """Signal the agent to shutdown."""
        if not self.running:
            return
        self.logger.info("Shutdown requested")
        self.running = False
        self._shutdown_event.set()

        if self.claude_manager:
            self.claude_manager.shutdown()

    def get_status(self) -> dict:
        """Get agent status."""
        status = {
            "mode": self.mode,
            "running": self.running,
            "log_level": self.log_level,
        }

        if self.mode == "daemon" and self.claude_manager:
            status.update(self.claude_manager.get_status())

        return status


def setup_signal_handlers(agent: ContainerAgent) -> None:
    """Setup signal handlers for graceful shutdown."""

    def signal_handler(signum, frame):
        logger.info(f"Received signal {signum}, initiating shutdown")
        agent.shutdown()

    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)


def print_status(agent: ContainerAgent) -> None:
    """Print agent status information."""
    status = agent.get_status()
    logger.info(f"Agent Status: {json.dumps(status, indent=2)}")


def main() -> int:
    """Main entry point for container agent."""

    parser = argparse.ArgumentParser(description="Container agent for Claude Code Docker bridge")
    parser.add_argument(
        "--claude-args",
        nargs="*",
        default=[],
        help="Additional arguments for Claude Code",
    )
    parser.add_argument(
        "--mode",
        choices=["daemon", "legacy"],
        default="daemon",
        help="Operating mode: daemon (persistent) or legacy (one-shot)",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="Log level",
    )
    parser.add_argument(
        "--status",
        action="store_true",
        help="Print agent status and exit",
    )

    # Keep compatibility with old pipe arguments (ignore them)
    parser.add_argument("--input-pipe", help=argparse.SUPPRESS)
    parser.add_argument("--output-pipe", help=argparse.SUPPRESS)

    args = parser.parse_args()

    # Setup logging
    logger.setLevel(getattr(logging, args.log_level.upper()))

    # Print status if requested
    if args.status:
        agent = ContainerAgent(
            claude_args=args.claude_args,
            mode=args.mode,
            log_level=args.log_level,
        )
        print_status(agent)
        return 0

    # Create and start agent
    agent = ContainerAgent(
        claude_args=args.claude_args,
        mode=args.mode,
        log_level=args.log_level,
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
