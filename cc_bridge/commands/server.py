"""
Server command implementation.

This module implements the FastAPI webhook server that receives
Telegram webhooks and injects messages into Claude Code via tmux or Docker.
"""

import asyncio
import html
import signal
import time
from collections import defaultdict
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from urllib.parse import urlparse

import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from cc_bridge.config import get_config
from cc_bridge.constants import (
    DEFAULT_RATE_LIMIT_REQUESTS,
    DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
    MAX_MESSAGE_LENGTH,
    MAX_REQUEST_SIZE,
    SERVER_SHUTDOWN_TIMEOUT,
    TELEGRAM_MAX_MESSAGE_LENGTH,
    TELEGRAM_TRUNCATED_MESSAGE_SUFFIX,
)
from cc_bridge.core.instance_interface import get_instance_adapter
from cc_bridge.core.instances import get_instance_manager
from cc_bridge.core.telegram import TelegramClient
from cc_bridge.logging import get_logger
from cc_bridge.models.instances import ClaudeInstance
from cc_bridge.models.telegram import Update

logger = get_logger(__name__)


class GracefulShutdown:
    """
    Manages graceful shutdown of the FastAPI server.

    Tracks pending requests and waits for them to complete during shutdown.
    """

    def __init__(self, timeout: float = SERVER_SHUTDOWN_TIMEOUT):
        """
        Initialize graceful shutdown handler.

        Args:
            timeout: Maximum seconds to wait for pending requests
        """
        self._shutdown_event = asyncio.Event()
        self._pending_requests = 0
        self._lock = asyncio.Lock()
        self._timeout = timeout

    async def increment_requests(self) -> None:
        """Increment pending request count."""
        async with self._lock:
            self._pending_requests += 1

    async def decrement_requests(self) -> None:
        """Decrement pending request count."""
        async with self._lock:
            self._pending_requests -= 1

    async def wait_for_shutdown(self) -> None:
        """
        Wait for pending requests to complete during shutdown.

        Logs progress and enforces timeout.
        """
        try:
            # Wait for pending requests with timeout
            start_time = time.time()
            while self._pending_requests > 0:
                elapsed = time.time() - start_time
                if elapsed >= self._timeout:
                    logger.warning(
                        "Shutdown timeout reached",
                        pending=self._pending_requests,
                        timeout=self._timeout,
                    )
                    break

                # Log progress every 5 seconds
                if int(elapsed) % 5 == 0 and self._pending_requests > 0:
                    logger.info(
                        "Waiting for pending requests",
                        pending=self._pending_requests,
                        elapsed=f"{elapsed:.1f}s",
                    )

                await asyncio.sleep(0.1)

            logger.info("Shutdown complete", pending=self._pending_requests)

        except Exception as e:
            logger.error("Error during shutdown", error=str(e), exc_info=True)

    def is_shutting_down(self) -> bool:
        """Check if shutdown has been initiated."""
        return self._shutdown_event.is_set()

    @property
    def pending_requests(self) -> int:
        """Get current pending request count."""
        return self._pending_requests


# Global graceful shutdown handler
_shutdown_handler: GracefulShutdown | None = None

# Server start time for uptime tracking
_server_start_time: float | None = None


def get_shutdown_handler() -> GracefulShutdown:
    """Get or create the global shutdown handler."""
    global _shutdown_handler  # noqa: PLW0603
    if _shutdown_handler is None:
        _shutdown_handler = GracefulShutdown()
    return _shutdown_handler


def get_server_uptime() -> float:
    """Get server uptime in seconds."""
    if _server_start_time is None:
        return 0.0
    return time.time() - _server_start_time


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
        self._lock = asyncio.Lock()

    async def is_allowed(self, identifier: int) -> bool:
        """
        Check if request is allowed for this identifier.

        Args:
            identifier: Unique identifier for the requester (e.g., chat_id)

        Returns:
            True if request is allowed, False if rate limited
        """
        async with self._lock:
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

    async def get_retry_after(self, identifier: int) -> int:
        """
        Get seconds until next request is allowed for a specific identifier.

        Args:
            identifier: Unique identifier for the requester (e.g., chat_id)

        Returns:
            Seconds to wait, or 0 if allowed
        """
        async with self._lock:
            if identifier not in self._timestamps:
                return 0

            # Get the oldest timestamp for this identifier
            timestamps = self._timestamps[identifier]
            if not timestamps:
                return 0

            oldest = min(timestamps)
            retry_after = int(oldest + self.window - time.time())
            return max(0, retry_after)


# Global rate limiter: 10 requests per minute per chat_id
_rate_limiter: RateLimiter | None = None


def get_rate_limiter() -> RateLimiter:
    """Get or create the global rate limiter."""
    global _rate_limiter  # noqa: PLW0603
    if _rate_limiter is None:
        _rate_limiter = RateLimiter(
            requests=DEFAULT_RATE_LIMIT_REQUESTS, window=DEFAULT_RATE_LIMIT_WINDOW_SECONDS
        )
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
    """
    Manage application lifespan with graceful shutdown.

    Sets up signal handlers for SIGTERM/SIGINT and waits for pending
    requests to complete during shutdown.
    """
    shutdown_handler = get_shutdown_handler()

    # Setup signal handlers for graceful shutdown
    loop = asyncio.get_running_loop()

    def handle_shutdown_signal():
        """Handle shutdown signal by setting the event."""
        if not shutdown_handler.is_shutting_down():
            logger.info("Shutdown signal received")
            shutdown_handler._shutdown_event.set()

    # Register signal handlers
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, handle_shutdown_signal)

    # Set server start time for uptime tracking
    global _server_start_time  # noqa: PLW0603
    _server_start_time = time.time()

    logger.info("Starting cc-bridge server", shutdown_timeout=shutdown_handler._timeout)

    # Initial Docker discovery
    instance_manager = get_instance_manager()
    await instance_manager.refresh_discovery()

    yield

    # Graceful shutdown
    logger.info("Initiating graceful shutdown...")
    await shutdown_handler.wait_for_shutdown()


app = FastAPI(title="cc-bridge", version="0.1.0", lifespan=lifespan)


@app.middleware("http")
async def track_requests(request: Request, call_next):
    """
    Middleware to track pending requests for graceful shutdown.

    Increments pending count before request and decrements after.
    """
    shutdown_handler = get_shutdown_handler()

    # Don't process new requests during shutdown
    if shutdown_handler.is_shutting_down():
        return JSONResponse(
            status_code=503,
            content={"status": "error", "reason": "Server is shutting down"},
        )

    # Increment pending requests
    await shutdown_handler.increment_requests()

    try:
        # Process the request
        response = await call_next(request)
        return response
    finally:
        # Always decrement pending requests, even if error occurs
        await shutdown_handler.decrement_requests()


@app.get("/", include_in_schema=False)
async def root():
    """Root endpoint returns 404 to prevent information disclosure."""
    raise HTTPException(status_code=404, detail="Not found")


@app.get("/health")
async def health():
    """
    Health check endpoint for monitoring.

    Returns detailed server status including uptime, instance counts,
    and pending requests.
    """
    shutdown_handler = get_shutdown_handler()
    instance_manager = get_instance_manager()

    # Get instance statistics
    instances = instance_manager.list_instances()
    instance_stats = {
        "total": len(instances),
        "running": 0,
        "stopped": 0,
        "tmux": 0,
        "docker": 0,
    }

    for instance in instances:
        # Check actual status
        status = await instance_manager.aget_instance_status(instance.name)
        if status == "running":
            instance_stats["running"] += 1
        else:
            instance_stats["stopped"] += 1

        # Count by type
        if instance.instance_type == "tmux":
            instance_stats["tmux"] += 1
        elif instance.instance_type == "docker":
            instance_stats["docker"] += 1

    # Subtract 1 from pending_requests since this health check request itself is counted
    pending = max(0, shutdown_handler.pending_requests - 1)

    return {
        "status": "healthy",
        "uptime_seconds": round(get_server_uptime(), 1),
        "instances": instance_stats,
        "pending_requests": pending,
        "version": app.version,
    }


async def _select_instance(instances: list) -> ClaudeInstance | None:
    """
    Select the best instance to use from a list.

    Args:
        instances: List of ClaudeInstance objects

    Returns:
        Selected instance or None if no running instance found
    """
    settings_obj = get_config()
    docker_preferred = settings_obj.get("docker.preferred", False)
    instance_manager = get_instance_manager()

    # Filter running instances by checking actual status
    running = []
    for i in instances:
        status = await instance_manager.aget_instance_status(i.name)
        if status == "running":
            running.append(i)

    if not running:
        return None

    # If only one running instance, use it
    if len(running) == 1:
        return running[0]

    # Select based on preference
    for instance in running:
        if (docker_preferred and instance.instance_type == "docker") or (
            not docker_preferred and instance.instance_type == "tmux"
        ):
            return instance

    # Fallback to first running instance
    return running[0]


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
    content_length = request.headers.get("content-length", 0)
    if content_length and int(content_length) > MAX_REQUEST_SIZE:
        logger.warning("Request too large", size=int(content_length))
        return JSONResponse(
            status_code=413,
            content={"status": "error", "reason": "Request too large"},
        )

    # Validate update is not empty
    if not update:
        logger.warning("Empty update received")
        return JSONResponse(
            status_code=400,
            content={"status": "error", "reason": "Empty update"},
        )

    try:
        # Parse the update using Pydantic model
        telegram_update = Update(**update)
        logger.debug("Received webhook update", update_id=telegram_update.update_id)

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
        if not await rate_limiter.is_allowed(chat_id):
            retry_after = await rate_limiter.get_retry_after(chat_id)
            logger.warning("Rate limit exceeded", chat_id=chat_id, retry_after=retry_after)
            return JSONResponse(
                status_code=429,
                content={
                    "status": "rate_limited",
                    "retry_after": retry_after,
                    "message": "Too many requests. Please try again later.",
                },
            )

        # Validate message length (Telegram max is 4096, but be conservative)
        if text and len(text) > MAX_MESSAGE_LENGTH:
            logger.warning("Message too long", length=len(text), chat_id=chat_id)
            return JSONResponse(
                status_code=400,
                content={"status": "error", "reason": "Message too long"},
            )

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

                config_obj = get_config()
                tunnel_url = config_obj.get("tunnel.url", "")

                status_text = "📊 **Service Status**\n\n"
                status_text += "✅ Server: Running\n"
                if instance:
                    status_text += f"🔌 Instance: {instance.name}\n"
                else:
                    status_text += "🔌 Instance: None\n"

                if tunnel_url:
                    # Extract domain from URL for display (avoid showing full URL)
                    parsed = urlparse(tunnel_url)
                    domain = parsed.netloc or tunnel_url
                    status_text += f"🟢 Tunnel: Active ({domain})\n"
                else:
                    status_text += "⚠️  Tunnel: Not configured\n"

                if telegram_client:
                    logger.debug(f"=> {status_text}")
                    await telegram_client.send_message(chat_id, status_text)
                return {"status": "ok"}
            elif text == "/help":
                if telegram_client:
                    help_message = (
                        "📖 **cc-bridge Help**\n\n"
                        "Just send me a message and I'll forward it to Claude Code!\n\n"
                        "Commands:\n"
                        "/status - Check service status\n"
                        "/help - Show this message\n\n"
                        "Your messages are sent directly to your Claude Code instance."
                    )
                    logger.debug(f"=> {help_message}")
                    await telegram_client.send_message(chat_id, help_message)
                return {"status": "ok"}
            else:
                # Unknown command - ignore
                return {"status": "ignored", "reason": "unknown command"}

        logger.info("Received message from Telegram", chat_id=chat_id, text=text[:50])
        logger.debug(f"<= {text}")

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
                msg = "⚠️ No Claude instance running. Start one with: cc-bridge claude start <name>"
                logger.debug(f"=> {msg}")
                await telegram_client.send_message(chat_id, msg)
            return {"status": "error", "reason": "no instance"}

        # Select instance based on configuration and running status
        instance = await _select_instance(instances)
        if not instance:
            logger.warning("No running Claude instance found")
            if telegram_client:
                msg = "⚠️ No running Claude instance found. Start one with: cc-bridge claude start <name>"
                logger.debug(f"=> {msg}")
                await telegram_client.send_message(chat_id, msg)
            return {"status": "error", "reason": "no running instance"}

        # Assert for type checker - we've already checked instance is not None
        assert instance is not None

        # Get the appropriate adapter for this instance type
        try:
            adapter = get_instance_adapter(instance)
        except (ValueError, NotImplementedError) as e:
            logger.warning("Instance adapter creation failed", instance=instance.name, error=str(e))
            if telegram_client:
                msg = f"⚠️ Instance '{instance.name}' is not supported: {e}"
                logger.debug(f"=> {msg}")
                await telegram_client.send_message(chat_id, msg)
            return {"status": "error", "reason": "unsupported instance"}

        # Check if instance is running
        if not adapter.is_running():
            logger.warning(
                "Instance not running", instance=instance.name, type=instance.instance_type
            )
            if telegram_client:
                msg = f"⚠️ Claude instance '{instance.name}' is not running."
                logger.debug(f"=> {msg}")
                await telegram_client.send_message(chat_id, msg)
            return {"status": "error", "reason": "instance not running"}

        # Update instance activity
        await instance_manager.update_instance_activity(instance.name)

        # Send command to Claude and wait for response
        logger.info(
            "Sending to Claude",
            instance=instance.name,
            type=instance.instance_type,
            text=text[:100],
        )

        try:
            # For simple text messages, just send them directly
            success, output = await adapter.send_command_and_wait(text, timeout=60.0)

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
                    if len(clean_output) > TELEGRAM_MAX_MESSAGE_LENGTH:
                        clean_output = (
                            clean_output[:MAX_MESSAGE_LENGTH] + TELEGRAM_TRUNCATED_MESSAGE_SUFFIX
                        )

                    logger.debug(f"=> {clean_output}")
                    await telegram_client.send_message(chat_id, clean_output)
                    logger.info("Response sent", chat_id=chat_id, length=len(clean_output))
            # Command failed or timed out
            elif telegram_client:
                msg = f"⚠️ Claude command timed out or failed. Output: {output[:200] if output else 'No output'}"
                logger.debug(f"=> {msg}")
                await telegram_client.send_message(chat_id, msg)

            return {"status": "ok"}

        except Exception as e:
            # Generate error reference ID for tracking
            logger.bind(error_id=str(hash(str(e) + str(time.time())) % 10000000))
            logger.error("Command execution error", error=str(e), exc_info=True)
            if telegram_client:
                msg = "❌ Failed to execute command. Please try again later."
                logger.debug(f"=> {msg}")
                await telegram_client.send_message(chat_id, msg)
            return JSONResponse(
                status_code=500,
                content={"status": "error", "reason": "Command execution failed"},
            )

    except Exception as e:
        logger.error("Webhook processing error", error=str(e), exc_info=True)
        return JSONResponse(
            status_code=500,
            content={"status": "error", "reason": "Processing failed"},
        )


def sanitize_for_telegram(text: str, parse_mode: str = "HTML") -> str:
    """
    Sanitize text for safe Telegram message sending.

    Prevents HTML/Markdown injection by escaping special characters.

    Args:
        text: Raw text to sanitize
        parse_mode: "HTML" or "Markdown" (default: "HTML")

    Returns:
        Sanitized text safe for the specified parse mode
    """
    if not text:
        return ""

    if parse_mode == "HTML":
        # Escape HTML entities: <, >, &, ", '
        return html.escape(text)
    elif parse_mode == "Markdown":
        # Escape Markdown special characters
        # From: https://core.telegram.org/bots/api#markdownv2-style
        special_chars = [
            "_",
            "*",
            "[",
            "]",
            "(",
            ")",
            "~",
            "`",
            ">",
            "#",
            "+",
            "-",
            "=",
            "|",
            "{",
            "}",
            ".",
            "!",
        ]
        result = text
        for char in special_chars:
            # Escape with backslash, but don't double-escape
            result = result.replace(f"\\{char}", f"\\\\{char}")
            result = result.replace(char, f"\\{char}")
        return result
    else:
        # No parse mode or unknown mode - return as-is
        return text


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

    # Sanitize for Telegram HTML mode to prevent injection
    result = sanitize_for_telegram(result, parse_mode="HTML")

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
