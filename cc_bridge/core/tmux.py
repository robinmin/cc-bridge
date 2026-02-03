"""
tmux operations for cc-bridge.

This module provides tmux session management for injecting
messages into Claude Code running in a tmux session.
"""

import asyncio
import hashlib
import subprocess
from pathlib import Path

from cc_bridge.packages.logging import get_logger

logger = get_logger(__name__)


def _get_tmux_socket_path() -> str:
    """Get the tmux socket path for CC-Bridge."""
    return str(Path.home() / ".claude" / "bridge" / "tmux.sock")


class TmuxSession:
    """
    tmux session manager for Claude Code integration.

    Provides methods for sending commands to Claude Code
    running in a tmux session, with async support for
    waiting for responses.
    """

    def __init__(self, session_name: str = "claude", socket_path: str | None = None):
        """
        Initialize tmux session manager.

        Args:
            session_name: Name of tmux session
            socket_path: Optional custom socket path (defaults to CC-Bridge socket)
        """
        self.session_name = session_name
        self.socket_path = socket_path or _get_tmux_socket_path()
        self._base_cmd = ["tmux", "-S", self.socket_path]

    def _run_tmux(
        self, args: list[str], capture: bool = True
    ) -> subprocess.CompletedProcess:
        """
        Run a tmux command.

        Args:
            args: Additional tmux arguments
            capture: Whether to capture output

        Returns:
            Completed process result
        """
        cmd = self._base_cmd + args
        try:
            return subprocess.run(cmd, capture_output=capture, text=True, check=False)
        except FileNotFoundError:
            logger.error("tmux not found")
            raise RuntimeError("tmux is not installed") from None

    def session_exists(self) -> bool:
        """
        Check if tmux session exists.

        Returns:
            True if session exists
        """
        try:
            result = self._run_tmux(["list-sessions"])
            return self.session_name in result.stdout
        except Exception:
            return False

    def send_keys(self, text: str, enter: bool = False) -> bool:
        """
        Send keys to tmux session.

        Args:
            text: Text to send to session
            enter: Whether to send Enter key after the text

        Returns:
            True if successful, False otherwise
        """
        if not self.session_exists():
            logger.warning("Session does not exist", session=self.session_name)
            return False

        try:
            self._run_tmux(["send-keys", "-t", self.session_name, text], capture=False)
            if enter:
                self._run_tmux(
                    ["send-keys", "-t", self.session_name, "Enter"], capture=False
                )
            logger.debug(
                "Keys sent to session", session=self.session_name, text=text[:50]
            )
            return True
        except Exception as e:
            logger.error("Failed to send keys", error=str(e))
            return False

    def send_command(self, command: str) -> bool:
        """
        Send command to tmux session (with Enter).

        Args:
            command: Command to send

        Returns:
            True if successful, False otherwise
        """
        return self.send_keys(command, enter=True)

    def get_session_output(self) -> str:
        """
        Capture current tmux session output.

        Returns:
            Session output as string
        """
        if not self.session_exists():
            return ""

        try:
            result = self._run_tmux(["capture-pane", "-t", self.session_name, "-p"])
            return result.stdout
        except Exception as e:
            logger.error("Failed to capture output", error=str(e))
            return ""

    def get_last_lines(self, count: int = 100) -> list[str]:
        """
        Get the last N lines from the tmux pane.

        Args:
            count: Number of lines to retrieve

        Returns:
            List of lines (most recent last)
        """
        content = self.get_session_output()
        lines = content.split("\n")

        # Get last N lines, filtering empty
        non_empty = [line for line in lines if line.strip()]
        return non_empty[-count:]

    async def send_command_and_wait(  # noqa: PLR0912, PLR0915
        self,
        command: str,
        timeout: float = 120.0,
        prompt_marker: str = "❯",  # noqa: RUF001
    ) -> tuple[bool, str]:
        """
        Send a command and wait for a response using delta-based extraction.

        This captures the pane before the command, sends the command,
        waits for completion, and then extracts ONLY the new content.
        """
        if not self.session_exists():
            return False, "Session does not exist"

        # Capture state BEFORE command
        initial_content = self.get_session_output()
        initial_lines = initial_content.split("\n")
        initial_hash = hashlib.sha256(
            initial_content.encode("utf-8", errors="ignore")
        ).hexdigest()

        logger.debug(
            "Command start (delta mode)",
            command=command[:50],
            initial_hash=initial_hash[:8],
        )

        # Send the command
        if not self.send_command(command):
            return False, "Failed to send command"

        # Wait for response
        start_time = asyncio.get_running_loop().time()
        content_changed = False
        consecutive_prompt_checks = 0
        min_wait_time = 2.0  # Reduced wait time with delta mode
        last_stable_hash = initial_hash

        while asyncio.get_running_loop().time() - start_time < timeout:
            await asyncio.sleep(1.0)

            current_snapshot = self.get_session_output()
            current_hash = hashlib.sha256(
                current_snapshot.encode("utf-8", errors="ignore")
            ).hexdigest()
            elapsed = asyncio.get_running_loop().time() - start_time

            # Check if content has changed
            if current_hash != last_stable_hash:
                content_changed = True
                last_stable_hash = current_hash
                consecutive_prompt_checks = 0

            # Only look for completion if content has changed AND min wait time passed
            if content_changed and elapsed >= min_wait_time:
                lines = current_snapshot.split("\n")

                # Look for stable prompt at the end
                prompt_found = False
                lines_to_check = min(5, len(lines))
                for i in range(len(lines) - 1, max(0, len(lines) - lines_to_check), -1):
                    line = lines[i].strip()
                    if line in (prompt_marker, "❯", ">", "»"):  # noqa: RUF001
                        prompt_found = True
                        consecutive_prompt_checks += 1
                        break
                    elif line:
                        consecutive_prompt_checks = 0
                        break

                # Need prompt to be stable for 3 consecutive checks (3 seconds)
                if prompt_found and consecutive_prompt_checks >= 3:
                    logger.debug("Prompt stable, extracting delta")

                    # Find where the LAST command echo is in the captured pane
                    # and take everything after it
                    cmd_line_idx = -1
                    for i in range(len(lines) - 1, -1, -1):
                        line = lines[i]
                        # Heuristic: Find the line that looks like a prompt followed by our command
                        stripped = line.strip()
                        if command in line and (
                            stripped.startswith(prompt_marker)
                            or any(stripped.startswith(p) for p in ("❯", ">", "»"))
                        ):
                            cmd_line_idx = i
                            break

                    if cmd_line_idx != -1:
                        potential_response = lines[cmd_line_idx + 1 :]
                    else:
                        # Fallback: Just take lines that are different from start
                        potential_response = [
                            line for line in lines if line not in initial_lines
                        ]

                    delta_lines = []
                    for line in potential_response:
                        stripped = line.strip()
                        if not stripped:
                            delta_lines.append("")
                            continue

                        # Skip trailing prompt
                        if stripped in (prompt_marker, "❯", ">", "»"):
                            continue

                        # Skip terminal UI separators (more than 3 of these chars)
                        ui_chars = "─═━─│┌┐└┘ ▔▚▛▜▝▘▐▙▌"
                        ui_char_count = sum(1 for c in stripped if c in ui_chars)
                        if ui_char_count > 3 and ui_char_count / len(stripped) > 0.5:
                            continue

                        delta_lines.append(line)

                    result = "\n".join(delta_lines).strip()
                    if result:
                        return True, result

        return False, current_snapshot or "Timeout waiting for response"

    def create_session(self, command: str | None = None) -> bool:
        """
        Create new tmux session.

        Args:
            command: Optional command to run in session

        Returns:
            True if successful, False otherwise
        """
        if self.session_exists():
            logger.warning("Session already exists", session=self.session_name)
            return False

        try:
            if command:
                self._run_tmux(
                    ["new-session", "-d", "-s", self.session_name, command],
                    capture=False,
                )
            else:
                self._run_tmux(
                    ["new-session", "-d", "-s", self.session_name], capture=False
                )
            logger.info("Session created", session=self.session_name)
            return True
        except Exception as e:
            logger.error("Failed to create session", error=str(e))
            return False

    def kill_session(self) -> bool:
        """
        Kill tmux session.

        Returns:
            True if successful, False otherwise
        """
        if not self.session_exists():
            return False

        try:
            self._run_tmux(["kill-session", "-t", self.session_name], capture=False)
            logger.info("Session killed", session=self.session_name)
            return True
        except Exception as e:
            logger.error("Failed to kill session", error=str(e))
            return False


def get_session(instance_name: str) -> TmuxSession:
    """
    Get a TmuxSession for a Claude instance.

    Args:
        instance_name: Name of the Claude instance

    Returns:
        TmuxSession interface
    """
    # Convert instance name to tmux session name
    session_name = f"claude-{instance_name}"
    return TmuxSession(session_name)
