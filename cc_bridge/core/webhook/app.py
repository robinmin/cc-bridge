"""
FastAPI application factory and lifespan management for the webhook server.
"""

import asyncio
import signal
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from cc_bridge.core.instances import get_instance_manager
from cc_bridge.packages.logging import get_logger

from .handlers import health, telegram_webhook
from .middleware import (
    get_shutdown_handler,
    set_server_start_time,
)

logger = get_logger(__name__)

__all__ = ["create_webhook_app"]


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Manage application lifespan with graceful shutdown.
    """
    shutdown_handler = get_shutdown_handler()
    loop = asyncio.get_running_loop()

    def handle_shutdown_signal():
        if not shutdown_handler.is_shutting_down():
            logger.info("Shutdown signal received")
            shutdown_handler._shutdown_event.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, handle_shutdown_signal)

    # Track start time
    set_server_start_time(time.time())

    logger.info("Starting cc-bridge server", shutdown_timeout=shutdown_handler._timeout)

    # Initial Docker discovery
    instance_manager = get_instance_manager()
    await instance_manager.refresh_discovery()

    yield

    logger.info("Initiating graceful shutdown...")
    await shutdown_handler.wait_for_shutdown()


def create_webhook_app() -> FastAPI:
    """
    Create and configure the FastAPI webhook application.
    """
    app = FastAPI(title="cc-bridge", version="0.1.0", lifespan=lifespan)

    @app.middleware("http")
    async def track_requests(request: Request, call_next):
        shutdown_handler = get_shutdown_handler()

        if shutdown_handler.is_shutting_down():
            return JSONResponse(
                status_code=503,
                content={"status": "error", "reason": "Server is shutting down"},
            )

        await shutdown_handler.increment_requests()
        try:
            response = await call_next(request)
            return response
        finally:
            await shutdown_handler.decrement_requests()

    # Register routes
    app.get("/", include_in_schema=False)(
        lambda: JSONResponse(status_code=404, content={"detail": "Not found"})
    )
    app.get("/health")(health)
    app.post("/webhook")(telegram_webhook)

    return app
