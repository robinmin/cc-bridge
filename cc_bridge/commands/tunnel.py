"""
Tunnel command implementation.

This module provides the CLI entry point for Cloudflare tunnel management.
All business logic has been moved to cc_bridge/core/tunnel.py.
"""

import sys

from cc_bridge.config import get_config
from cc_bridge.core.telegram import TelegramClient
from cc_bridge.core.tunnel import CloudflareTunnelManager

__all__ = ["main"]


def main(start: bool = False, stop: bool = False, port: int = 8080) -> int:
    """
    Main entry point for tunnel command.

    Args:
        start: Start a new tunnel
        stop: Stop the running tunnel
        port: Local port to expose

    Returns:
        Exit code (0 for success, 1 for error)
    """
    try:
        if start:
            # Create tunnel manager and start tunnel
            manager = CloudflareTunnelManager(port=port)
            import asyncio

            url = asyncio.run(manager.start())
            print(f"Tunnel started: {url}")

            # Auto-set webhook if bot token available
            config = get_config()
            bot_token = config.get("telegram.bot_token")
            if bot_token:
                client = TelegramClient(bot_token)
                success = asyncio.run(client.set_webhook(url))
                if success:
                    print(f"Webhook set to: {url}")
                else:
                    print(
                        "Warning: Failed to set webhook automatically", file=sys.stderr
                    )
            else:
                print(
                    "Note: Set telegram.bot_token in config to auto-set webhook",
                    file=sys.stderr,
                )

        elif stop:
            # Stop all tunnels
            CloudflareTunnelManager(port=port).stop()
            print("Tunnel stopped")

        else:
            print("Error: Specify --start or --stop", file=sys.stderr)
            return 1

        return 0
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
