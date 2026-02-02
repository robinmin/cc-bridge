"""
CLI entry point for cc-bridge.

This module provides the main Typer CLI application with all commands
for managing the Telegram-Claude bridge.
"""

# ruff: noqa: PLC0415 (intentional lazy imports to avoid circular dependencies)
from typer import Typer

from cc_bridge.config import get_config
from cc_bridge.packages.logging import get_logger, setup_logging

# Initialize configuration
config = get_config()

# Setup logging based on configuration
log_config = config.logging
setup_logging(
    level=log_config.get("level", "INFO"),
    log_format=log_config.get("format", "json"),
    log_file=log_config.get("file"),
    max_bytes=log_config.get("max_bytes", 10485760),
    backup_count=log_config.get("backup_count", 5),
)

logger = get_logger(__name__)

app = Typer(
    name="cc-bridge",
    help="Telegram bot bridge for Claude Code",
    add_completion=True,
)


@app.command()
def server(
    reload: bool = config.get("server.reload", False),
    host: str = config.get("server.host", "0.0.0.0"),
    port: int = config.get("server.port", 8080),
):
    """
    Start the FastAPI webhook server.

    This command starts the uvicorn server that receives Telegram webhooks
    and injects messages into Claude Code via tmux.
    """
    from cc_bridge.commands.server import start_server

    start_server(host=host, port=port, reload=reload)


@app.command()
def hook_stop(transcript_path: str):
    """
    Send Claude response to Telegram (Stop hook).
    """
    import sys

    from cc_bridge.commands.hook_stop import main as hook_stop_main

    sys.exit(hook_stop_main(transcript_path))


@app.command()
def health():
    """
    Run health checks.
    """
    import sys

    from cc_bridge.commands.health import main as health_main

    sys.exit(health_main())


@app.command()
def setup():
    """
    Interactive setup wizard.

    This command guides the user through first-time configuration.
    """
    import sys

    from cc_bridge.commands.setup import main as setup_main

    sys.exit(setup_main())


@app.command()
def config(
    key: str | None = None,
    value: str | None = None,
    delete: bool = False,
):
    """
    Configuration management.
    """
    import sys

    from cc_bridge.commands.config import main as config_main

    sys.exit(config_main(key=key, value=value, delete=delete))


@app.command()
def tunnel(
    start: bool = False,
    stop: bool = False,
    port: int = 8080,
):
    """
    Cloudflare tunnel management.
    """
    import sys

    from cc_bridge.commands.tunnel import main as tunnel_main

    sys.exit(tunnel_main(start=start, stop=stop, port=port))


# Register docker commands as a sub-command group
from cc_bridge.commands.bot import app as bot_app  # noqa: E402
from cc_bridge.commands.docker_cmd import docker_app  # noqa: E402

app.add_typer(docker_app, name="docker")
app.add_typer(bot_app, name="bot")


# Register claude-* commands as individual top-level commands
from cc_bridge.commands.claude import (  # noqa: E402
    attach as claude_attach,
)
from cc_bridge.commands.claude import (  # noqa: E402
    list as claude_list,
)
from cc_bridge.commands.claude import (  # noqa: E402
    restart as claude_restart,
)
from cc_bridge.commands.claude import (  # noqa: E402
    start as claude_start,
)
from cc_bridge.commands.claude import (  # noqa: E402
    stop as claude_stop,
)

# Register each claude command as a top-level command
app.command(name="claude-start")(claude_start)
app.command(name="claude-list")(claude_list)
app.command(name="claude-attach")(claude_attach)
app.command(name="claude-restart")(claude_restart)
app.command(name="claude-stop")(claude_stop)


if __name__ == "__main__":
    app()
