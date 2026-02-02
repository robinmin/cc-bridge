import asyncio
import sys

import httpx
import typer

from cc_bridge.config import get_config

app = typer.Typer(help="Manage Telegram bot commands")


async def set_bot_commands(bot_token: str, commands: list[dict]) -> bool:
    """
    Set bot commands for Telegram.

    Args:
        bot_token: Telegram bot token
        commands: List of command dictionaries

    Returns:
        True if commands set successfully
    """
    api_url = f"https://api.telegram.org/bot{bot_token}/setMyCommands"

    async with httpx.AsyncClient() as client:
        response = await client.post(api_url, json={"commands": commands})
        result = response.json()
        if not result.get("ok"):
            print(f"Error from Telegram: {result.get('description')}")
        return result.get("ok", False)


def get_default_commands() -> list[dict]:
    """
    Get default bot commands.

    Returns:
        List of command dictionaries
    """
    return [
        {"command": "status", "description": "Check service status"},
        {"command": "clear", "description": "Clear Claude conversation"},
        {"command": "stop", "description": "Interrupt Claude current action"},
        {"command": "resume", "description": "Resumes the last active session"},
        {"command": "help", "description": "Show help message"},
    ]


@app.command()
def sync():
    """
    Sync bot commands to Telegram.
    """
    config = get_config()
    bot_token = config.get("telegram.bot_token")

    if not bot_token:
        print("Error: telegram.bot_token not found in configuration.")
        raise typer.Exit(1)

    commands = get_default_commands()
    success = asyncio.run(set_bot_commands(bot_token, commands))

    if success:
        print("✅ Bot commands synced successfully to Telegram.")
    else:
        print("❌ Failed to sync bot commands.")
        raise typer.Exit(1)


@app.command()
def list():
    """
    List configured bot commands.
    """
    commands = get_default_commands()
    print("Configured Bot Commands:")
    for cmd in commands:
        print(f"  /{cmd['command']} - {cmd['description']}")


async def main(action: str = "sync") -> int:
    """
    Main entry point for bot command operations.

    Args:
        action: The action to perform (sync, list)

    Returns:
        Exit code (0 for success, 1 for failure)
    """
    try:
        if action == "sync":
            config = get_config()
            bot_token = config.get("telegram.bot_token")

            if not bot_token:
                print("Error: telegram.bot_token not found in configuration.")
                return 1

            commands = get_default_commands()
            success = await set_bot_commands(bot_token, commands)

            if success:
                print("Commands synced successfully")
            else:
                print("Commands failed to sync")
            return 0

        elif action == "list":
            commands = get_default_commands()
            print("Bot commands:")
            for cmd in commands:
                print(f"  /{cmd['command']} - {cmd['description']}")
            return 0

        else:
            print(f"Unknown action: {action}")
            return 1
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    app()
