"""
Setup command implementation.

This module implements an interactive setup wizard for first-time
configuration of cc-bridge with enhanced automation.
"""

import asyncio
from pathlib import Path

from cc_bridge.commands import cron, tunnel
from cc_bridge.config import Config
from cc_bridge.core.telegram import TelegramClient
from cc_bridge.packages.logging import get_logger

logger = get_logger(__name__)


def _generate_env_from_example(bot_token: str, chat_id: int, tunnel_url: str) -> dict:
    """
    Generate .env configuration from .env.example.

    Args:
        bot_token: Telegram bot token
        chat_id: Telegram chat ID
        tunnel_url: Cloudflare tunnel URL

    Returns:
        Dictionary of environment variables
    """
    return {
        "TELEGRAM_BOT_TOKEN": bot_token,
        "TELEGRAM_CHAT_ID": str(chat_id),
        "SERVER_HOST": "0.0.0.0",
        "SERVER_PORT": "8080",
        "WEBHOOK_URL": tunnel_url,
        "LOG_LEVEL": "INFO",
    }


def _save_env_file(env_vars: dict, env_path: Path) -> None:
    """
    Save environment variables to .env file.

    Args:
        env_vars: Dictionary of environment variables
        env_path: Path to .env file
    """
    env_path.parent.mkdir(parents=True, exist_ok=True)

    with env_path.open("w") as f:
        for key, value in env_vars.items():
            f.write(f"{key}={value}\n")

    logger.info("Environment file saved", path=str(env_path))


async def _fetch_chat_id(bot_token: str) -> int | None:
    """
    Fetch chat ID by asking user to send /start to bot.

    Args:
        bot_token: Telegram bot token

    Returns:
        Chat ID if found, None otherwise
    """
    print("\n" + "=" * 60)
    print("🔔 Chat ID Detection")
    print("=" * 60)
    print("\nTo automatically detect your Chat ID:")
    print("1. Open Telegram and find your bot")
    print("2. Send /start to your bot")
    print("\nWaiting for you to send /start...")

    # Use async context manager to ensure proper cleanup
    async with TelegramClient(bot_token) as client:
        chat_id = await client.get_chat_id(timeout=30)

        if chat_id:
            print(f"\n✅ Chat ID detected: {chat_id}")
            return chat_id
        else:
            print("\n❌ Could not detect Chat ID automatically.")
            print("   Please enter it manually.")
            return None


def _setup_crontab() -> bool:
    """
    Setup crontab for health checks.

    Returns:
        True if successful
    """
    print("\n" + "=" * 60)
    print("📅 Crontab Setup")
    print("=" * 60)

    manager = cron.CrontabManager()

    # Check if already configured
    if manager.has_entries():
        print("⚠️  Crontab already contains CC-Bridge entries.")
        confirm = input("   Replace existing entries? (y/N): ")
        if confirm.lower() != "y":
            print("   Skipping crontab setup.")
            return True
        manager.remove_entry()

    # Add health check entry (every 5 minutes)
    entry = "*/5 * * * * cc-bridge health-check --quiet"
    print("\nAdding crontab entry:")
    print(f"   {entry}")

    if manager.add_entry(entry):
        print("✅ Crontab configured successfully")
        return True
    else:
        print("❌ Failed to configure crontab")
        return False


async def _setup_webhook(bot_token: str, tunnel_url: str) -> bool:
    """
    Setup Telegram webhook.

    Args:
        bot_token: Telegram bot token
        tunnel_url: Cloudflare tunnel URL

    Returns:
        True if successful
    """
    print("\n" + "=" * 60)
    print("🔗 Webhook Setup")
    print("=" * 60)
    print(f"\nSetting webhook to: {tunnel_url}")

    success = await tunnel.set_webhook(tunnel_url, bot_token)

    if success:
        print("✅ Webhook configured successfully")
        return True
    else:
        print("❌ Failed to configure webhook")
        print("\n⚠️  This is usually because:")
        print("   1. The Cloudflare tunnel stopped (check if it's still running)")
        print("   2. The tunnel URL has DNS issues (try running setup again)")
        print("   3. Network connectivity issues")
        print("\n📝 You can set the webhook manually later:")
        print(f'   curl "https://api.telegram.org/bot{bot_token}/setWebhook?url={tunnel_url}"')
        return False


async def run_setup_enhanced() -> Config:  # noqa: PLR0915
    """
    Run enhanced interactive setup wizard.

    Guides user through:
    1. Telegram bot token
    2. Automatic chat ID fetching
    3. Cloudflare tunnel setup with URL extraction
    4. Automatic .env file generation
    5. Webhook registration
    6. Crontab configuration

    Returns:
        Configured Config object
    """
    print("\n" + "=" * 60)
    print("🚀 CC-Bridge Enhanced Setup Wizard")
    print("=" * 60)

    # Step 1: Bot Token
    print("\n📝 Step 1: Telegram Bot Token")
    print("-" * 60)
    print("Get your bot token from @BotFather on Telegram")
    bot_token = input("\nEnter your Telegram bot token: ").strip()

    if not bot_token:
        print("❌ Bot token is required")
        raise ValueError("Bot token required")

    # Step 2: Chat ID
    print("\n📝 Step 2: Chat ID Detection")
    print("-" * 60)
    chat_id = await _fetch_chat_id(bot_token)

    if chat_id is None:
        chat_id = input("\nEnter your Chat ID manually: ").strip()
        try:
            chat_id = int(chat_id)
        except ValueError:
            print("❌ Invalid Chat ID")
            raise ValueError("Invalid Chat ID") from None

    # Step 3: Cloudflare Tunnel
    print("\n📝 Step 3: Cloudflare Tunnel")
    print("-" * 60)
    print("Starting Cloudflare tunnel to expose your local server...")

    try:
        tunnel_url = tunnel.start_tunnel(port=8080)
        print(f"✅ Tunnel URL: {tunnel_url}")

        # Wait a moment for DNS to propagate
        print("⏳ Waiting for DNS to propagate...")
        await asyncio.sleep(3)

    except Exception as e:
        print(f"❌ Failed to start tunnel: {e}")
        print("   Please start tunnel manually and enter URL:")
        tunnel_url = input("Tunnel URL: ").strip()

    # Step 4: Generate .env file
    print("\n📝 Step 4: Configuration")
    print("-" * 60)

    env_vars = _generate_env_from_example(bot_token, chat_id, tunnel_url)
    env_path = Path.cwd() / ".env"

    _save_env_file(env_vars, env_path)
    print(f"✅ Configuration saved to: {env_path}")

    # Step 5: Setup Webhook
    await _setup_webhook(bot_token, tunnel_url)

    # Step 6: Setup Crontab
    print("\n📝 Step 5: Health Check Automation")
    print("-" * 60)
    print("Configure crontab for automatic health checks?")

    setup_crontab = input("Setup crontab? (Y/n): ").strip().lower()
    if setup_crontab != "n":
        _setup_crontab()
    else:
        print("   Skipping crontab setup.")

    # Summary
    print("\n" + "=" * 60)
    print("✅ Setup Complete!")
    print("=" * 60)
    print("\nConfiguration:")
    print(f"   Bot Token: {bot_token[:20]}...")
    print(f"   Chat ID: {chat_id}")
    print(f"   Tunnel URL: {tunnel_url}")
    print(f"   Config File: {env_path}")
    print("\nNext steps:")
    print(f"   1. Review configuration in {env_path}")
    print("   2. Start the server: cc-bridge server")
    print("   3. Test by sending a message to your bot")

    # Load and return config
    return Config()


def main() -> int:
    """
    Main entry point for setup command.

    Returns:
        Exit code (0 for success, 1 for error)
    """
    try:
        asyncio.run(run_setup_enhanced())
        return 0
    except KeyboardInterrupt:
        print("\n\n⚠️  Setup cancelled")
        return 130
    except Exception as e:
        logger.error("Setup failed", error=str(e))
        print(f"\n❌ Error during setup: {e}")
        return 1
