"""
Health command implementation.

This module provides the CLI entry point for health checks.
All health check logic has been moved to cc_bridge/core/health_monitor.py.
"""

import asyncio

from cc_bridge.core.health_monitor import (
    check_docker_instances,
    check_fifo_directory,
    check_git_hooks,
    check_telegram_webhook,
    check_tmux_session,
    run_all_health_checks,
)

__all__ = ["main"]


def main() -> int:
    """
    Main entry point for health command.

    Returns:
        Exit code (0 if all checks pass, 1 otherwise)
    """
    result = asyncio.run(run_all_checks())

    for name, check in result["checks"].items():
        status = check.get("status", "unknown")
        message = check.get("message", "")
        print(f"{name}: {status} - {message}")

    return 0 if result["status"] == "healthy" else 1


async def run_all_checks():
    """
    Run all health checks.

    This is a compatibility wrapper that calls the core health checks.
    Kept for backward compatibility with any external imports.
    """
    return await run_all_health_checks()


async def check_telegram():
    """
    Check Telegram webhook connectivity.

    This is a compatibility wrapper that calls the core health check.
    Kept for backward compatibility with any external imports.
    """
    return await check_telegram_webhook()


def check_tmux(session_name: str = "claude"):
    """
    Check tmux session status.

    This is a compatibility wrapper that calls the core health check.
    Kept for backward compatibility with any external imports.
    """
    return check_tmux_session(session_name)


def check_hook():
    """
    Check Stop hook functionality.

    This is a compatibility wrapper that calls the core health check.
    Kept for backward compatibility with any external imports.
    """
    return check_git_hooks()


async def check_docker_daemon():
    """
    Check Docker daemon mode instances health.

    This is a compatibility wrapper that calls the core health check.
    Kept for backward compatibility with any external imports.
    """
    return await check_docker_instances()


def check_fifo_pipes():
    """
    Check FIFO pipe directory health.

    This is a compatibility wrapper that calls the core health check.
    Kept for backward compatibility with any external imports.
    """
    return check_fifo_directory()
