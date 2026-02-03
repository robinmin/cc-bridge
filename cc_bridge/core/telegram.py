"""
Telegram API client for cc-bridge.

This module provides a custom Telegram client using httpx for:
- Sending messages to Telegram
- Setting webhooks
- Receiving webhook updates
- Handling bot commands
- Parsing updates (callback/text)
"""

import asyncio

import httpx

from cc_bridge.packages.exceptions import TelegramTimeoutError
from cc_bridge.packages.logging import get_logger

logger = get_logger(__name__)

# Default timeout settings (in seconds)
DEFAULT_CONNECT_TIMEOUT = 10.0
DEFAULT_READ_TIMEOUT = 30.0
DEFAULT_WRITE_TIMEOUT = 10.0
DEFAULT_POOL_TIMEOUT = 5.0

# Retry settings for transient failures
MAX_RETRIES = 3
BASE_BACKOFF = 1.0  # Base backoff in seconds
MAX_BACKOFF = 30.0  # Maximum backoff in seconds

# Default bot commands for Telegram
DEFAULT_BOT_COMMANDS = [
    {"command": "status", "description": "Check service status"},
    {"command": "clear", "description": "Clear Claude conversation"},
    {"command": "stop", "description": "Interrupt Claude current action"},
    {"command": "resume", "description": "Resumes the last active session"},
    {"command": "help", "description": "Show help message"},
]


async def _retry_with_backoff(  # noqa: PLR0912
    func,
    max_retries: int = MAX_RETRIES,
    base_backoff: float = BASE_BACKOFF,
    max_backoff: float = MAX_BACKOFF,
):
    """
    Retry function with exponential backoff for transient failures.

    Retries on:
    - httpx.TimeoutException (network timeouts)
    - httpx.NetworkError (connection errors)
    - httpx.HTTPStatusError for status >= 500 (server errors)

    Does not retry on:
    - 4xx errors (except 429 rate limit)
    - Other exceptions

    Args:
        func: Async function to retry
        max_retries: Maximum number of retry attempts
        base_backoff: Base backoff delay in seconds
        max_backoff: Maximum backoff delay in seconds

    Returns:
        Result of func()

    Raises:
        Exception: The last exception if all retries fail
    """
    last_exception = None

    for attempt in range(max_retries + 1):
        try:
            return await func()
        except httpx.TimeoutException as e:
            last_exception = e
            if attempt < max_retries:
                delay = min(base_backoff * (2**attempt), max_backoff)
                logger.warning(
                    "Telegram API timeout, retrying",
                    attempt=attempt + 1,
                    max_retries=max_retries,
                    delay=f"{delay:.1f}s",
                    error=str(e),
                )
                await asyncio.sleep(delay)
            else:
                logger.error(
                    "Telegram API timeout, max retries exceeded", attempts=attempt + 1
                )
        except httpx.NetworkError as e:
            last_exception = e
            if attempt < max_retries:
                delay = min(base_backoff * (2**attempt), max_backoff)
                logger.warning(
                    "Telegram network error, retrying",
                    attempt=attempt + 1,
                    max_retries=max_retries,
                    delay=f"{delay:.1f}s",
                    error=str(e),
                )
                await asyncio.sleep(delay)
            else:
                logger.error(
                    "Network error, max retries exceeded", attempts=attempt + 1
                )
        except httpx.HTTPStatusError as e:
            last_exception = e
            status_code = e.response.status_code

            # Handle rate limit (429) with Retry-After header
            if status_code == 429:
                retry_after = int(e.response.headers.get("Retry-After", base_backoff))
                if attempt < max_retries:
                    logger.warning(
                        "Telegram rate limit exceeded, respecting Retry-After",
                        attempt=attempt + 1,
                        max_retries=max_retries,
                        retry_after=f"{retry_after}s",
                    )
                    await asyncio.sleep(retry_after)
                    continue
                else:
                    logger.error(
                        "Rate limit exceeded, max retries exceeded",
                        attempts=attempt + 1,
                    )

            # Retry on server errors (5xx)
            if status_code >= 500:
                if attempt < max_retries:
                    delay = min(base_backoff * (2**attempt), max_backoff)
                    logger.warning(
                        "Telegram server error, retrying",
                        attempt=attempt + 1,
                        max_retries=max_retries,
                        status_code=status_code,
                        delay=f"{delay:.1f}s",
                    )
                    await asyncio.sleep(delay)
                else:
                    logger.error(
                        "Server error, max retries exceeded", attempts=attempt + 1
                    )
            else:
                # Don't retry other status codes (4xx except 429)
                logger.error("Non-retryable HTTP error", status_code=status_code)
                raise

        # If not caught above, re-raise
        if last_exception:
            raise last_exception

    # Should not reach here, but just in case
    if last_exception:
        raise last_exception


class TelegramClient:
    """
    Custom Telegram API client using httpx.

    This client provides bidirectional communication with Telegram,
    supporting webhooks, bot commands, and interactive features.

    Uses a persistent httpx.AsyncClient with connection pooling
    to avoid resource leaks and improve performance.

    All HTTP requests use configured timeouts to prevent hanging.
    """

    def __init__(
        self,
        bot_token: str,
        connect_timeout: float = DEFAULT_CONNECT_TIMEOUT,
        read_timeout: float = DEFAULT_READ_TIMEOUT,
        write_timeout: float = DEFAULT_WRITE_TIMEOUT,
        pool_timeout: float = DEFAULT_POOL_TIMEOUT,
        max_connections: int = 10,
        max_keepalive_connections: int = 5,
    ):
        """
        Initialize Telegram client.

        Args:
            bot_token: Telegram bot token from BotFather
            connect_timeout: Connection establishment timeout (seconds)
            read_timeout: Response read timeout (seconds)
            write_timeout: Request write timeout (seconds)
            pool_timeout: Connection pool acquisition timeout (seconds)
            max_connections: Maximum number of concurrent connections
            max_keepalive_connections: Maximum number of keepalive connections
        """
        self.bot_token = bot_token
        self.base_url = f"https://api.telegram.org/bot{bot_token}"

        # Configure comprehensive timeouts
        self._timeout = httpx.Timeout(
            connect=connect_timeout,
            read=read_timeout,
            write=write_timeout,
            pool=pool_timeout,
        )

        self._max_connections = max_connections
        self._max_keepalive_connections = max_keepalive_connections
        self._client: httpx.AsyncClient | None = None

    async def _get_client(self) -> httpx.AsyncClient:
        """
        Get or create the persistent httpx client.

        Uses lazy initialization and connection pooling with timeouts.

        Returns:
            httpx.AsyncClient instance
        """
        if self._client is None:
            # Create persistent client with connection pooling and timeouts
            self._client = httpx.AsyncClient(
                timeout=self._timeout,
                limits=httpx.Limits(
                    max_keepalive_connections=self._max_keepalive_connections,
                    max_connections=self._max_connections,
                ),
            )
            logger.debug(
                "Created persistent httpx client for Telegram",
                connect_timeout=self._timeout.connect,
                read_timeout=self._timeout.read,
                write_timeout=self._timeout.write,
                pool_timeout=self._timeout.pool,
            )
        return self._client

    async def close(self) -> None:
        """
        Close the httpx client and release resources.

        Should be called when the TelegramClient is no longer needed.
        """
        if self._client is not None:
            await self._client.aclose()
            self._client = None
            logger.debug("Closed httpx client for Telegram")

    async def __aenter__(self):
        """
        Async context manager entry.

        Returns:
            self
        """
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """
        Async context manager exit.

        Ensures client is properly closed.
        """
        await self.close()
        return False

    async def send_message(
        self,
        chat_id: int,
        text: str,
        parse_mode: str = "HTML",
        disable_web_page_preview: bool = True,
    ) -> dict:
        """
        Send message to Telegram chat with retry logic.

        Args:
            chat_id: Telegram chat ID
            text: Message text
            parse_mode: Parse mode (HTML, Markdown, MarkdownV2)
            disable_web_page_preview: Disable link previews

        Returns:
            API response

        Raises:
            TelegramTimeoutError: If request times out after retries
            httpx.HTTPStatusError: For non-retryable HTTP errors
        """
        url = f"{self.base_url}/sendMessage"

        async def _do_send():
            # Escape HTML if parse_mode is HTML
            escaped_text = text
            if parse_mode == "HTML":
                import html

                escaped_text = html.escape(text)

            client = await self._get_client()
            response = await client.post(
                url,
                json={
                    "chat_id": chat_id,
                    "text": escaped_text,
                    "parse_mode": parse_mode,
                    "disable_web_page_preview": disable_web_page_preview,
                },
            )
            # Raise for status to catch 5xx errors for retry
            response.raise_for_status()
            return response.json()

        try:
            return await _retry_with_backoff(_do_send)
        except httpx.TimeoutException as e:
            logger.error("Telegram API timeout after retries", url=url, error=str(e))
            raise TelegramTimeoutError(
                f"Telegram API request timed out after {self._timeout.read}s"
            ) from e

    async def set_webhook(self, url: str, max_connections: int = 40) -> dict:
        """
        Set webhook URL for bot with retry logic.

        Args:
            url: Webhook URL
            max_connections: Maximum number of concurrent connections

        Returns:
            API response

        Raises:
            TelegramTimeoutError: If request times out after retries
            httpx.HTTPStatusError: For non-retryable HTTP errors
        """
        api_url = f"{self.base_url}/setWebhook"

        async def _do_set():
            client = await self._get_client()
            response = await client.post(
                api_url, json={"url": url, "max_connections": max_connections}
            )
            response.raise_for_status()
            return response.json()

        try:
            return await _retry_with_backoff(_do_set)
        except httpx.TimeoutException as e:
            logger.error(
                "Telegram API timeout after retries", url=api_url, error=str(e)
            )
            raise TelegramTimeoutError(
                f"Telegram API request timed out after {self._timeout.read}s"
            ) from e

    async def get_webhook_info(self) -> dict:
        """
        Get current webhook information with retry logic.

        Returns:
            API response with webhook info

        Raises:
            TelegramTimeoutError: If request times out after retries
            httpx.HTTPStatusError: For non-retryable HTTP errors
        """
        url = f"{self.base_url}/getWebhookInfo"

        async def _do_get():
            client = await self._get_client()
            response = await client.get(url)
            response.raise_for_status()
            return response.json()

        try:
            return await _retry_with_backoff(_do_get)
        except httpx.TimeoutException as e:
            logger.error("Telegram API timeout after retries", url=url, error=str(e))
            raise TelegramTimeoutError(
                f"Telegram API request timed out after {self._timeout.read}s"
            ) from e

    async def delete_webhook(self) -> dict:
        """
        Delete webhook with retry logic.

        Returns:
            API response

        Raises:
            TelegramTimeoutError: If request times out after retries
            httpx.HTTPStatusError: For non-retryable HTTP errors
        """
        url = f"{self.base_url}/deleteWebhook"

        async def _do_delete():
            client = await self._get_client()
            response = await client.post(url)
            response.raise_for_status()
            return response.json()

        try:
            return await _retry_with_backoff(_do_delete)
        except httpx.TimeoutException as e:
            logger.error("Telegram API timeout after retries", url=url, error=str(e))
            raise TelegramTimeoutError(
                f"Telegram API request timed out after {self._timeout.read}s"
            ) from e

    async def answer_callback_query(
        self, callback_query_id: str, text: str | None = None
    ) -> dict:
        """
        Answer callback query from inline keyboard with retry logic.

        Args:
            callback_query_id: Callback query ID
            text: Optional notification text

        Returns:
            API response

        Raises:
            TelegramTimeoutError: If request times out after retries
            httpx.HTTPStatusError: For non-retryable HTTP errors
        """
        url = f"{self.base_url}/answerCallbackQuery"
        payload = {"callback_query_id": callback_query_id}
        if text:
            payload["text"] = text

        async def _do_answer():
            client = await self._get_client()
            response = await client.post(url, json=payload)
            response.raise_for_status()
            return response.json()

        try:
            return await _retry_with_backoff(_do_answer)
        except httpx.TimeoutException as e:
            logger.error("Telegram API timeout after retries", url=url, error=str(e))
            raise TelegramTimeoutError(
                f"Telegram API request timed out after {self._timeout.read}s"
            ) from e

    async def get_updates(
        self, timeout: int = 0, offset: int = 0, limit: int = 1
    ) -> dict:
        """
        Get updates from Telegram with retry logic (for chat_id detection).

        Args:
            timeout: Polling timeout in seconds
            offset: Update offset
            limit: Maximum number of updates to return

        Returns:
            API response with updates

        Raises:
            TelegramTimeoutError: If request times out after retries
            httpx.HTTPStatusError: For non-retryable HTTP errors
        """
        url = f"{self.base_url}/getUpdates"
        params = {"offset": offset, "limit": limit}
        if timeout > 0:
            params["timeout"] = timeout

        async def _do_get():
            client = await self._get_client()
            response = await client.post(url, params=params)
            response.raise_for_status()
            return response.json()

        try:
            return await _retry_with_backoff(_do_get)
        except httpx.TimeoutException as e:
            logger.error("Telegram API timeout after retries", url=url, error=str(e))
            raise TelegramTimeoutError(
                f"Telegram API request timed out after {self._timeout.read}s"
            ) from e

    async def get_chat_id(self, timeout: int = 30) -> int | None:
        """
        Auto-fetch chat_id by polling for updates.

        User must send a message (e.g., /start) to trigger an update.

        Args:
            timeout: How long to wait for message (seconds)

        Returns:
            Chat ID if found, None otherwise
        """
        print("⏳ Waiting for you to send /start to your bot...")
        print("   (This allows me to detect your chat ID)")
        logger.info("Waiting for user to send /start command to detect chat ID")

        # First, try to delete any existing webhook to avoid 409 Conflict
        logger.debug("Checking for existing webhook before polling")
        try:
            webhook_info = await self.get_webhook_info()
            if webhook_info.get("ok") and webhook_info.get("result", {}).get("url"):
                logger.info("Deleting existing webhook to enable polling")
                print("⚠️  Webhook is already set. Deleting temporarily...")
                delete_result = await self.delete_webhook()
                if delete_result.get("ok"):
                    logger.info("Webhook deleted successfully")
                    print("✅ Webhook deleted. You can send /start now.")
                    await asyncio.sleep(1)
        except TelegramTimeoutError:
            logger.warning("Timeout while checking webhook, continuing")
        except Exception as e:
            logger.debug("Could not check/delete webhook", error=str(e))

        start_time = asyncio.get_running_loop().time()
        while asyncio.get_running_loop().time() - start_time < timeout:
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
                        logger.info("Webhook deleted, user should retry /start")
                        print("✅ Webhook deleted. Please send /start again.")
                        await asyncio.sleep(2)
                        continue
            except TelegramTimeoutError:
                logger.debug("Timeout while polling for updates, continuing")
                await asyncio.sleep(2)
            except Exception as e:
                logger.debug("Waiting for update", error=str(e))
                await asyncio.sleep(2)

        logger.warning("Chat ID not detected", timeout=timeout)
        return None

    async def wait_for_message(self, timeout: int = 30) -> dict | None:
        """
        Wait for a message to be sent to the bot.

        Args:
            timeout: How long to wait (seconds)

        Returns:
            First message dict or None
        """
        start_time = asyncio.get_running_loop().time()
        while asyncio.get_running_loop().time() - start_time < timeout:
            try:
                response = await self.get_updates(timeout=5)
                if response.get("ok") and response.get("result"):
                    return response["result"][0]
            except TelegramTimeoutError:
                logger.debug("Timeout while waiting for message, continuing")
                await asyncio.sleep(2)
            except Exception as e:
                logger.debug("Waiting for message", error=str(e))
                await asyncio.sleep(2)

        return None

    async def set_bot_commands(
        self, commands: list[dict], language_code: str = ""
    ) -> dict:
        """
        Set bot commands for Telegram with retry logic.

        Args:
            commands: List of command dictionaries with 'command' and 'description' keys
            language_code: Optional language code for localized commands (e.g., 'en')

        Returns:
            API response

        Raises:
            TelegramTimeoutError: If request times out after retries
            httpx.HTTPStatusError: For non-retryable HTTP errors
        """
        url = f"{self.base_url}/setMyCommands"
        payload = {"commands": commands}
        if language_code:
            payload["language_code"] = language_code

        async def _do_set():
            client = await self._get_client()
            response = await client.post(url, json=payload)
            response.raise_for_status()
            return response.json()

        try:
            result = await _retry_with_backoff(_do_set)
            logger.info("Bot commands set successfully", count=len(commands))
            return result
        except httpx.TimeoutException as e:
            logger.error("Telegram API timeout after retries", url=url, error=str(e))
            raise TelegramTimeoutError(
                f"Telegram API request timed out after {self._timeout.read}s"
            ) from e

    async def get_bot_commands(self, language_code: str = "") -> dict:
        """
        Get current bot commands from Telegram with retry logic.

        Args:
            language_code: Optional language code for localized commands

        Returns:
            API response with list of commands

        Raises:
            TelegramTimeoutError: If request times out after retries
            httpx.HTTPStatusError: For non-retryable HTTP errors
        """
        url = f"{self.base_url}/getMyCommands"
        params = {}
        if language_code:
            params["language_code"] = language_code

        async def _do_get():
            client = await self._get_client()
            response = await client.get(url, params=params)
            response.raise_for_status()
            return response.json()

        try:
            return await _retry_with_backoff(_do_get)
        except httpx.TimeoutException as e:
            logger.error("Telegram API timeout after retries", url=url, error=str(e))
            raise TelegramTimeoutError(
                f"Telegram API request timed out after {self._timeout.read}s"
            ) from e

    async def delete_bot_commands(self, language_code: str = "") -> dict:
        """
        Delete all bot commands for Telegram with retry logic.

        Args:
            language_code: Optional language code for localized commands

        Returns:
            API response

        Raises:
            TelegramTimeoutError: If request times out after retries
            httpx.HTTPStatusError: For non-retryable HTTP errors
        """
        url = f"{self.base_url}/deleteMyCommands"
        params = {}
        if language_code:
            params["language_code"] = language_code

        async def _do_delete():
            client = await self._get_client()
            response = await client.post(url, params=params)
            response.raise_for_status()
            return response.json()

        try:
            result = await _retry_with_backoff(_do_delete)
            logger.info("Bot commands deleted successfully")
            return result
        except httpx.TimeoutException as e:
            logger.error("Telegram API timeout after retries", url=url, error=str(e))
            raise TelegramTimeoutError(
                f"Telegram API request timed out after {self._timeout.read}s"
            ) from e
