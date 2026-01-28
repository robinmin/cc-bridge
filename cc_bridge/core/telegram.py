"""
Telegram API client for cc-bridge.

This module provides a custom Telegram client using httpx for:
- Sending messages to Telegram
- Setting webhooks
- Receiving webhook updates
- Handling bot commands
- Parsing updates (callback/text)
"""

import httpx

from cc_bridge.logging import get_logger

logger = get_logger(__name__)


class TelegramClient:
    """
    Custom Telegram API client using httpx.

    This client provides bidirectional communication with Telegram,
    supporting webhooks, bot commands, and interactive features.
    """

    def __init__(self, bot_token: str):
        """
        Initialize Telegram client.

        Args:
            bot_token: Telegram bot token from BotFather
        """
        self.bot_token = bot_token
        self.base_url = f"https://api.telegram.org/bot{bot_token}"

    async def send_message(
        self,
        chat_id: int,
        text: str,
        parse_mode: str = "HTML",
        disable_web_page_preview: bool = True,
    ) -> dict:
        """
        Send message to Telegram chat.

        Args:
            chat_id: Telegram chat ID
            text: Message text
            parse_mode: Parse mode (HTML, Markdown, MarkdownV2)
            disable_web_page_preview: Disable link previews

        Returns:
            API response
        """
        # TODO: Implement message sending (Task 0004)
        url = f"{self.base_url}/sendMessage"
        async with httpx.AsyncClient() as client:
            response = await client.post(
                url,
                json={
                    "chat_id": chat_id,
                    "text": text,
                    "parse_mode": parse_mode,
                    "disable_web_page_preview": disable_web_page_preview,
                },
            )
            return response.json()

    async def set_webhook(self, url: str, max_connections: int = 40) -> dict:
        """
        Set webhook URL for bot.

        Args:
            url: Webhook URL
            max_connections: Maximum number of concurrent connections

        Returns:
            API response
        """
        # TODO: Implement webhook setting (Task 0004)
        api_url = f"{self.base_url}/setWebhook"
        async with httpx.AsyncClient() as client:
            response = await client.post(
                api_url, json={"url": url, "max_connections": max_connections}
            )
            return response.json()

    async def get_webhook_info(self) -> dict:
        """
        Get current webhook information.

        Returns:
            API response with webhook info
        """
        # TODO: Implement webhook info retrieval (Task 0004)
        url = f"{self.base_url}/getWebhookInfo"
        async with httpx.AsyncClient() as client:
            response = await client.get(url)
            return response.json()

    async def delete_webhook(self) -> dict:
        """
        Delete webhook.

        Returns:
            API response
        """
        # TODO: Implement webhook deletion (Task 0004)
        url = f"{self.base_url}/deleteWebhook"
        async with httpx.AsyncClient() as client:
            response = await client.post(url)
            return response.json()

    async def answer_callback_query(
        self, callback_query_id: str, text: str | None = None
    ) -> dict:
        """
        Answer callback query from inline keyboard.

        Args:
            callback_query_id: Callback query ID
            text: Optional notification text

        Returns:
            API response
        """
        # TODO: Implement callback query answering (Task 0004)
        url = f"{self.base_url}/answerCallbackQuery"
        payload = {"callback_query_id": callback_query_id}
        if text:
            payload["text"] = text

        async with httpx.AsyncClient() as client:
            response = await client.post(url, json=payload)
            return response.json()

    async def get_updates(self, timeout: int = 0, offset: int = 0, limit: int = 1) -> dict:
        """
        Get updates from Telegram (for chat_id detection).

        Args:
            timeout: Polling timeout in seconds
            offset: Update offset
            limit: Maximum number of updates to return

        Returns:
            API response with updates
        """
        url = f"{self.base_url}/getUpdates"
        params = {"offset": offset, "limit": limit}
        if timeout > 0:
            params["timeout"] = timeout

        async with httpx.AsyncClient() as client:
            response = await client.post(url, params=params)
            return response.json()

    async def get_chat_id(self, timeout: int = 30) -> int | None:
        """
        Auto-fetch chat_id by polling for updates.

        User must send a message (e.g., /start) to trigger an update.

        Args:
            timeout: How long to wait for message (seconds)

        Returns:
            Chat ID if found, None otherwise
        """
        import asyncio

        print("⏳ Waiting for you to send /start to your bot...")
        print("   (This allows me to detect your chat ID)")

        # First, try to delete any existing webhook to avoid 409 Conflict
        logger.debug("Checking for existing webhook before polling")
        try:
            webhook_info = await self.get_webhook_info()
            if webhook_info.get("ok") and webhook_info.get("result", {}).get("url"):
                logger.info("Deleting existing webhook to enable polling")
                print("⚠️  Webhook is already set. Deleting temporarily...")
                delete_result = await self.delete_webhook()
                if delete_result.get("ok"):
                    print("✅ Webhook deleted. You can send /start now.")
                    await asyncio.sleep(1)
        except Exception as e:
            logger.debug("Could not check/delete webhook", error=str(e))

        start_time = asyncio.get_event_loop().time()
        while asyncio.get_event_loop().time() - start_time < timeout:
            try:
                response = await self.get_updates(timeout=5)
                if response.get("ok") and response.get("result"):
                    update = response["result"][0]
                    if "message" in update:
                        chat_id = update["message"]["from"]["id"]
                        logger.info("Chat ID detected", chat_id=chat_id)
                        return chat_id
                # Handle 409 Conflict (webhook already set)
                elif response.get("description", "").find("Conflict") != -1:
                    logger.warning("Webhook conflict, attempting to delete")
                    print("⚠️  Webhook is still set. Attempting to delete...")
                    delete_result = await self.delete_webhook()
                    if delete_result.get("ok"):
                        print("✅ Webhook deleted. Please send /start again.")
                        await asyncio.sleep(2)
                        continue
            except Exception as e:
                logger.debug("Waiting for update", error=str(e))
                await asyncio.sleep(2)

        logger.warning("Chat ID not detected", timeout=timeout)
        return None

    async def wait_for_message(
        self, timeout: int = 30
    ) -> dict | None:
        """
        Wait for a message to be sent to the bot.

        Args:
            timeout: How long to wait (seconds)

        Returns:
            First message dict or None
        """
        import asyncio

        start_time = asyncio.get_event_loop().time()
        while asyncio.get_event_loop().time() - start_time < timeout:
            try:
                response = await self.get_updates(timeout=5)
                if response.get("ok") and response.get("result"):
                    return response["result"][0]
            except Exception as e:
                logger.debug("Waiting for message", error=str(e))
                await asyncio.sleep(2)

        return None
