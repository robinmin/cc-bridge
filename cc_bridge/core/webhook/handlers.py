"""
FastAPI Request handlers for the webhook server.
"""

from __future__ import annotations

from typing import TYPE_CHECKING
from urllib.parse import urlparse

import asyncio
import time

from fastapi import Depends, Request
from fastapi.responses import JSONResponse

from cc_bridge.config import get_config
from cc_bridge.constants import (
    MAX_MESSAGE_LENGTH,
    MAX_REQUEST_SIZE,
    TELEGRAM_MAX_MESSAGE_LENGTH,
    TELEGRAM_TRUNCATED_MESSAGE_SUFFIX,
)
from cc_bridge.core.instance_interface import get_instance_adapter
from cc_bridge.core.instances import get_instance_manager
from cc_bridge.core.telegram import TelegramClient
from cc_bridge.models.telegram import Update
from cc_bridge.packages.logging import get_logger

from .middleware import get_rate_limiter, get_server_uptime, get_shutdown_handler
from .utils import clean_claude_output

if TYPE_CHECKING:
    from collections.abc import AsyncGenerator
    from cc_bridge.models.instances import ClaudeInstance
    from .middleware import RateLimiter

logger = get_logger(__name__)

__all__ = [
    "telegram_webhook",
    "health",
    "get_instance_manager_dep",
    "get_telegram_client_dep",
    "ProcessedUpdateTracker",
]


class ProcessedUpdateTracker:
    """Tracks processed update IDs to prevent duplicates."""

    def __init__(self, max_size: int = 100):
        self._processed = {}
        self._max_size = max_size
        self._lock = asyncio.Lock()

    async def is_processed(self, update_id: int) -> bool:
        """Check if an update ID has already been or is being processed."""
        async with self._lock:
            now = time.time()
            # Clean up old entries (older than 10 mins)
            self._processed = {
                uid: ts for uid, ts in self._processed.items() if now - ts < 600
            }

            if update_id in self._processed:
                return True

            self._processed[update_id] = now
            if len(self._processed) > self._max_size:
                # Remove oldest
                oldest_uid = min(self._processed, key=lambda k: self._processed[k])
                del self._processed[oldest_uid]

            return False


# Global tracker
_update_tracker = ProcessedUpdateTracker()


def get_update_tracker() -> ProcessedUpdateTracker:
    """Get global update tracker."""
    return _update_tracker


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


async def health():
    """
    Health check endpoint for monitoring.
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
    }


async def _select_instance(instances: list[ClaudeInstance]) -> ClaudeInstance | None:
    """Select the best instance to use from a list."""
    settings_obj = get_config()
    docker_preferred = settings_obj.get("docker.preferred", False)
    instance_manager = get_instance_manager()

    # Categorize instances by status
    running = []
    stopped = []

    for i in instances:
        status = await instance_manager.aget_instance_status(i.name)
        if status == "running":
            running.append(i)
        elif status in ["stopped", "exited", "created", "no_pid"]:
            stopped.append(i)

    # First priority: Running instances
    if running:
        if len(running) == 1:
            return running[0]

        for instance in running:
            if (docker_preferred and instance.instance_type == "docker") or (
                not docker_preferred and instance.instance_type == "tmux"
            ):
                return instance
        return running[0]

    # Second priority: Stopped instances
    if stopped:
        for instance in stopped:
            if (docker_preferred and instance.instance_type == "docker") or (
                not docker_preferred and instance.instance_type == "tmux"
            ):
                return instance
        return stopped[0]

    return None


async def telegram_webhook(  # noqa: PLR0911, PLR0912, PLR0915
    request: Request,
    update: dict,
    instance_manager=Depends(get_instance_manager_dep),  # noqa: B008
    telegram_client=Depends(get_telegram_client_dep),  # noqa: B008
    rate_limiter: RateLimiter = Depends(get_rate_limiter),  # noqa: B008
):
    """
    Telegram webhook endpoint handler.
    """
    # Validate request size
    content_length = request.headers.get("content-length", 0)
    if content_length and int(content_length) > MAX_REQUEST_SIZE:
        logger.warning("Request too large", size=int(content_length))
        return JSONResponse(
            status_code=413,
            content={"status": "error", "reason": "Request too large"},
        )

    if not update:
        logger.warning("Empty update received")
        return JSONResponse(
            status_code=400,
            content={"status": "error", "reason": "Empty update"},
        )

    try:
        telegram_update = Update(**update)
        update_id = telegram_update.update_id
        logger.debug("Received webhook update", update_id=update_id)

        # Basic deduplication
        tracker = get_update_tracker()
        if await tracker.is_processed(update_id):
            logger.info("Ignoring duplicate update", update_id=update_id)
            return {"status": "ignored", "reason": "duplicate"}

        if not telegram_update.message:
            return {"status": "ignored", "reason": "no message"}

        message = telegram_update.message
        if not message.text:
            return {"status": "ignored", "reason": "no text"}

        chat_id = message.chat.id
        text = message.text

        # Apply rate limiting
        if not await rate_limiter.is_allowed(chat_id):
            retry_after = await rate_limiter.get_retry_after(chat_id)
            logger.warning(
                "Rate limit exceeded", chat_id=chat_id, retry_after=retry_after
            )
            return JSONResponse(
                status_code=429,
                content={
                    "status": "rate_limited",
                    "retry_after": retry_after,
                    "message": "Too many requests. Please try again later.",
                },
            )

        if text and len(text) > MAX_MESSAGE_LENGTH:
            return JSONResponse(
                status_code=400,
                content={"status": "error", "reason": "Message too long"},
            )

        text = text.strip() if text else ""
        if not text:
            return {"status": "ignored", "reason": "empty message"}

        # Handle Telegram commands
        if text.startswith("/"):
            return await _handle_telegram_command(
                text, chat_id, telegram_client, instance_manager
            )

        logger.info("Received message from Telegram", chat_id=chat_id, text=text[:50])

        # Verify chat ID
        settings_obj = get_config()
        expected_chat_id = settings_obj.get("telegram.chat_id")
        if expected_chat_id and chat_id != int(expected_chat_id):
            logger.warning(
                "Unauthorized chat ID", chat_id=chat_id, expected=expected_chat_id
            )
            return {"status": "ignored", "reason": "unauthorized"}

        # Find instance and send command
        instances = instance_manager.list_instances()
        instance = await _select_instance(instances)

        if not instance:
            if telegram_client:
                await telegram_client.send_message(
                    chat_id, "⚠️ No Claude instance found. Please check your instances."
                )
            return {"status": "error", "reason": "no instance"}

        adapter = get_instance_adapter(instance)

        # Ensure running
        if not adapter.is_running():
            if not await adapter.start():
                if telegram_client:
                    await telegram_client.send_message(
                        chat_id,
                        f"⚠️ Claude instance '{instance.name}' could not be started.",
                    )
                return {"status": "error", "reason": "instance not running"}

        await instance_manager.update_instance_activity(instance.name)

        try:
            settings_obj = get_config()
            timeout = settings_obj.get("timeouts.claude_response", 120.0)
            success, output = await adapter.send_command_and_wait(text, timeout=timeout)
            if success and output:
                clean_output = clean_claude_output(output)
                if telegram_client:
                    if len(clean_output) > TELEGRAM_MAX_MESSAGE_LENGTH:
                        clean_output = (
                            clean_output[:MAX_MESSAGE_LENGTH]
                            + TELEGRAM_TRUNCATED_MESSAGE_SUFFIX
                        )
                    await telegram_client.send_message(chat_id, clean_output)
            elif telegram_client:
                await telegram_client.send_message(
                    chat_id,
                    f"⚠️ Claude command failed. Output: {output[:200] if output else 'No output'}",
                )
            return {"status": "ok"}
        except Exception as e:
            logger.error("Command execution error", error=str(e), exc_info=True)
            if telegram_client:
                await telegram_client.send_message(
                    chat_id, "❌ Failed to execute command."
                )
            return JSONResponse(
                status_code=500,
                content={"status": "error", "reason": "Execution failed"},
            )

    except Exception as e:
        logger.error("Webhook processing error", error=str(e), exc_info=True)
        return JSONResponse(
            status_code=500, content={"status": "error", "reason": "Processing failed"}
        )


async def _handle_telegram_command(
    text: str, chat_id: int, telegram_client: TelegramClient | None, instance_manager
) -> dict:
    """Internal helper to handle /commands."""
    if text == "/start":
        if telegram_client:
            await telegram_client.send_message(
                chat_id,
                "👋 Welcome to cc-bridge!\n\nCommands:\n/status - Check status\n/help - Show help",
            )
        return {"status": "ok"}

    if text == "/status":
        instances = instance_manager.list_instances()
        instance = await _select_instance(instances)
        config_obj = get_config()
        tunnel_url = config_obj.get("tunnel.url", "")

        status_text = "📊 **Service Status**\n\n✅ Server: Running\n"
        if instance:
            active_status = await instance_manager.aget_instance_status(instance.name)
            status_icon = "🟢" if active_status == "running" else "🔴"
            status_text += (
                f"{status_icon} Instance: {instance.name} ({active_status})\n"
            )
        else:
            status_text += "🔌 Instance: None found\n"

        if tunnel_url:
            parsed = urlparse(tunnel_url)
            status_text += f"🟢 Tunnel: Active ({parsed.netloc or tunnel_url})\n"
        else:
            status_text += "⚠️ Tunnel: Not configured\n"

        if telegram_client:
            await telegram_client.send_message(chat_id, status_text)
        return {"status": "ok"}

    if text == "/help":
        if telegram_client:
            await telegram_client.send_message(
                chat_id,
                "📖 **cc-bridge Help**\n\n"
                "/status - Check service status\n"
                "/clear - Clear conversation\n"
                "/stop - Interrupt action\n"
                "/resume - Resume instance\n"
                "/help - Show this message",
            )
        return {"status": "ok"}

    if text in ("/clear", "/stop", "/resume"):
        instances = instance_manager.list_instances()
        instance = await _select_instance(instances)
        if not instance:
            if telegram_client:
                await telegram_client.send_message(
                    chat_id, "⚠️ No Claude instance found."
                )
            return {"status": "error", "reason": "no instance"}

        adapter = get_instance_adapter(instance)
        if text == "/stop":
            msg = (
                f"⏹ Instance '{instance.name}' interrupted."
                if await adapter.interrupt()
                else "⚠️ Interrupt failed."
            )
        elif text == "/clear":
            msg = (
                f"🧹 Conversation for '{instance.name}' cleared."
                if await adapter.clear_conversation()
                else "⚠️ Clear failed."
            )
        elif text == "/resume":
            if adapter.is_running():
                msg = f"✅ Instance '{instance.name}' is already running."
            else:
                msg = (
                    f"🚀 Instance '{instance.name}' resumed."
                    if await adapter.start()
                    else "⚠️ Resume failed."
                )

        if telegram_client:
            await telegram_client.send_message(chat_id, msg)
        return {"status": "ok"}

    return {"status": "ignored", "reason": "unknown command"}
