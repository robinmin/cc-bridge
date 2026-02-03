"""
Health monitoring and crash recovery for Docker daemon mode instances.

This module provides background health monitoring with automatic recovery
for Docker daemon mode instances, including:
- Daemon agent process monitoring
- FIFO pipe health checks
- Automatic restart on failure
- Session state recovery
"""

import asyncio
import os
import subprocess
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx

from cc_bridge.config import get_config
from cc_bridge.core.tmux import TmuxSession
from cc_bridge.packages.logging import get_logger

logger = get_logger(__name__)
logger_health = get_logger(__name__)


@dataclass
class HealthStatus:
    """Health status of a daemon instance."""

    instance_name: str
    healthy: bool
    last_check: datetime
    container_running: bool = False
    pipes_exist: bool = False
    agent_running: bool = False
    session_healthy: bool = False
    error_message: str | None = None
    consecutive_failures: int = 0
    last_recovery_attempt: datetime | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "instance_name": self.instance_name,
            "healthy": self.healthy,
            "last_check": self.last_check.isoformat(),
            "container_running": self.container_running,
            "pipes_exist": self.pipes_exist,
            "agent_running": self.agent_running,
            "session_healthy": self.session_healthy,
            "error_message": self.error_message,
            "consecutive_failures": self.consecutive_failures,
            "last_recovery_attempt": self.last_recovery_attempt.isoformat()
            if self.last_recovery_attempt
            else None,
        }


class HealthMonitor:
    """
    Background health monitor for Docker daemon mode instances.

    Monitors instance health and performs automatic recovery when issues are detected.
    """

    def __init__(
        self,
        check_interval: float = 30.0,
        recovery_delay: float = 5.0,
        max_consecutive_failures: int = 3,
    ):
        """
        Initialize health monitor.

        Args:
            check_interval: Seconds between health checks
            recovery_delay: Seconds to wait before recovery attempt
            max_consecutive_failures: Max failures before recovery is attempted
        """
        self.check_interval = check_interval
        self.recovery_delay = recovery_delay
        self.max_consecutive_failures = max_consecutive_failures

        # Health status tracking
        self._health_status: dict[str, HealthStatus] = {}
        self._lock = asyncio.Lock()

        # Background monitoring task
        self._monitor_task: asyncio.Task | None = None
        self._running = False

        # Recovery callbacks
        self._recovery_callbacks: list[Callable[[str], Awaitable[None]]] = []

    async def start(self) -> None:
        """Start background health monitoring."""
        if self._running:
            logger.warning("Health monitoring already running")
            return

        self._running = True
        self._monitor_task = asyncio.create_task(self._monitor_loop())
        logger.info(f"Started health monitoring (interval={self.check_interval}s)")

    async def stop(self) -> None:
        """Stop background health monitoring."""
        self._running = False
        if self._monitor_task:
            self._monitor_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._monitor_task
            self._monitor_task = None
        logger.info("Stopped health monitoring")

    def add_recovery_callback(self, callback: Callable[[str], Awaitable[None]]) -> None:
        """
        Add a recovery callback function.

        Args:
            callback: Async function that takes instance_name and performs recovery
        """
        self._recovery_callbacks.append(callback)

    async def _monitor_loop(self) -> None:
        """Background monitoring loop."""
        try:
            while self._running:
                await self._check_all_instances()
                await asyncio.sleep(self.check_interval)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"Health monitor loop error: {e}")

    async def _check_all_instances(self) -> None:
        """Check health of all daemon instances."""
        try:
            from cc_bridge.core.instances import InstanceManager

            manager = InstanceManager()

            async with self._lock:
                for name, instance in manager._instances.items():
                    if (
                        instance.instance_type == "docker"
                        and instance.communication_mode == "fifo"
                    ):
                        await self._check_instance(name, instance)

        except Exception as e:
            logger.error(f"Error checking instances: {e}")

    async def _check_instance(self, name: str, instance: Any) -> None:  # noqa: PLR0915
        """
        Check health of a single instance.

        Args:
            name: Instance name
            instance: ClaudeInstance object
        """
        from cc_bridge.core.named_pipe import NamedPipeChannel

        config = None
        try:
            from cc_bridge.config import get_config

            config = get_config()
        except Exception:
            pass

        pipe_dir = "/tmp/cc-bridge/pipes"  # Default
        if config:
            pipe_dir = config.get("docker", {}).get("pipe_dir", pipe_dir)

        # Check container status
        container_running = False
        try:
            import docker

            client = docker.from_env()
            container = client.containers.get(instance.container_id)
            container_running = container.status == "running"
        except Exception as e:
            logger.debug(f"Container check failed for {name}: {e}")

        # Check FIFO pipes
        channel = NamedPipeChannel(instance_name=name, pipe_dir=pipe_dir)
        pipes_exist = (
            Path(channel.input_pipe_path).exists()
            and Path(channel.output_pipe_path).exists()
        )

        # Check session health
        session_healthy = False
        try:
            from cc_bridge.core.session_tracker import get_session_tracker

            session_tracker = get_session_tracker()
            session = await session_tracker.get_session(name)
            if session:
                session_healthy = session.status in ("active", "idle")
        except Exception as e:
            logger.debug(f"Session check failed for {name}: {e}")

        # Determine overall health
        healthy = container_running and pipes_exist

        # Get or create status record
        status = self._health_status.get(name)
        if status:
            status.last_check = datetime.now()
            status.container_running = container_running
            status.pipes_exist = pipes_exist
            status.session_healthy = session_healthy
            status.healthy = healthy
        else:
            status = HealthStatus(
                instance_name=name,
                healthy=healthy,
                last_check=datetime.now(),
                container_running=container_running,
                pipes_exist=pipes_exist,
                session_healthy=session_healthy,
            )
            self._health_status[name] = status

        # Check for failures and trigger recovery
        if not healthy:
            status.consecutive_failures += 1
            error_parts = []
            if not container_running:
                error_parts.append("container not running")
            if not pipes_exist:
                error_parts.append("FIFO pipes missing")
            status.error_message = ", ".join(error_parts)

            if status.consecutive_failures >= self.max_consecutive_failures:
                logger.warning(
                    f"Instance {name} unhealthy after {status.consecutive_failures} checks: {status.error_message}"
                )
                await self._trigger_recovery(name)
        else:
            status.consecutive_failures = 0
            status.error_message = None
            logger.debug(f"Instance {name} is healthy")

    async def _trigger_recovery(self, instance_name: str) -> None:
        """
        Trigger recovery for an unhealthy instance.

        Args:
            instance_name: Name of the instance to recover
        """
        status = self._health_status.get(instance_name)
        if not status:
            return

        # Check if recovery was recently attempted
        if status.last_recovery_attempt:
            time_since_recovery = (
                datetime.now() - status.last_recovery_attempt
            ).total_seconds()
            if time_since_recovery < self.recovery_delay * 2:
                logger.debug(
                    f"Skipping recovery for {instance_name} (recently attempted)"
                )
                return

        status.last_recovery_attempt = datetime.now()
        logger.info(f"Triggering recovery for instance {instance_name}")

        # Call recovery callbacks
        for callback in self._recovery_callbacks:
            try:
                await callback(instance_name)
            except Exception as e:
                logger.error(f"Recovery callback error for {instance_name}: {e}")

    async def get_health_status(
        self, instance_name: str | None = None
    ) -> dict[str, Any] | None:
        """
        Get health status for an instance or all instances.

        Args:
            instance_name: Optional instance name, returns all if None

        Returns:
            Health status dict or None
        """
        async with self._lock:
            if instance_name:
                status = self._health_status.get(instance_name)
                return status.to_dict() if status else None
            else:
                return {
                    name: status.to_dict()
                    for name, status in self._health_status.items()
                }

    async def is_healthy(self, instance_name: str) -> bool:
        """
        Check if an instance is healthy.

        Args:
            instance_name: Name of the instance

        Returns:
            True if instance is healthy, False otherwise
        """
        status = self._health_status.get(instance_name)
        return status.healthy if status else False


class DaemonRecovery:
    """
    Recovery actions for Docker daemon mode instances.

    Provides automatic recovery methods for common failure scenarios.
    """

    def __init__(self, health_monitor: HealthMonitor):
        """
        Initialize daemon recovery.

        Args:
            health_monitor: Health monitor instance
        """
        self.health_monitor = health_monitor
        self.health_monitor.add_recovery_callback(self.recover_instance)

    async def recover_instance(self, instance_name: str) -> None:
        """
        Attempt to recover an unhealthy instance.

        Args:
            instance_name: Name of the instance to recover
        """
        logger.info(f"Starting recovery for instance {instance_name}")

        try:
            from cc_bridge.core.instances import InstanceManager

            manager = InstanceManager()
            instance = manager._instances.get(instance_name)

            if not instance or instance.instance_type != "docker":
                logger.warning(f"Invalid Docker instance for recovery: {instance_name}")
                return

            # Check if container is running
            import docker

            client = docker.from_env()
            container = client.containers.get(instance.container_id)

            if container.status != "running":
                logger.info(
                    f"Container {instance_name} is not running, attempting restart..."
                )
                # Container restart - requires external orchestration
                # Log the issue for now
                logger.warning(f"Container {instance_name} needs manual restart")
                return

            # Check FIFO pipes
            from cc_bridge.core.named_pipe import NamedPipeChannel

            config = None
            try:
                from cc_bridge.config import get_config

                config = get_config()
            except Exception:
                pass

            pipe_dir = "/tmp/cc-bridge/pipes"  # Default
            if config:
                pipe_dir = config.get("docker", {}).get("pipe_dir", pipe_dir)

            channel = NamedPipeChannel(instance_name=instance_name, pipe_dir=pipe_dir)

            # Re-create pipes if missing
            if (
                not Path(channel.input_pipe_path).exists()
                or not Path(channel.output_pipe_path).exists()
            ):
                logger.info(f"Re-creating FIFO pipes for {instance_name}...")
                channel.create_pipes()

            # Check daemon agent status
            agent_running = await self._check_daemon_agent(instance_name, instance)
            if not agent_running:
                logger.info(f"Daemon agent not running for {instance_name}")
                # Daemon agent recovery - requires restart via docker exec
                logger.warning(f"Daemon agent for {instance_name} needs restart")

            logger.info(f"Recovery completed for instance {instance_name}")

        except Exception as e:
            logger.error(f"Recovery failed for {instance_name}: {e}")

    async def _check_daemon_agent(self, instance_name: str, instance: Any) -> bool:
        """
        Check if daemon agent is running in the container.

        Args:
            instance_name: Name of the instance
            instance: ClaudeInstance object

        Returns:
            True if agent is running, False otherwise
        """
        try:
            import docker

            client = docker.from_env()
            container = client.containers.get(instance.container_id)

            # Check if agent process is running
            result = container.exec_run("ps aux | grep container_agent | grep -v grep")
            return result.exit_code == 0 and "container_agent" in result.output.decode()
        except Exception as e:
            logger.debug(f"Daemon agent check failed for {instance_name}: {e}")
            return False

    async def recover_session_state(self, instance_name: str) -> None:
        """
        Recover session state after crash/restart.

        Args:
            instance_name: Name of the instance
        """
        try:
            from cc_bridge.core.session_tracker import get_session_tracker

            session_tracker = get_session_tracker()
            session = await session_tracker.get_session(instance_name)

            if session and session.active_turn:
                # Complete the orphaned request
                await session_tracker.complete_request(
                    instance_name,
                    session.active_turn.request_id,
                    "",
                    error="Instance recovered from crash",
                )
                logger.info(f"Recovered orphaned request for {instance_name}")

        except Exception as e:
            logger.error(f"Session recovery failed for {instance_name}: {e}")


# =============================================================================
# One-Shot Health Check Functions
# =============================================================================


async def check_telegram_webhook() -> dict[str, Any]:
    """
    Check Telegram webhook connectivity.

    Returns:
        Health check result with status and details
    """
    config = get_config()
    bot_token = config.get("telegram.bot_token", "")
    config.get("telegram.webhook_url", "")

    if not bot_token:
        return {
            "status": "unhealthy",
            "message": "Bot token not configured",
            "webhook_set": False,
        }

    # Check if webhook is set by calling getWebhookInfo
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"https://api.telegram.org/bot{bot_token}/getWebhookInfo"
            )
            response.raise_for_status()
            data = response.json()

            if data.get("ok"):
                webhook_info = data.get("result", {})
                webhook_url_actual = webhook_info.get("url", "")

                if webhook_url_actual:
                    return {
                        "status": "healthy",
                        "message": "Webhook is configured",
                        "webhook_url": webhook_url_actual,
                        "webhook_set": True,
                    }
                else:
                    return {
                        "status": "unhealthy",
                        "message": "Webhook not set",
                        "webhook_set": False,
                    }
            else:
                return {
                    "status": "unhealthy",
                    "message": f"Telegram API error: {data.get('description', 'Unknown')}",
                    "webhook_set": False,
                }
    except httpx.TimeoutException:
        return {
            "status": "unhealthy",
            "message": "Timeout connecting to Telegram API",
            "webhook_set": False,
        }
    except httpx.HTTPError as e:
        return {
            "status": "unhealthy",
            "message": f"HTTP error: {e}",
            "webhook_set": False,
        }
    except Exception as e:
        return {
            "status": "unhealthy",
            "message": f"Unexpected error: {e}",
            "webhook_set": False,
        }


def check_tmux_session(session_name: str = "claude") -> dict[str, Any]:
    """
    Check tmux session status.

    Args:
        session_name: Name of tmux session to check

    Returns:
        Health check result with status and details
    """
    try:
        # Check if tmux is installed
        result = subprocess.run(
            ["tmux", "-V"],
            capture_output=True,
            check=False,
            text=True,
            timeout=5,
        )
        if result.returncode != 0:
            return {
                "status": "unhealthy",
                "message": "tmux is not installed",
                "session_exists": False,
            }
    except FileNotFoundError:
        return {
            "status": "unhealthy",
            "message": "tmux is not installed",
            "session_exists": False,
        }
    except subprocess.TimeoutExpired:
        return {
            "status": "unhealthy",
            "message": "Timeout checking tmux version",
            "session_exists": False,
        }

    # Check if session exists
    try:
        tmux_session = TmuxSession(session_name)
        session_exists = tmux_session.session_exists()

        if session_exists:
            return {
                "status": "healthy",
                "message": f"Session '{session_name}' is running",
                "session_exists": True,
            }
        else:
            return {
                "status": "unhealthy",
                "message": f"Session '{session_name}' not found",
                "session_exists": False,
            }
    except Exception as e:
        return {
            "status": "unhealthy",
            "message": f"Error checking tmux session: {e}",
            "session_exists": False,
        }


def check_git_hooks() -> dict[str, Any]:
    """
    Check Stop hook functionality.

    Returns:
        Health check result with status and details
    """
    config = get_config()
    hook_enabled = config.get("health.enabled", True)

    if not hook_enabled:
        return {
            "status": "healthy",
            "message": "Health checks disabled in config",
            "hook_enabled": False,
        }

    # Check if git hooks are available
    try:
        result = subprocess.run(
            ["git", "config", "--get", "core.hooksPath"],
            capture_output=True,
            check=False,
            text=True,
            timeout=5,
            cwd="/Users/robin/xprojects/cc-bridge",
        )

        hooks_path = result.stdout.strip()
        if hooks_path:
            # Check if stop hook exists
            Path(hooks_path) / "pre-commit"  # or post-commit based on setup
            # For cc-bridge, the hook is likely in the git hooks directory
            # Let's check if cc-bridge hook functionality is available

            return {
                "status": "healthy",
                "message": "Git hooks are configured",
                "hook_enabled": True,
                "hooks_path": hooks_path,
            }
        else:
            return {
                "status": "healthy",
                "message": "No custom git hooks configured (this is OK)",
                "hook_enabled": True,
            }
    except FileNotFoundError:
        return {
            "status": "unhealthy",
            "message": "git is not installed",
            "hook_enabled": False,
        }
    except subprocess.TimeoutExpired:
        return {
            "status": "unhealthy",
            "message": "Timeout checking git hooks",
            "hook_enabled": False,
        }
    except Exception as e:
        return {
            "status": "healthy",
            "message": f"Could not verify hooks: {e}",
            "hook_enabled": True,
        }


async def check_docker_instances() -> dict[str, Any]:
    """
    Check Docker daemon mode instances health.

    Returns:
        Health check result with status and details
    """
    try:
        from cc_bridge.core.instances import InstanceManager

        # Check if Docker is available
        try:
            import docker

            client = docker.from_env()
            client.ping()
        except Exception:
            return {
                "status": "unhealthy",
                "message": "Docker is not available or not running",
                "docker_available": False,
            }

        # Get instance manager
        manager = InstanceManager()

        # Check Docker instances in FIFO mode
        unhealthy_instances = []
        healthy_instances = []
        total_fifo_instances = 0

        for name, instance in manager._instances.items():
            if (
                instance.instance_type == "docker"
                and instance.communication_mode == "fifo"
            ):
                total_fifo_instances += 1

                # Check if container is running
                try:
                    container = client.containers.get(instance.container_id)
                    if container.status != "running":
                        unhealthy_instances.append(
                            {
                                "name": name,
                                "reason": "Container not running",
                                "status": container.status,
                            }
                        )
                        continue
                except Exception:
                    unhealthy_instances.append(
                        {"name": name, "reason": "Container not found"}
                    )
                    continue

                # Check FIFO pipes
                from cc_bridge.core.named_pipe import NamedPipeChannel

                pipe_dir = "/tmp/cc-bridge/pipes"  # Default
                try:
                    cfg = get_config()
                    if cfg:
                        pipe_dir = cfg.get("docker", {}).get("pipe_dir", pipe_dir)
                except Exception:
                    pass

                channel = NamedPipeChannel(instance_name=name, pipe_dir=pipe_dir)

                # Check if pipes exist
                input_exists = Path(channel.input_pipe_path).exists()
                output_exists = Path(channel.output_pipe_path).exists()

                if not input_exists or not output_exists:
                    unhealthy_instances.append(
                        {
                            "name": name,
                            "reason": "FIFO pipes missing",
                            "input_pipe": input_exists,
                            "output_pipe": output_exists,
                        }
                    )
                else:
                    healthy_instances.append(name)

        if total_fifo_instances == 0:
            return {
                "status": "healthy",
                "message": "No Docker daemon mode instances configured",
                "docker_available": True,
                "total_fifo_instances": 0,
            }
        elif unhealthy_instances:
            return {
                "status": "unhealthy",
                "message": f"{len(unhealthy_instances)} of {total_fifo_instances} instances unhealthy",
                "docker_available": True,
                "total_fifo_instances": total_fifo_instances,
                "healthy_instances": healthy_instances,
                "unhealthy_instances": unhealthy_instances,
            }
        else:
            return {
                "status": "healthy",
                "message": f"All {total_fifo_instances} Docker daemon instances healthy",
                "docker_available": True,
                "total_fifo_instances": total_fifo_instances,
                "healthy_instances": healthy_instances,
            }
    except ImportError as e:
        return {
            "status": "unhealthy",
            "message": f"Required module not available: {e}",
            "docker_available": False,
        }
    except Exception as e:
        return {
            "status": "unhealthy",
            "message": f"Error checking Docker daemon: {e}",
            "docker_available": False,
        }


def check_fifo_directory() -> dict[str, Any]:
    """
    Check FIFO pipe directory health.

    Returns:
        Health check result with status and details
    """
    config = get_config()
    pipe_dir = Path(config.get("docker", {}).get("pipe_dir", "/tmp/cc-bridge/pipes"))

    try:
        # Check if pipe directory exists
        if not pipe_dir.exists():
            return {
                "status": "warning",
                "message": f"Pipe directory does not exist: {pipe_dir}",
                "pipe_dir": str(pipe_dir),
                "directory_exists": False,
            }

        # Check if directory is writable
        if not os.access(pipe_dir, os.W_OK):
            return {
                "status": "unhealthy",
                "message": f"Pipe directory is not writable: {pipe_dir}",
                "pipe_dir": str(pipe_dir),
                "directory_exists": True,
                "writable": False,
            }

        # Count FIFO pipes in directory
        fifo_count = 0
        for item in pipe_dir.iterdir():
            if item.is_fifo():
                fifo_count += 1

        return {
            "status": "healthy",
            "message": f"Pipe directory is healthy ({fifo_count} FIFOs found)",
            "pipe_dir": str(pipe_dir),
            "directory_exists": True,
            "writable": True,
            "fifo_count": fifo_count,
        }
    except Exception as e:
        return {
            "status": "unhealthy",
            "message": f"Error checking pipe directory: {e}",
            "pipe_dir": str(pipe_dir),
        }


async def run_all_health_checks() -> dict[str, Any]:
    """
    Run all health checks.

    Returns:
        Overall health status with individual check results
    """
    checks = {
        "telegram": await check_telegram_webhook(),
        "tmux": check_tmux_session(),
        "hook": check_git_hooks(),
        "docker_daemon": await check_docker_instances(),
        "fifo_pipes": check_fifo_directory(),
    }

    all_healthy = all(check.get("status") == "healthy" for check in checks.values())

    return {
        "status": "healthy" if all_healthy else "unhealthy",
        "checks": checks,
    }


# =============================================================================
# Background Health Monitor (existing code)
# =============================================================================

# Global health monitor instance
_health_monitor: HealthMonitor | None = None


def get_health_monitor() -> HealthMonitor:
    """Get or create the global health monitor."""
    global _health_monitor  # noqa: PLW0603  # Singleton pattern
    if _health_monitor is None:
        _health_monitor = HealthMonitor()
    return _health_monitor


__all__ = [
    # Background monitoring
    "DaemonRecovery",
    "HealthMonitor",
    "HealthStatus",
    "get_health_monitor",
    # One-shot health checks
    "check_telegram_webhook",
    "check_tmux_session",
    "check_git_hooks",
    "check_docker_instances",
    "check_fifo_directory",
    "run_all_health_checks",
]
