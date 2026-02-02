"""
Claude Code instance management command.

This module provides the 'claude' command for managing Claude Code instances
running in tmux sessions or Docker containers, hiding complexity from users.
"""

import asyncio
import os
import shlex
import subprocess
from pathlib import Path

import typer

from cc_bridge.config import get_config
from cc_bridge.core.docker_compat import is_docker_available
from cc_bridge.core.instances import InstanceManager, get_instance_manager
from cc_bridge.core.validation import safe_tmux_session_name, validate_instance_name
from cc_bridge.models.instances import ClaudeInstance
from cc_bridge.packages.logging import get_logger

logger = get_logger(__name__)

app = typer.Typer(help="Manage Claude Code instances (tmux or Docker)")


def _get_tmux_socket_path() -> str:
    """Get the tmux socket path for CC-Bridge."""
    return str(Path.home() / ".claude" / "bridge" / "tmux.sock")


def _is_tmux_available() -> bool:
    """Check if tmux is available."""
    try:
        subprocess.run(["tmux", "-V"], capture_output=True, check=True)
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False


def _validate_working_directory(cwd: str) -> tuple[bool, str]:
    """
    Validate and create working directory if needed.

    Args:
        cwd: Working directory path

    Returns:
        Tuple of (is_valid, absolute_path or error_message)
    """
    path = Path(cwd).expanduser().absolute()

    if path.exists() and not path.is_dir():
        return False, f"Path exists but is not a directory: {cwd}"

    if not path.exists():
        try:
            path.mkdir(parents=True, exist_ok=True)
            logger.info("Created working directory", path=str(path))
        except OSError as e:
            return False, f"Cannot create directory: {e}"

    return True, str(path)


def _get_session_name(name: str) -> str:
    """
    Generate tmux session name for Claude instance.

    Args:
        name: Instance name (will be validated)

    Returns:
        tmux session name

    Raises:
        ValueError: If instance name is invalid
    """
    return safe_tmux_session_name(name)


def _detect_instance_type(
    explicit_type: str | None,
    existing_instance: ClaudeInstance | None,
) -> str:
    """
    Detect the instance type to use.

    Args:
        explicit_type: Explicitly specified type (tmux|docker|auto)
        existing_instance: Existing instance if any

    Returns:
        Instance type: "tmux" or "docker"
    """
    # If explicit type provided, use it
    if explicit_type and explicit_type != "auto":
        return explicit_type

    # If existing instance has a type, use it
    if existing_instance and hasattr(existing_instance, "instance_type"):
        return existing_instance.instance_type

    # Check configuration
    config = get_config()
    docker_enabled = config.get("docker.enabled", False)
    docker_preferred = config.get("docker.preferred", False)

    if docker_enabled and docker_preferred and is_docker_available():
        return "docker"

    # Default to tmux for backward compatibility
    return "tmux"


@app.command()
def start(
    name: str = typer.Argument(..., help="Instance name"),
    cwd: str | None = typer.Option(None, "--cwd", help="Working directory (tmux only)"),
    attach: bool = typer.Option(False, "--attach", "-a", help="Attach to the instance immediately"),
    instance_type: str | None = typer.Option(
        None, "--instance-type", "-t", help="Instance type (tmux, docker, or auto-detect)"
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

    # Validate instance_type value
    if instance_type and instance_type not in ("tmux", "docker", "auto"):
        typer.echo(f"❌ Invalid instance type: {instance_type}")
        typer.echo("   Valid values are: tmux, docker, auto")
        raise typer.Exit(1) from None

    # Default to auto-detect if neither specified
    if not instance_type:
        instance_type = "auto"

    instance_manager = get_instance_manager()

    # Check if instance already exists
    existing_instance = instance_manager.get_instance(name)
    if existing_instance:
        # Check if it's actually running
        status = asyncio.run(instance_manager.aget_instance_status(name))
        if status == "running":
            typer.echo(f"❌ Instance '{name}' is already running.")
            typer.echo(
                "   Use 'cc-bridge claude attach' to connect or 'cc-bridge claude stop' to remove it."
            )
            raise typer.Exit(1)
        else:
            # Instance exists but is stopped, we'll restart it
            typer.echo(f"Restarting stopped instance '{name}'...")
            # Delete the old metadata so we can recreate it
            asyncio.run(instance_manager.delete_instance(name))

    # Detect instance type
    detected_type = _detect_instance_type(instance_type, existing_instance)

    if detected_type == "docker":
        # Start Docker instance
        _start_docker_instance(name, instance_manager)
    else:
        # Start tmux instance
        _start_tmux_instance(name, cwd, attach, instance_manager)


def _start_tmux_instance(
    name: str,
    cwd: str | None,
    attach: bool,
    instance_manager: InstanceManager,
) -> None:
    """Start a tmux-based Claude instance."""
    # Import attach function to avoid name shadowing with parameter
    import sys

    attach_func = sys.modules[__name__].attach

    if not _is_tmux_available():
        typer.echo("❌ tmux is not installed. Please install tmux first.")
        raise typer.Exit(1)

    # Validate working directory
    if cwd:
        is_valid, result = _validate_working_directory(cwd)
        if not is_valid:
            typer.echo(f"❌ Invalid working directory: {result}")
            raise typer.Exit(1)
        work_dir = result
    else:
        work_dir = str(Path.cwd())

    # Generate tmux session name
    session_name = _get_session_name(name)

    # Create instance metadata
    asyncio.run(
        instance_manager.create_instance(
            name=name,
            instance_type="tmux",
            tmux_session=session_name,
            cwd=work_dir,
        )
    )

    # Start tmux session with Claude Code
    tmux_socket = _get_tmux_socket_path()
    socket_dir = Path(tmux_socket).parent
    socket_dir.mkdir(parents=True, exist_ok=True)

    try:
        # Create new tmux session
        cmd = [
            "tmux",
            "-S",
            tmux_socket,
            "new-session",
            "-d",  # Start detached
            "-s",
            session_name,
            "-n",
            "claude",
        ]

        # Set working directory and start Claude Code
        safe_dir = shlex.quote(work_dir)
        cmd.extend([f"cd {safe_dir} && claude"])

        subprocess.run(cmd, check=True)

        # Get the PID of the tmux session leader
        result = subprocess.run(
            ["tmux", "-S", tmux_socket, "list-panes", "-t", session_name, "-F", "#{pane_pid}"],
            capture_output=True,
            text=True,
            check=True,
        )
        pid = int(result.stdout.strip())

        # Update instance with PID and status
        asyncio.run(instance_manager.update_instance(name, pid=pid, status="running"))

        typer.echo(f"✅ Started Claude instance '{name}' (type: tmux)")
        typer.echo(f"   Session: {session_name}")
        typer.echo(f"   Working directory: {work_dir}")

        if attach:
            attach_func(name)

    except subprocess.CalledProcessError as e:
        logger.error("Failed to start tmux session", error=str(e))
        asyncio.run(instance_manager.delete_instance(name))
        typer.echo(f"❌ Failed to start instance: {e}")
        raise typer.Exit(1) from None


def _start_docker_instance(name: str, instance_manager: InstanceManager) -> None:
    """Start a Docker-based Claude instance."""
    if not is_docker_available():
        typer.echo("❌ Docker is not available. Install Docker or use --type tmux.")
        raise typer.Exit(1)

    typer.echo(f"i  Starting Docker instance '{name}'...")
    typer.echo("   Note: Docker instances should be created using docker-compose or docker run.")
    typer.echo("   Use 'cc-bridge docker discover' to discover existing containers.")
    typer.echo("   Or use: docker run --label cc-bridge.instance=<name> ...")

    # Try to discover the instance
    discovered = asyncio.run(instance_manager.refresh_discovery())
    target_instance = next((inst for inst in discovered if inst.name == name), None)

    if target_instance:
        # Check if we need to start it
        status = asyncio.run(instance_manager.aget_instance_status(name))
        if status != "running":
            typer.echo(f"i  Container found but status is '{status}'. Starting...")
            try:
                from cc_bridge.core.docker_compat import get_docker_client

                client = get_docker_client()
                container = client.containers.get(target_instance.container_id)
                container.start()
                typer.echo(f"✅ Started Docker instance '{name}'")
            except Exception as e:
                typer.echo(f"❌ Failed to start container: {e}")
                raise typer.Exit(1) from None
        else:
            typer.echo(f"✅ Docker instance '{name}' is already running")
        return

    typer.echo(f"⚠️  No Docker container found for instance '{name}'")
    typer.echo("   Create a container with the cc-bridge.instance label first:")
    typer.echo(f"   docker run --label cc-bridge.instance={name} ...")
    raise typer.Exit(1)


@app.command()
def stop(
    name: str = typer.Argument(..., help="Instance name"),
    force: bool = typer.Option(False, "--force", "-f", help="Force stop without confirmation"),
):
    """
    Stop a Claude Code instance.

    This will terminate the tmux session or Docker container and remove instance metadata.
    """
    # Validate instance name at CLI input boundary
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

    instance_type = getattr(instance, "instance_type", "tmux")

    if instance_type == "docker":
        _stop_docker_instance(name, instance, instance_manager)
    else:
        _stop_tmux_instance(name, instance, instance_manager)


def _stop_tmux_instance(
    name: str, instance: ClaudeInstance, instance_manager: InstanceManager
) -> None:
    """Stop a tmux-based Claude instance."""
    session_name = instance.tmux_session
    tmux_socket = _get_tmux_socket_path()

    # Check if tmux session actually exists
    session_exists = False
    try:
        result = subprocess.run(
            ["tmux", "-S", tmux_socket, "list-sessions"],
            capture_output=True,
            text=True,
            check=False,
        )
        session_exists = (
            result.stdout is not None and session_name in result.stdout  # type: ignore[operator]
        )
    except Exception:
        pass

    if session_exists:
        try:
            # Kill tmux session
            subprocess.run(  # type: ignore[call-arg]
                ["tmux", "-S", tmux_socket, "kill-session", "-t", session_name], check=True
            )

            # Remove instance metadata
            asyncio.run(instance_manager.delete_instance(name))

            typer.echo(f"✅ Stopped instance '{name}'")

        except subprocess.CalledProcessError as e:
            logger.error("Failed to stop tmux session", error=str(e))
            typer.echo(f"❌ Failed to stop instance: {e}")
            raise typer.Exit(1) from None
    else:
        # Session doesn't exist, just remove metadata
        logger.info(f"Tmux session '{session_name}' not found, removing metadata only")
        asyncio.run(instance_manager.delete_instance(name))
        typer.echo(f"✅ Removed instance '{name}' (session was already gone)")


def _stop_docker_instance(
    name: str, instance: ClaudeInstance, instance_manager: InstanceManager
) -> None:
    """Stop a Docker-based Claude instance."""
    if not is_docker_available():
        typer.echo("❌ Docker is not available.")
        raise typer.Exit(1)

    try:
        from cc_bridge.core.docker_compat import get_docker_client

        client = get_docker_client()
        container = client.containers.get(instance.container_id)

        # Stop the container
        container.stop()

        # Remove instance metadata
        asyncio.run(instance_manager.delete_instance(name))

        typer.echo(f"✅ Stopped Docker instance '{name}'")

    except Exception as e:
        logger.error("Failed to stop Docker container", error=str(e))
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
        instance_type = getattr(instance, "instance_type", "tmux")
        type_emoji = "🐳" if instance_type == "docker" else "💻"

        typer.echo(f"{emoji} {instance.name} ({type_emoji} {instance_type})")

        if instance_type == "tmux":
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
            typer.echo(f"   Last activity: {instance.last_activity.strftime('%Y-%m-%d %H:%M')}")
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
    # Validate instance name at CLI input boundary
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

    instance_type = getattr(instance, "instance_type", "tmux")

    if instance_type == "docker":
        typer.echo(f"⚠️  Instance '{name}' is a Docker container.")
        typer.echo("   Use 'cc-bridge docker exec {name} -- <command>' to execute commands.")
        raise typer.Exit(0)

    status = asyncio.run(instance_manager.aget_instance_status(name))

    if status != "running":
        typer.echo(f"❌ Instance '{name}' is not running (status: {status})")
        typer.echo("   Use 'cc-bridge claude start' to start it.")
        raise typer.Exit(1)

    session_name = instance.tmux_session
    tmux_socket = _get_tmux_socket_path()

    # Assert for type checker - tmux instances should have session_name
    assert session_name is not None

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
        logger.error("Failed to attach to tmux session", error=str(e))
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
    # Validate instance name at CLI input boundary
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

    instance_type = getattr(instance, "instance_type", "tmux")
    was_running = asyncio.run(instance_manager.aget_instance_status(name)) == "running"

    if instance_type == "docker":
        # Handle Docker restart
        if was_running:
            typer.echo(f"Restarting Docker instance '{name}'...")
            stop(name=name, force=True)

        # Re-discover/start the Docker container
        _start_docker_instance(name, instance_manager)
        typer.echo(f"✅ Restarted Docker instance '{name}'")
    else:
        # Handle tmux restart
        cwd = instance.cwd
        session_name = instance.tmux_session
        tmux_socket = _get_tmux_socket_path()
        session_exists = False

        if was_running:
            # Check if the tmux session actually exists
            try:
                result = subprocess.run(
                    ["tmux", "-S", tmux_socket, "list-sessions"],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                session_exists = session_name in result.stdout  # type: ignore[operator]
            except Exception:
                pass

            if session_exists:
                typer.echo(f"Stopping instance '{name}'...")
                stop(name=name, force=True)
            else:
                logger.info(f"Tmux session '{session_name}' not found, marking as not running")
                was_running = False

        if was_running:
            # Start it again with the same configuration
            typer.echo(f"Starting instance '{name}'...")
            _start_tmux_instance(
                name=name, cwd=cwd, attach=False, instance_manager=instance_manager
            )
            typer.echo(f"✅ Restarted instance '{name}'")
        else:
            typer.echo(f"Instance '{name}' was not running, starting it now...")
            _start_tmux_instance(
                name=name, cwd=cwd, attach=False, instance_manager=instance_manager
            )
            typer.echo(f"✅ Started instance '{name}'")


@app.command()
def status(
    name: str = typer.Argument(..., help="Instance name"),
):
    """
    Show detailed status of a Claude instance.
    """
    # Validate instance name at CLI input boundary
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

    status = asyncio.run(instance_manager.aget_instance_status(name))
    instance_type = getattr(instance, "instance_type", "tmux")

    # Status emoji
    if status == "running":
        emoji = "🟢"
    elif status == "stopped":
        emoji = "🔴"
    else:
        emoji = "⚪"

    # Type emoji
    type_emoji = "🐳" if instance_type == "docker" else "💻"

    typer.echo(f"{emoji} {instance.name} ({type_emoji} {instance_type})")
    typer.echo(f"   Status: {status}")
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
        typer.echo(f"   Last activity: {instance.last_activity.strftime('%Y-%m-%d %H:%M')}")
