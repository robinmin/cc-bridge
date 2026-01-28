"""
Claude Code instance management command.

This module provides the 'claude' command for managing Claude Code instances
running in tmux sessions, hiding tmux complexity from users.
"""

import os
import shlex
import signal
import subprocess
import sys
from pathlib import Path
from typing import Optional

import typer

from cc_bridge.config import settings
from cc_bridge.core.instances import get_instance_manager
from cc_bridge.logging import get_logger

logger = get_logger(__name__)

app = typer.Typer(help="Manage Claude Code instances in tmux sessions")


def _get_tmux_socket_path() -> str:
    """Get the tmux socket path for CC-Bridge."""
    return str(Path.home() / ".claude" / "bridge" / "tmux.sock")


def _is_tmux_available() -> bool:
    """Check if tmux is available."""
    try:
        subprocess.run(
            ["tmux", "-V"],
            capture_output=True,
            check=True
        )
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
        name: Instance name

    Returns:
        tmux session name
    """
    return f"claude-{name}"


@app.command()
def start(
    name: str = typer.Argument(..., help="Instance name"),
    cwd: Optional[str] = typer.Option(None, "--cwd", help="Working directory"),
    detach: bool = typer.Option(True, "--detach/--no-detach", help="Run in detached mode"),
):
    """
    Start a new Claude Code instance.

    The instance runs in a tmux session. Use --no-detach to attach immediately.
    """
    if not _is_tmux_available():
        typer.echo("❌ tmux is not installed. Please install tmux first.")
        raise typer.Exit(1)

    instance_manager = get_instance_manager()

    # Check if instance already exists
    existing_instance = instance_manager.get_instance(name)
    if existing_instance:
        # Check if it's actually running
        status = instance_manager.get_instance_status(name)
        if status == "running":
            typer.echo(f"❌ Instance '{name}' is already running.")
            typer.echo("   Use 'claude attach' to connect or 'claude stop' to remove it.")
            raise typer.Exit(1)
        else:
            # Instance exists but is stopped, we'll restart it
            typer.echo(f"Restarting stopped instance '{name}'...")
            # Delete the old metadata so we can recreate it
            instance_manager.delete_instance(name)

    # Validate working directory
    if cwd:
        is_valid, result = _validate_working_directory(cwd)
        if not is_valid:
            typer.echo(f"❌ Invalid working directory: {result}")
            raise typer.Exit(1)
        work_dir = result
    else:
        work_dir = os.getcwd()

    # Generate tmux session name
    session_name = _get_session_name(name)

    # Create instance metadata
    instance = instance_manager.create_instance(
        name=name,
        tmux_session=session_name,
        cwd=work_dir
    )

    # Start tmux session with Claude Code
    tmux_socket = _get_tmux_socket_path()
    socket_dir = Path(tmux_socket).parent
    socket_dir.mkdir(parents=True, exist_ok=True)

    try:
        # Create new tmux session
        cmd = [
            "tmux",
            "-S", tmux_socket,
            "new-session",
            "-d",  # Start detached
            "-s", session_name,
            "-n", "claude",
        ]

        # Set working directory and start Claude Code
        # Use sh -c to properly handle the command, but escape the directory path
        # to prevent command injection
        import shlex
        safe_dir = shlex.quote(work_dir)
        cmd.extend([
            f"cd {safe_dir} && claude"
        ])

        subprocess.run(cmd, check=True)

        # Get the PID of the tmux session leader
        result = subprocess.run(
            ["tmux", "-S", tmux_socket, "list-panes", "-t", session_name, "-F", "#{pane_pid}"],
            capture_output=True,
            text=True,
            check=True
        )
        pid = int(result.stdout.strip())

        # Update instance with PID and status
        instance_manager.update_instance(name, pid=pid, status="running")

        typer.echo(f"✅ Started Claude instance '{name}'")
        typer.echo(f"   Session: {session_name}")
        typer.echo(f"   Working directory: {work_dir}")

        if not detach:
            attach(name)

    except subprocess.CalledProcessError as e:
        logger.error("Failed to start tmux session", error=str(e))
        instance_manager.delete_instance(name)
        typer.echo(f"❌ Failed to start instance: {e}")
        raise typer.Exit(1)


@app.command()
def stop(
    name: str = typer.Argument(..., help="Instance name"),
    force: bool = typer.Option(False, "--force", "-f", help="Force stop without confirmation"),
):
    """
    Stop a Claude Code instance.

    This will terminate the tmux session and remove instance metadata.
    """
    instance_manager = get_instance_manager()
    instance = instance_manager.get_instance(name)

    if not instance:
        typer.echo(f"❌ Instance '{name}' not found.")
        raise typer.Exit(1)

    session_name = instance.tmux_session

    # Confirm unless force flag
    if not force:
        typer.confirm(f"Stop instance '{name}'?", abort=True)

    tmux_socket = _get_tmux_socket_path()

    # Check if tmux session actually exists
    session_exists = False
    try:
        result = subprocess.run(
            ["tmux", "-S", tmux_socket, "list-sessions"],
            capture_output=True,
            text=True,
            check=False
        )
        session_exists = session_name in result.stdout
    except Exception:
        pass

    if session_exists:
        try:
            # Kill tmux session
            subprocess.run(
                ["tmux", "-S", tmux_socket, "kill-session", "-t", session_name],
                check=True
            )

            # Remove instance metadata
            instance_manager.delete_instance(name)

            typer.echo(f"✅ Stopped instance '{name}'")

        except subprocess.CalledProcessError as e:
            logger.error("Failed to stop tmux session", error=str(e))
            typer.echo(f"❌ Failed to stop instance: {e}")
            raise typer.Exit(1)
    else:
        # Session doesn't exist, just remove metadata
        logger.info(f"Tmux session '{session_name}' not found, removing metadata only")
        instance_manager.delete_instance(name)
        typer.echo(f"✅ Removed instance '{name}' (session was already gone)")


@app.command()
def list():
    """
    List all Claude Code instances.
    """
    instance_manager = get_instance_manager()
    instances = instance_manager.list_instances()

    if not instances:
        typer.echo("No Claude instances found.")
        typer.echo("Use 'claude start' to create one.")
        raise typer.Exit(0)

    typer.echo(f"Found {len(instances)} instance(s):\n")

    for instance in instances:
        status = instance_manager.get_instance_status(instance.name)

        # Status emoji
        if status == "running":
            emoji = "🟢"
        elif status == "stopped":
            emoji = "🔴"
        else:
            emoji = "⚪"

        typer.echo(f"{emoji} {instance.name}")
        typer.echo(f"   Session: {instance.tmux_session}")
        typer.echo(f"   Working directory: {instance.cwd or '(default)'}")
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

    This will connect your terminal to the tmux session.
    Press Ctrl+B then D to detach without stopping the instance.
    """
    instance_manager = get_instance_manager()
    instance = instance_manager.get_instance(name)

    if not instance:
        typer.echo(f"❌ Instance '{name}' not found.")
        raise typer.Exit(1)

    status = instance_manager.get_instance_status(name)

    if status != "running":
        typer.echo(f"❌ Instance '{name}' is not running (status: {status})")
        typer.echo("   Use 'claude start' to start it.")
        raise typer.Exit(1)

    session_name = instance.tmux_session
    tmux_socket = _get_tmux_socket_path()

    # Update activity timestamp
    instance_manager.update_instance_activity(name)

    typer.echo(f"Attaching to '{name}'...")
    typer.echo("Press Ctrl+B then D to detach.")
    typer.echo()

    # Attach to tmux session (replaces current process)
    try:
        os.execvp(
            "tmux",
            ["tmux", "-S", tmux_socket, "attach", "-t", session_name]
        )
    except OSError as e:
        logger.error("Failed to attach to tmux session", error=str(e))
        typer.echo(f"❌ Failed to attach: {e}")
        raise typer.Exit(1)


@app.command()
def restart(
    name: str = typer.Argument(..., help="Instance name"),
):
    """
    Restart a Claude Code instance.

    This stops and immediately starts the instance again.
    """
    instance_manager = get_instance_manager()
    instance = instance_manager.get_instance(name)

    if not instance:
        typer.echo(f"❌ Instance '{name}' not found.")
        raise typer.Exit(1)

    # Get working directory before stopping
    cwd = instance.cwd
    was_running = instance_manager.get_instance_status(name) == "running"

    # Check if tmux session actually exists before trying to stop
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
                check=False
            )
            session_exists = session_name in result.stdout
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
        start(name=name, cwd=cwd, detach=True)
        typer.echo(f"✅ Restarted instance '{name}'")
    else:
        typer.echo(f"Instance '{name}' was not running, starting it now...")
        start(name=name, cwd=cwd, detach=True)
        typer.echo(f"✅ Started instance '{name}'")
