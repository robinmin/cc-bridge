"""
Server command implementation.

This module implements the FastAPI webhook server that receives
Telegram webhooks and injects messages into Claude Code via tmux.
"""

import time
from collections import defaultdict
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request

from cc_bridge.config import get_config
from cc_bridge.core.instances import get_instance_manager
from cc_bridge.core.telegram import TelegramClient
from cc_bridge.core.tmux import get_session
from cc_bridge.logging import get_logger
from cc_bridge.models.telegram import Update

logger = get_logger(__name__)


# Simple in-memory rate limiter
class RateLimiter:
    """
    Simple in-memory rate limiter for webhook endpoint.
    Limits requests per time window per identifier.
    """

    def __init__(self, requests: int, window: int):
        """
        Initialize rate limiter.

        Args:
            requests: Number of requests allowed
            window: Time window in seconds
        """
        self.requests = requests
        self.window = window
        self._timestamps: dict[int, list] = defaultdict(list)

    def is_allowed(self, identifier: int) -> bool:
        """
        Check if request is allowed for this identifier.

        Args:
            identifier: Unique identifier for the requester (e.g., chat_id)

        Returns:
            True if request is allowed, False if rate limited
        """
        now = time.time()

        # Clean old timestamps outside the window
        self._timestamps[identifier] = [
            ts for ts in self._timestamps[identifier] if now - ts < self.window
        ]

        # Check if under the limit
        if len(self._timestamps[identifier]) < self.requests:
            self._timestamps[identifier].append(now)
            return True

        return False

    def get_retry_after(self) -> int:
        """
        Get seconds until next request is allowed.

        Returns:
            Seconds to wait, or 0 if allowed
        """
        if not self._timestamps:
            return 0

        # Get first list from values, then find min timestamp
        first_list = next(iter(self._timestamps.values()))
        oldest = min(first_list)
        retry_after = int(oldest + self.window - time.time())
        return max(0, retry_after)


# Global rate limiter: 10 requests per minute per chat_id
_rate_limiter = None


def get_rate_limiter() -> RateLimiter:
    """Get or create the global rate limiter."""
    global _rate_limiter  # noqa: PLW0603
    if _rate_limiter is None:
        _rate_limiter = RateLimiter(requests=10, window=60)
    return _rate_limiter


# Dependency providers for FastAPI
async def get_instance_manager_dep() -> AsyncGenerator:
    """Get instance manager dependency."""
    manager = get_instance_manager()
    yield manager


async def get_telegram_client_dep() -> AsyncGenerator[TelegramClient | None]:
    """Get telegram client dependency."""
    settings_obj = get_config()
    bot_token = settings_obj.get("telegram.bot_token")
    if bot_token:
        yield TelegramClient(bot_token)
    else:
        yield None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifespan."""
    logger.info("Starting cc-bridge server")
    yield
    logger.info("Shutting down cc-bridge server")


app = FastAPI(title="cc-bridge", version="0.1.0", lifespan=lifespan)


@app.get("/", include_in_schema=False)
async def root():
    """Root endpoint returns 404 to prevent information disclosure."""
    raise HTTPException(status_code=404, detail="Not found")


@app.get("/health")
async def health():
    """Health check endpoint for monitoring."""
    return {"status": "healthy"}


@app.post("/webhook")
async def telegram_webhook(  # noqa: PLR0911, PLR0912, PLR0915
    request: Request,
    update: dict,
    instance_manager=Depends(get_instance_manager_dep),  # noqa: B008
    telegram_client=Depends(get_telegram_client_dep),  # noqa: B008
    rate_limiter: RateLimiter = Depends(get_rate_limiter),  # noqa: B008
):
    """
    Telegram webhook endpoint.

    Receives updates from Telegram and injects messages into Claude Code.

    Args:
        request: FastAPI Request object
        update: Telegram update object
        instance_manager: Instance manager (injected)
        telegram_client: Telegram client (injected)
        rate_limiter: Rate limiter (injected)

    Returns:
        Success response
    """
    # Validate request size before processing (prevent DoS)
    MAX_REQUEST_SIZE = 10_000  # 10KB max request size
    content_length = request.headers.get("content-length", 0)
    if content_length and int(content_length) > MAX_REQUEST_SIZE:
        logger.warning("Request too large", size=int(content_length))
        return {"status": "error", "reason": "Request too large"}, 413  # HTTP 413 Payload Too Large

    # Validate update is not empty
    if not update:
        logger.warning("Empty update received")
        return {"status": "error", "reason": "Empty update"}, 400

    try:
        # Parse the update using Pydantic model
        telegram_update = Update(**update)

        # Extract message from update
        if not telegram_update.message:
            logger.debug("No message in update", update_id=telegram_update.update_id)
            return {"status": "ignored", "reason": "no message"}

        message = telegram_update.message
        if not message.text:
            logger.debug("No text in message", message_id=message.message_id)
            return {"status": "ignored", "reason": "no text"}

        chat_id = message.chat.id
        text = message.text

        # Apply rate limiting (per chat_id)
        if not rate_limiter.is_allowed(chat_id):
            retry_after = rate_limiter.get_retry_after()
            logger.warning("Rate limit exceeded", chat_id=chat_id, retry_after=retry_after)
            return {
                "status": "rate_limited",
                "retry_after": retry_after,
                "message": "Too many requests. Please try again later.",
            }, 429  # HTTP 429 Too Many Requests

        # Validate message length (Telegram max is 4096, but be conservative)
        MAX_MESSAGE_LENGTH = 4000
        if text and len(text) > MAX_MESSAGE_LENGTH:
            logger.warning("Message too long", length=len(text), chat_id=chat_id)
            return {"status": "error", "reason": "Message too long"}, 400

        # Clean and validate the text
        if text:
            # Strip leading/trailing whitespace but preserve internal formatting
            text = text.strip()

        # Skip empty messages after stripping
        if not text:
            logger.debug("Empty message after stripping", message_id=message.message_id)
            return {"status": "ignored", "reason": "empty message"}

        # Check if it's a Telegram command (starts with /)
        # These are handled by Telegram Bot API, not forwarded to Claude
        if text.startswith("/"):
            logger.info("Telegram command received", command=text)
            # Handle basic commands locally
            if text == "/start":
                if telegram_client:
                    await telegram_client.send_message(
                        chat_id,
                        "👋 Welcome to cc-bridge!\n\n"
                        "I'm connected to Claude Code. Send me a message and I'll relay it to Claude.\n\n"
                        "Commands:\n"
                        "/status - Check service status\n"
                        "/help - Show this message",
                    )
                return {"status": "ok"}
            elif text == "/status":
                # Check instance status
                instances = instance_manager.list_instances()
                if instances:
                    instance = instances[0]
                else:
                    instance = None

                status_text = "📊 **Service Status**\n\n"
                status_text += "✅ Server: Running\n"
                if instance:
                    status_text += f"🔌 Instance: {instance.name}\n"
                else:
                    status_text += "🔌 Instance: None\n"
                status_text += "🟢 Tunnel: Active (ccb.robinmin.net)\n"
                if telegram_client:
                    await telegram_client.send_message(chat_id, status_text)
                return {"status": "ok"}
            elif text == "/help":
                if telegram_client:
                    await telegram_client.send_message(
                        chat_id,
                        "📖 **cc-bridge Help**\n\n"
                        "Just send me a message and I'll forward it to Claude Code!\n\n"
                        "Commands:\n"
                        "/status - Check service status\n"
                        "/help - Show this message\n\n"
                        "Your messages are sent directly to your Claude Code instance.",
                    )
                return {"status": "ok"}
            else:
                # Unknown command - ignore
                return {"status": "ignored", "reason": "unknown command"}

        logger.info("Received message", chat_id=chat_id, text=text[:100], text_repr=repr(text[:50]))

        # Verify chat ID is authorized
        settings_obj = get_config()
        expected_chat_id = settings_obj.get("telegram.chat_id")
        if expected_chat_id and chat_id != int(expected_chat_id):
            logger.warning("Unauthorized chat ID", chat_id=chat_id, expected=expected_chat_id)
            return {"status": "ignored", "reason": "unauthorized"}

        # Find running Claude instance
        instances = instance_manager.list_instances()
        if not instances:
            logger.warning("No Claude instances found")
            if telegram_client:
                await telegram_client.send_message(
                    chat_id,
                    "⚠️ No Claude instance running. Start one with: cc-bridge claude start <name>",
                )
            return {"status": "error", "reason": "no instance"}

        # Use the first running instance (or default instance)
        instance = instances[0]
        session = get_session(instance.name)

        if not session.session_exists():
            logger.warning("Instance session not running", instance=instance.name)
            if telegram_client:
                await telegram_client.send_message(
                    chat_id,
                    f"⚠️ Claude instance '{instance.name}' is not running. Start it with: cc-bridge claude start {instance.name}",
                )
            return {"status": "error", "reason": "instance not running"}

        # Update instance activity
        instance_manager.update_instance_activity(instance.name)

        # Send command to Claude and wait for response
        logger.info("Sending to Claude", instance=instance.name, text=text, text_repr=repr(text))

        # For simple text messages, just send them directly
        success, output = await session.send_command_and_wait(text, timeout=60.0)

        logger.info(
            "Claude response",
            success=success,
            output_length=len(output) if output else 0,
            output_preview=(output[:100] if output else "None"),
        )

        if success and output:
            # Clean up output (remove prompts, etc.)
            clean_output = _clean_claude_output(output)

            # Send response back to Telegram
            if telegram_client:
                # Truncate if too long (Telegram limit is 4096)
                if len(clean_output) > 4000:
                    clean_output = clean_output[:4000] + "\n\n... (truncated)"

                await telegram_client.send_message(chat_id, clean_output)
                logger.info("Response sent", chat_id=chat_id, length=len(clean_output))
        # Command failed or timed out
        elif telegram_client:
            await telegram_client.send_message(
                chat_id,
                f"⚠️ Claude command timed out or failed. Output: {output[:200] if output else 'No output'}",
            )

        return {"status": "ok"}

    except Exception as e:
        logger.error("Webhook processing error", error=str(e), exc_info=True)
        return {"status": "error", "reason": "Processing failed"}, 500


def _clean_claude_output(output: str) -> str:
    """
    Clean Claude Code output for sending to Telegram.

    Removes prompts, extra whitespace, and formatting artifacts.

    Args:
        output: Raw output from Claude Code session

    Returns:
        Cleaned output string
    """
    if not output:
        return ""

    lines = output.split("\n")

    # Remove common prompt patterns and artifacts
    cleaned = []
    for line in lines:
        stripped = line.strip()

        # Skip empty lines at the start
        if not cleaned and not stripped:
            continue

        # Skip prompt lines (various Claude Code prompt styles)
        # - Just a prompt: ">", "> ", "»"
        # - Path prompt: "~/project> ", "/path> "
        # - Multi-char prompt that's mostly special chars
        if stripped in ("❯", ">", "»") or (  # noqa: RUF001
            stripped.startswith(("❯", ">", "»"))  # noqa: RUF001
            and len(stripped) < 20
            and sum(c.isalnum() or c.isspace() for c in stripped) < 5
        ):
            continue

        # Skip separator lines (───────)
        if len(stripped) > 10 and all(c in "─═━─│┌┐└┘" for c in stripped):
            continue

        cleaned.append(line)

    result = "\n".join(cleaned).strip()

    # Limit excessive blank lines
    while "\n\n\n" in result:
        result = result.replace("\n\n\n", "\n\n")

    return result


def start_server(host: str = "0.0.0.0", port: int = 8080, reload: bool = False):
    """
    Start the uvicorn server.

    Args:
        host: Server host address
        port: Server port
        reload: Enable auto-reload for development
    """
    uvicorn.run("cc_bridge.commands.server:app", host=host, port=port, reload=reload)
