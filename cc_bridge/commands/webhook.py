"""
Webhook management command for Telegram.

This module provides CLI commands for manually setting, getting, and deleting
Telegram bot webhooks.
"""

import asyncio
from typing import Annotated, Optional

import httpx
import typer

from cc_bridge.config import get_config
from cc_bridge.core.telegram import TelegramClient
from cc_bridge.packages.logging import get_logger

logger = get_logger(__name__)

app = typer.Typer(help="Manage Telegram bot webhooks")


async def set_webhook(url: str) -> bool:
    """Set the Telegram bot webhook URL."""
    config = get_config()
    bot_token = config.get("telegram.bot_token")

    if not bot_token:
        logger.error("telegram.bot_token not found in configuration")
        return False

    async with TelegramClient(bot_token) as client:
        try:
            result = await client.set_webhook(url)
            return result.get("ok", False)
        except Exception as e:
            logger.error(f"Failed to set webhook: {e}")
            return False


async def get_webhook_info() -> dict:
    """Get current Telegram bot webhook information."""
    config = get_config()
    bot_token = config.get("telegram.bot_token")

    if not bot_token:
        logger.error("telegram.bot_token not found in configuration")
        return {"ok": False, "error": "Missing bot token"}

    async with TelegramClient(bot_token) as client:
        try:
            return await client.get_webhook_info()
        except Exception as e:
            logger.error(f"Failed to get webhook info: {e}")
            return {"ok": False, "error": str(e)}


async def delete_webhook() -> bool:
    """Delete the Telegram bot webhook."""
    config = get_config()
    bot_token = config.get("telegram.bot_token")

    if not bot_token:
        logger.error("telegram.bot_token not found in configuration")
        return False

    async with TelegramClient(bot_token) as client:
        try:
            result = await client.delete_webhook()
            return result.get("ok", False)
        except Exception as e:
            logger.error(f"Failed to delete webhook: {e}")
            return False


async def test_webhook(url: str) -> bool:
    """Test a webhook URL by sending a mock update."""
    config = get_config()
    chat_id = config.get("telegram.chat_id", 1)

    payload = {
        "update_id": 1,
        "message": {
            "message_id": 1,
            "from": {"id": chat_id, "is_bot": False, "first_name": "Test"},
            "chat": {"id": chat_id, "type": "private"},
            "date": 123456789,
            "text": "/status",
        },
    }

    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(url, json=payload, timeout=10.0)
            if response.status_code == 200:
                print(f"✅ Webhook test successful: {response.json()}")
                return True
            else:
                print(
                    f"❌ Webhook test failed (HTTP {response.status_code}): {response.text}"
                )
                return False
    except Exception as e:
        print(f"❌ Webhook test failed with error: {e}")
        return False


@app.command()
def main(
    set: Annotated[Optional[str], typer.Option("--set", help="Set webhook URL")] = None,
    get: Annotated[
        bool, typer.Option("--get", help="Get current webhook info")
    ] = False,
    delete: Annotated[
        bool, typer.Option("--delete", help="Delete current webhook")
    ] = False,
    test: Annotated[
        Optional[str],
        typer.Option("--test", help="Test a webhook URL with a mock update"),
    ] = None,
):
    """
    Manage Telegram bot webhooks.
    """
    if set:
        if asyncio.run(set_webhook(set)):
            print(f"✅ Webhook set to: {set}")
        else:
            print("❌ Failed to set webhook.")
            raise typer.Exit(1)
    elif get:
        info = asyncio.run(get_webhook_info())
        print(f"📊 Webhook Info: {info}")
    elif delete:
        if asyncio.run(delete_webhook()):
            print("✅ Webhook deleted.")
        else:
            print("❌ Failed to delete webhook.")
            raise typer.Exit(1)
    elif test:
        if not asyncio.run(test_webhook(test)):
            raise typer.Exit(1)
    else:
        print("Please specify an action (--set, --get, --delete, or --test).")
        print("Use --help for more information.")


if __name__ == "__main__":
    app()
