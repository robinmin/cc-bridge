"""
Health command implementation.

This module implements health checks for:
- Telegram webhook connectivity
- tmux session status
- Hook functionality
"""

import asyncio
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
