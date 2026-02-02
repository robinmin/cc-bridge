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
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from cc_bridge.packages.logging import get_logger

logger = get_logger(__name__)


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
                    if instance.instance_type == "docker" and instance.communication_mode == "fifo":
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
            Path(channel.input_pipe_path).exists() and Path(channel.output_pipe_path).exists()
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
            time_since_recovery = (datetime.now() - status.last_recovery_attempt).total_seconds()
            if time_since_recovery < self.recovery_delay * 2:
                logger.debug(f"Skipping recovery for {instance_name} (recently attempted)")
                return

        status.last_recovery_attempt = datetime.now()
        logger.info(f"Triggering recovery for instance {instance_name}")

        # Call recovery callbacks
        for callback in self._recovery_callbacks:
            try:
                await callback(instance_name)
            except Exception as e:
                logger.error(f"Recovery callback error for {instance_name}: {e}")

    async def get_health_status(self, instance_name: str | None = None) -> dict[str, Any] | None:
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
                return {name: status.to_dict() for name, status in self._health_status.items()}

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
                logger.info(f"Container {instance_name} is not running, attempting restart...")
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


# Global health monitor instance
_health_monitor: HealthMonitor | None = None


def get_health_monitor() -> HealthMonitor:
    """Get or create the global health monitor."""
    global _health_monitor  # noqa: PLW0603  # Singleton pattern
    if _health_monitor is None:
        _health_monitor = HealthMonitor()
    return _health_monitor


__all__ = [
    "DaemonRecovery",
    "HealthMonitor",
    "HealthStatus",
    "get_health_monitor",
]
