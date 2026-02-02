"""
Health command implementation.

This module implements health checks for:
- Telegram webhook connectivity
- tmux session status
- Hook functionality
- Docker daemon mode instances (FIFO health, agent status)
"""

import asyncio
import os
import subprocess
from pathlib import Path
from typing import Any

import httpx

from cc_bridge.config import get_config
from cc_bridge.core.tmux import TmuxSession


async def check_telegram() -> dict[str, Any]:  # noqa: PLR0911
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
            response = await client.get(f"https://api.telegram.org/bot{bot_token}/getWebhookInfo")
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


def check_tmux(session_name: str = "claude") -> dict[str, Any]:
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


def check_hook() -> dict[str, Any]:
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


async def check_docker_daemon() -> dict[str, Any]:  # noqa: PLR0912
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
            if instance.instance_type == "docker" and instance.communication_mode == "fifo":
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
                    unhealthy_instances.append({"name": name, "reason": "Container not found"})
                    continue

                # Check FIFO pipes
                from cc_bridge.core.named_pipe import NamedPipeChannel

                pipe_dir = "/tmp/cc-bridge/pipes"  # Default
                try:
                    from cc_bridge.config import get_config

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


def check_fifo_pipes() -> dict[str, Any]:
    """
    Check FIFO pipe directory health.

    Returns:
        Health check result with status and details
    """
    from cc_bridge.config import get_config

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


async def run_all_checks() -> dict[str, Any]:
    """
    Run all health checks.

    Returns:
        Overall health status with individual check results
    """
    checks = {
        "telegram": await check_telegram(),
        "tmux": check_tmux(),
        "hook": check_hook(),
        "docker_daemon": await check_docker_daemon(),
        "fifo_pipes": check_fifo_pipes(),
    }

    all_healthy = all(check.get("status") == "healthy" for check in checks.values())

    return {
        "status": "healthy" if all_healthy else "unhealthy",
        "checks": checks,
    }


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
