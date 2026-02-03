"""
Server command implementation.

This module provides the CLI entry point for starting the webhook server.
All business logic has been moved to cc_bridge/core/webhook_server.py.
"""

import uvicorn

from cc_bridge.core.webhook import create_webhook_app

__all__ = ["start_server", "app"]

# Create global app instance for uvicorn
app = create_webhook_app()


def start_server(host: str = "0.0.0.0", port: int = 8080, reload: bool = False) -> None:
    """
    Start the uvicorn server.

    Args:
        host: Server host address
        port: Server port
        reload: Enable auto-reload for development
    """
    uvicorn.run("cc_bridge.commands.server:app", host=host, port=port, reload=reload)
