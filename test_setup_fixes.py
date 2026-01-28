#!/usr/bin/env python3
"""
Test script to verify setup fixes work correctly.
This tests the webhook deletion and chat ID detection flow.
"""

import asyncio

from cc_bridge.core.telegram import TelegramClient


async def test_telegram_client():
    """Test Telegram client with webhook deletion."""
    print("=== Testing Telegram Client Fixes ===\n")

    bot_token = input("Enter your Telegram bot token (for testing): ").strip()

    if not bot_token:
        print("⚠️  No token provided, skipping test")
        return

    client = TelegramClient(bot_token)

    print("\n1. Checking webhook status...")
    try:
        webhook_info = await client.get_webhook_info()
        if webhook_info.get("ok"):
            result = webhook_info.get("result", {})
            if result.get("url"):
                print(f"   Current webhook: {result['url']}")
                print("\n2. Attempting to delete webhook...")
                delete_result = await client.delete_webhook()
                if delete_result.get("ok"):
                    print("   ✅ Webhook deleted successfully")
                else:
                    print(f"   ❌ Failed to delete: {delete_result}")
            else:
                print("   ✅ No webhook set (can poll directly)")
    except Exception as e:
        print(f"   ❌ Error checking webhook: {e}")

    print("\n3. Now you can send /start to your bot...")
    print("   (We'll wait 30 seconds for your message)")

    try:
        chat_id = await client.get_chat_id(timeout=30)
        if chat_id:
            print(f"\n   ✅ SUCCESS! Chat ID detected: {chat_id}")
        else:
            print("\n   ❌ Could not detect chat ID automatically")
            print("   You may need to enter it manually during setup")
    except Exception as e:
        print(f"\n   ❌ Error: {e}")

    print("\n=== Test Complete ===")


if __name__ == "__main__":
    asyncio.run(test_telegram_client())
