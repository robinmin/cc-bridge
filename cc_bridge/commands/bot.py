"""
Bot command management for Telegram.

This module provides CLI commands for managing Telegram bot commands.
Bot command logic has been moved to TelegramClient in core/telegram.py.
"""

import asyncio

import typer

from cc_bridge.config import get_config
from cc_bridge.core.telegram import DEFAULT_BOT_COMMANDS, TelegramClient

app = typer.Typer(help="Manage Telegram bot commands")


@app.command()
def sync():
    """
    Sync bot commands to Telegram.

    This command sets the default bot commands for the Telegram bot.
    Commands are automatically configured during setup, but this command
    can be used to manually reset or update them.
    """
    config = get_config()
    bot_token = config.get("telegram.bot_token")

    if not bot_token:
        print("Error: telegram.bot_token not found in configuration.")
        raise typer.Exit(1)

    async def do_sync():
        client = TelegramClient(bot_token)
        try:
            result = await client.set_bot_commands(DEFAULT_BOT_COMMANDS)
            return result.get("ok", False)
        finally:
            await client.close()

    success = asyncio.run(do_sync())

    if success:
        print("✅ Bot commands synced successfully to Telegram.")
        print("\nConfigured commands:")
        for cmd in DEFAULT_BOT_COMMANDS:
            print(f"  /{cmd['command']} - {cmd['description']}")
    else:
        print("❌ Failed to sync bot commands.")
        raise typer.Exit(1)


@app.command()
def list():
    """
    List configured bot commands.

    This shows the default bot commands that will be synced to Telegram.
    """
    print("Default Bot Commands:")
    for cmd in DEFAULT_BOT_COMMANDS:
        print(f"  /{cmd['command']} - {cmd['description']}")


@app.command()
def show():
    """
    Show current bot commands from Telegram.

    This fetches and displays the actual commands currently set on the bot.
    """
    config = get_config()
    bot_token = config.get("telegram.bot_token")

    if not bot_token:
        print("Error: telegram.bot_token not found in configuration.")
        raise typer.Exit(1)

    async def do_show():
        client = TelegramClient(bot_token)
        try:
            result = await client.get_bot_commands()
            return result
        finally:
            await client.close()

    result = asyncio.run(do_show())

    if result.get("ok"):
        commands = result.get("result", [])
        if commands:
            print("Current Bot Commands (from Telegram):")
            for cmd in commands:
                print(f"  /{cmd['command']} - {cmd['description']}")
        else:
            print("No bot commands are currently set on Telegram.")
            print("Run 'cc-bridge bot sync' to set default commands.")
    else:
        print(f"Error: {result.get('description', 'Failed to fetch bot commands')}")
        raise typer.Exit(1)


if __name__ == "__main__":
    app()
