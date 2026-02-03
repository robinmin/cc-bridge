"""
Webhook Server Package

This package provides the FastAPI application and components for the
Telegram-Claude bridge webhook server.
"""

from .app import create_webhook_app
from .handlers import (
    get_instance_manager_dep,
    get_telegram_client_dep,
    health,
    telegram_webhook,
)
from .middleware import (
    GracefulShutdown,
    RateLimiter,
    get_rate_limiter,
    get_server_uptime,
    get_shutdown_handler,
)
from .utils import clean_claude_output, sanitize_for_telegram

__all__ = [
    "create_webhook_app",
    "GracefulShutdown",
    "RateLimiter",
    "get_rate_limiter",
    "get_server_uptime",
    "get_shutdown_handler",
    "get_instance_manager_dep",
    "get_telegram_client_dep",
    "health",
    "telegram_webhook",
    "clean_claude_output",
    "sanitize_for_telegram",
]
