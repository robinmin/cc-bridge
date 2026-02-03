"""
Claude Code instance management command.

This module provides the 'claude' CLI command for managing Claude Code instances
running in tmux sessions or Docker containers.

The commands/claude.py module is a thin CLI wrapper around the business logic
in core/instance_operations.py and core/instance_lifecycle.py.
"""

import asyncio

import typer

from cc_bridge.core.instance_operations import InstanceOperations
from cc_bridge.core.instances import get_instance_manager
from cc_bridge.core.validation import validate_instance_name

app = typer.Typer(help="Manage Claude Code instances (tmux or Docker)")


@app.command()
def start(
    name: str = typer.Argument(..., help="Instance name"),
    cwd: str | None = typer.Option(None, "--cwd", help="Working directory (tmux only)"),
    attach_immediately: bool = typer.Option(
        False, "--attach", "-a", help="Attach to the instance immediately"
    ),
    instance_type: str | None = typer.Option(
        None,
        "--instance-type",
        "-t",
        help="Instance type (tmux, docker, or auto-detect)",
    ),
    type_deprecated: str | None = typer.Option(
        None, "--type", hidden=True, help="(deprecated) Use --instance-type instead"
    ),
):
    """
    Start a new Claude Code instance.

    The instance runs in a tmux session or Docker container depending on type.
    Use --attach to connect to the session immediately (tmux only).
    """
    # Validate instance name at CLI input boundary
    try:
        validate_instance_name(name)
    except ValueError as e:
        typer.echo(f"❌ Invalid instance name: {e}")
        raise typer.Exit(1) from None

    # Handle deprecated --type parameter
    if type_deprecated and not instance_type:
        typer.echo("⚠️  Warning: --type is deprecated, use --instance-type", err=True)
        instance_type = type_deprecated

    instance_manager = get_instance_manager()
    ops = InstanceOperations(instance_manager)

    try:
        result = asyncio.run(
            ops.start_instance(
                name=name,
                cwd=cwd,
                instance_type=instance_type or "auto",
            )
        )

        typer.echo(f"✅ Started {result['type']} instance '{name}'")
        if result["type"] == "tmux":
            typer.echo(f"   Session: {result['session']}")
            typer.echo(f"   Working directory: {result['cwd']}")

            if attach_immediately:
                attach(name)
        else:
            typer.echo(f"   Container: {result['container_id'][:12]}")

    except ValueError as e:
        typer.echo(f"❌ {e}")
        raise typer.Exit(1) from None
    except RuntimeError as e:
        typer.echo(f"❌ Failed to start instance: {e}")
        raise typer.Exit(1) from None


@app.command()
def stop(
    name: str = typer.Argument(..., help="Instance name"),
    force: bool = typer.Option(
        False, "--force", "-f", help="Force stop without confirmation"
    ),
):
    """
    Stop a Claude Code instance.

    This will terminate the tmux session or Docker container and remove instance metadata.
    """
    # Validate instance name
    try:
        validate_instance_name(name)
    except ValueError as e:
        typer.echo(f"❌ Invalid instance name: {e}")
        raise typer.Exit(1) from None

    instance_manager = get_instance_manager()
    instance = instance_manager.get_instance(name)

    if not instance:
        typer.echo(f"❌ Instance '{name}' not found.")
        raise typer.Exit(1)

    # Confirm unless force flag
    if not force:
        typer.confirm(f"Stop instance '{name}'?", abort=True)

    ops = InstanceOperations(instance_manager)
    try:
        asyncio.run(ops.stop_instance(name))
        typer.echo(f"✅ Stopped instance '{name}'")
    except Exception as e:
        typer.echo(f"❌ Failed to stop instance: {e}")
        raise typer.Exit(1) from None


@app.command()
def list(
    instance_type: str | None = typer.Option(
        None, "--instance-type", "-t", help="Filter by type (tmux or docker)"
    ),
    filter_type_deprecated: str | None = typer.Option(
        None, "--type", hidden=True, help="(deprecated) Use --instance-type instead"
    ),
):
    """
    List all Claude Code instances.
    """
    # Handle deprecated --type parameter
    if filter_type_deprecated and not instance_type:
        typer.echo("⚠️  Warning: --type is deprecated, use --instance-type", err=True)
        instance_type = filter_type_deprecated

    instance_manager = get_instance_manager()
    instances = instance_manager.list_instances()

    if instance_type:
        instances = [i for i in instances if i.instance_type == instance_type]

    if not instances:
        typer.echo("No Claude instances found.")
        typer.echo("Use 'cc-bridge claude start' to create one.")
        raise typer.Exit(0)

    typer.echo(f"Found {len(instances)} instance(s):\n")

    for instance in instances:
        status = asyncio.run(instance_manager.aget_instance_status(instance.name))

        # Status emoji
        if status == "running":
            emoji = "🟢"
        elif status == "stopped":
            emoji = "🔴"
        else:
            emoji = "⚪"

        # Type emoji
        inst_type = getattr(instance, "instance_type", "tmux")
        type_emoji = "🐳" if inst_type == "docker" else "💻"

        typer.echo(f"{emoji} {instance.name} ({type_emoji} {inst_type})")

        if inst_type == "tmux":
            typer.echo(f"   Session: {instance.tmux_session}")
            typer.echo(f"   Working directory: {instance.cwd or '(default)'}")
        else:  # docker
            typer.echo(
                f"   Container: {instance.container_id[:12] if instance.container_id else 'N/A'}"
            )
            typer.echo(f"   Image: {instance.image_name or 'N/A'}")

        typer.echo(f"   Status: {status}")
        typer.echo(f"   Created: {instance.created_at.strftime('%Y-%m-%d %H:%M')}")
        if instance.last_activity:
            typer.echo(
                f"   Last activity: {instance.last_activity.strftime('%Y-%m-%d %H:%M')}"
            )
        typer.echo()


@app.command()
def attach(
    name: str = typer.Argument(..., help="Instance name"),
):
    """
    Attach to a running Claude Code instance.

    For tmux instances, this will connect your terminal to the tmux session.
    Press Ctrl+B then D to detach without stopping the instance.

    For Docker instances, use 'cc-bridge docker exec' instead.
    """
    import os
    from cc_bridge.core.instance_lifecycle import get_tmux_socket_path

    # Validate instance name
    try:
        validate_instance_name(name)
    except ValueError as e:
        typer.echo(f"❌ Invalid instance name: {e}")
        raise typer.Exit(1) from None

    instance_manager = get_instance_manager()
    instance = instance_manager.get_instance(name)

    if not instance:
        typer.echo(f"❌ Instance '{name}' not found.")
        raise typer.Exit(1)

    if instance.instance_type == "docker":
        typer.echo(f"⚠️  Instance '{name}' is a Docker container.")
        typer.echo(
            "   Use 'cc-bridge docker exec {name} -- <command>' to execute commands."
        )
        raise typer.Exit(0)

    status = asyncio.run(instance_manager.aget_instance_status(name))

    if status != "running":
        typer.echo(f"❌ Instance '{name}' is not running (status: {status})")
        typer.echo("   Use 'cc-bridge claude start' to start it.")
        raise typer.Exit(1)

    session_name = instance.tmux_session
    tmux_socket = get_tmux_socket_path()

    if not session_name:
        typer.echo(f"❌ Instance '{name}' has no tmux session.")
        raise typer.Exit(1)

    # Update activity timestamp
    asyncio.run(instance_manager.update_instance_activity(name))

    typer.echo(f"Attaching to '{name}'...")
    typer.echo("Press Ctrl+B then D to detach.")
    typer.echo()

    # Attach to tmux session (replaces current process)
    try:
        args: list[str] = ["tmux", "-S", tmux_socket, "attach", "-t", session_name]
        os.execvp("tmux", args)
    except OSError as e:
        typer.echo(f"❌ Failed to attach: {e}")
        raise typer.Exit(1) from None


@app.command()
def restart(
    name: str = typer.Argument(..., help="Instance name"),
):
    """
    Restart a Claude Code instance.

    This stops and immediately starts the instance again.
    """
    # Validate instance name
    try:
        validate_instance_name(name)
    except ValueError as e:
        typer.echo(f"❌ Invalid instance name: {e}")
        raise typer.Exit(1) from None

    instance_manager = get_instance_manager()
    ops = InstanceOperations(instance_manager)

    try:
        typer.echo(f"Restarting instance '{name}'...")
        asyncio.run(ops.restart_instance(name))
        typer.echo(f"✅ Restarted instance '{name}'")
    except Exception as e:
        typer.echo(f"❌ Failed to restart instance: {e}")
        raise typer.Exit(1) from None


@app.command()
def status(
    name: str = typer.Argument(..., help="Instance name"),
):
    """
    Show detailed status of a Claude instance.
    """
    # Validate instance name
    try:
        validate_instance_name(name)
    except ValueError as e:
        typer.echo(f"❌ Invalid instance name: {e}")
        raise typer.Exit(1) from None

    instance_manager = get_instance_manager()
    instance = instance_manager.get_instance(name)

    if not instance:
        typer.echo(f"❌ Instance '{name}' not found.")
        raise typer.Exit(1)

    status_result = asyncio.run(instance_manager.aget_instance_status(name))
    instance_type = getattr(instance, "instance_type", "tmux")

    # Status emoji
    if status_result == "running":
        emoji = "🟢"
    elif status_result == "stopped":
        emoji = "🔴"
    else:
        emoji = "⚪"

    # Type emoji
    type_emoji = "🐳" if instance_type == "docker" else "💻"

    typer.echo(f"{emoji} {instance.name} ({type_emoji} {instance_type})")
    typer.echo(f"   Status: {status_result}")
    typer.echo(f"   Created: {instance.created_at.strftime('%Y-%m-%d %H:%M')}")

    if instance_type == "tmux":
        typer.echo(f"   Session: {instance.tmux_session}")
        typer.echo(f"   Working directory: {instance.cwd or '(default)'}")
        typer.echo(f"   PID: {instance.pid or 'N/A'}")
    else:  # docker
        typer.echo(f"   Container ID: {instance.container_id or 'N/A'}")
        typer.echo(f"   Container Name: {instance.container_name or 'N/A'}")
        typer.echo(f"   Image: {instance.image_name or 'N/A'}")
        typer.echo(f"   Network: {instance.docker_network or 'N/A'}")

    if instance.last_activity:
        typer.echo(
            f"   Last activity: {instance.last_activity.strftime('%Y-%m-%d %H:%M')}"
        )
