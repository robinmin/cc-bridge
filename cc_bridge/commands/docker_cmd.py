"""
Docker command group for managing Docker-based Claude instances.

This module provides CLI commands for managing Docker containers that
host Claude Code instances.
"""

import asyncio
from typing import Annotated

import typer

from cc_bridge.constants import EXIT_ERROR
from cc_bridge.core.docker_compat import ensure_docker_available
from cc_bridge.core.instances import get_instance_manager
from cc_bridge.packages.logging import get_logger

logger = get_logger(__name__)

# Create Docker command group
docker_app = typer.Typer(
    name="docker",
    help="Manage Docker-based Claude instances",
    add_completion=True,
)


@docker_app.command("list")
def list_docker(
    json_output: bool = typer.Option(False, "--json", help="Output in JSON format"),
):
    """List all Docker Claude instances."""

    try:
        ensure_docker_available()
    except RuntimeError as e:
        typer.echo(f"❌ {e}", err=True)
        raise typer.Exit(code=EXIT_ERROR) from None

    instance_manager = get_instance_manager()
    instances = instance_manager.list_docker_instances()

    if not instances:
        typer.echo("No Docker instances found.")
        return  # Success

    if json_output:
        import json

        data = [
            {
                "name": i.name,
                "container_id": i.container_id,
                "image": i.image_name,
                "status": i.status,
            }
            for i in instances
        ]
        typer.echo(json.dumps(data, indent=2))
    else:
        typer.echo("Docker Claude Instances:")
        typer.echo("-" * 60)
        for i in instances:
            status_emoji = "🟢" if i.status == "running" else "🔴"
            container_id = i.container_id or "N/A"
            typer.echo(
                f"{status_emoji} {i.name}\n"
                f"   Container: {container_id[:12]}\n"
                f"   Image: {i.image_name or 'N/A'}\n"
                f"   Status: {i.status}"
            )


@docker_app.command("discover")
def discover_containers(
    auto: bool = typer.Option(False, "--auto", help="Auto-refresh mode"),
):
    """Discover Docker containers running Claude Code."""

    try:
        ensure_docker_available()
    except RuntimeError as e:
        typer.echo(f"❌ {e}", err=True)
        raise typer.Exit(code=EXIT_ERROR) from None

    instance_manager = get_instance_manager()

    typer.echo("Discovering Docker containers...")
    discovered = asyncio.run(instance_manager.refresh_discovery())

    if not discovered:
        typer.echo("No Docker instances discovered.")
        return  # Success

    typer.echo(f"✅ Discovered {len(discovered)} Docker instance(s):")
    for instance in discovered:
        typer.echo(f"   - {instance.name} ({instance.image_name})")


@docker_app.command("logs")
def container_logs(
    name: Annotated[str, typer.Argument(help="Instance name")],
    follow: bool = typer.Option(False, "--follow", "-f", help="Follow log output"),
    tail: int = typer.Option(100, "--tail", "-n", help="Number of lines to show"),
):
    """Show logs from a Docker container."""

    try:
        ensure_docker_available()
    except RuntimeError as e:
        typer.echo(f"❌ {e}", err=True)
        raise typer.Exit(code=EXIT_ERROR) from None

    instance_manager = get_instance_manager()
    instance = instance_manager.get_docker_instance(name)

    if not instance:
        typer.echo(f"❌ Docker instance '{name}' not found.", err=True)
        raise typer.Exit(code=EXIT_ERROR) from None

    # Assert for type checker - we've already checked instance is not None
    assert instance is not None
    assert instance.container_id is not None

    try:
        from cc_bridge.core.docker_compat import get_docker_client

        client = get_docker_client()
        container = client.containers.get(instance.container_id)

        logs = container.logs(tail=tail, follow=follow)
        typer.echo(logs.decode("utf-8", errors="ignore"))

    except Exception as e:
        typer.echo(f"❌ Failed to get logs: {e}", err=True)
        raise typer.Exit(code=EXIT_ERROR) from None


@docker_app.command("exec")
def exec_command(
    name: Annotated[str, typer.Argument(help="Instance name")],
    command: Annotated[list[str], typer.Argument(help="Command to execute")],
    interactive: bool = typer.Option(
        False, "-i", "--interactive", help="Interactive mode"
    ),
):
    """Execute a command in a Docker container."""

    try:
        ensure_docker_available()
    except RuntimeError as e:
        typer.echo(f"❌ {e}", err=True)
        raise typer.Exit(code=EXIT_ERROR) from None

    instance_manager = get_instance_manager()
    instance = instance_manager.get_docker_instance(name)

    if not instance:
        typer.echo(f"❌ Docker instance '{name}' not found.", err=True)
        raise typer.Exit(code=EXIT_ERROR) from None

    # Assert for type checker - we've already checked instance is not None
    assert instance is not None
    assert instance.container_id is not None

    try:
        from cc_bridge.core.docker_compat import get_docker_client

        client = get_docker_client()
        container = client.containers.get(instance.container_id)

        # Execute command
        result = container.exec_run(cmd=command, interactive=interactive)

        if result.exit_code != 0:
            typer.echo(f"❌ Command failed with exit code {result.exit_code}", err=True)
            raise typer.Exit(code=EXIT_ERROR) from None

        typer.echo(result.output.decode("utf-8", errors="ignore"))

    except Exception as e:
        typer.echo(f"❌ Failed to execute command: {e}", err=True)
        raise typer.Exit(code=EXIT_ERROR) from None


@docker_app.command("stop")
def stop_container(  # noqa: PLR0912
    name: Annotated[str, typer.Argument(help="Instance name")],
    force: bool = typer.Option(False, "--force", "-f", help="Force stop (SIGKILL)"),
    all: bool = typer.Option(False, "--all", help="Stop all Docker instances"),
    rm: bool = typer.Option(False, "--rm", help="Remove container after stopping"),
):
    """Stop a Docker container and optionally remove it."""

    try:
        ensure_docker_available()
    except RuntimeError as e:
        typer.echo(f"❌ {e}", err=True)
        raise typer.Exit(code=EXIT_ERROR) from None

    from cc_bridge.core.docker_compat import get_docker_client

    client = get_docker_client()
    instance_manager = get_instance_manager()

    if all:
        # Stop all Docker instances
        instances = instance_manager.list_docker_instances()
        if not instances:
            typer.echo("No Docker instances to stop.")
            return  # Success

        for instance in instances:
            try:
                # Assert for type checker - Docker instances should have container_id
                assert instance.container_id is not None
                container = client.containers.get(instance.container_id)
                if force:
                    container.kill()
                    typer.echo(f"✅ Force stopped {instance.name}")
                else:
                    container.stop()
                    typer.echo(f"✅ Stopped {instance.name}")
                instance_manager.update_instance_status(instance.name, "stopped")

                # Remove container if --rm flag specified
                if rm:
                    container.remove()
                    typer.echo(f"  Removed {instance.name}")
            except Exception as e:
                typer.echo(f"❌ Failed to stop {instance.name}: {e}", err=True)
        return

    # Stop specific instance
    instance = instance_manager.get_docker_instance(name)
    if not instance:
        typer.echo(f"❌ Docker instance '{name}' not found.", err=True)
        raise typer.Exit(code=EXIT_ERROR) from None

    # Assert for type checker - we've already checked instance is not None
    assert instance is not None
    assert instance.container_id is not None

    try:
        container = client.containers.get(instance.container_id)
        if force:
            container.kill()
            typer.echo(f"✅ Force stopped {name}")
        else:
            container.stop()
            typer.echo(f"✅ Stopped {name}")
        instance_manager.update_instance_status(name, "stopped")

        # Remove container if --rm flag specified
        if rm:
            container.remove()
            typer.echo(f"  Removed {name}")
    except Exception as e:
        typer.echo(f"❌ Failed to stop container: {e}", err=True)
        raise typer.Exit(code=EXIT_ERROR) from None


@docker_app.command("start")
def start_container(
    name: Annotated[str, typer.Argument(help="Instance name")],
):
    """Start a stopped Docker container."""

    try:
        ensure_docker_available()
    except RuntimeError as e:
        typer.echo(f"❌ {e}", err=True)
        raise typer.Exit(code=EXIT_ERROR) from None

    instance_manager = get_instance_manager()
    instance = instance_manager.get_docker_instance(name)

    if not instance:
        typer.echo(f"❌ Docker instance '{name}' not found.", err=True)
        raise typer.Exit(code=EXIT_ERROR) from None

    # Assert for type checker - we've already checked instance is not None
    assert instance is not None
    assert instance.container_id is not None

    try:
        from cc_bridge.core.docker_compat import get_docker_client

        client = get_docker_client()
        container = client.containers.get(instance.container_id)

        if container.status == "running":
            typer.echo(f"⚠️ Container '{name}' is already running.")
            return  # Success

        container.start()
        typer.echo(f"✅ Started {name}")
        instance_manager.update_instance_status(name, "running")

    except Exception as e:
        typer.echo(f"❌ Failed to start container: {e}", err=True)
        raise typer.Exit(code=EXIT_ERROR) from None


__all__ = ["docker_app"]
