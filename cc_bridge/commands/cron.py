"""
Crontab management for cc-bridge health checks.

This module provides safe crontab modification with backup and rollback capabilities.
"""

import subprocess
from pathlib import Path

from cc_bridge.logging import get_logger

logger = get_logger(__name__)


class CrontabManager:
    """
    Manager for system crontab modifications.

    Provides safe crontab entry addition, removal, and backup/rollback.
    """

    CC_BRIDGE_MARKER = "# ===== CC-BRIDGE HEALTH CHECK ====="
    CC_BRIDGE_MARKER_END = "# ===== END CC-BRIDGE ====="

    def __init__(self):
        """Initialize crontab manager."""

    def _get_current_crontab(self) -> list[str]:
        """
        Get current crontab entries as list of lines.

        Returns:
            List of crontab lines
        """
        try:
            result = subprocess.run(["crontab", "-l"], capture_output=True, text=True, check=True)
            stdout = result.stdout.strip()
            # Handle empty crontab
            if not stdout:
                return []
            return stdout.split("\n")
        except subprocess.CalledProcessError as e:
            logger.warning("Failed to get crontab", error=str(e))
            return []
        except FileNotFoundError:
            # crontab command not found
            logger.warning("crontab command not found")
            return []

    def _backup_crontab(self) -> list[str]:
        """
        Backup current crontab to file.

        Returns:
            List of crontab lines
        """
        crontab_lines = self._get_current_crontab()

        backup_file = Path.home() / ".claude" / "bridge" / "crontab.backup"
        backup_file.parent.mkdir(parents=True, exist_ok=True)

        backup_file.write_text("\n".join(crontab_lines))
        logger.debug("Crontab backed up", path=str(backup_file))

        return crontab_lines

    def _validate_entry(self, entry: str) -> bool:
        """
        Validate crontab entry format.

        Args:
            entry: Crontab entry to validate

        Returns:
            True if valid, False otherwise
        """
        parts = entry.split()
        if len(parts) < 6:  # 5 time fields + command
            return False

        # Basic format: minute hour day month weekday command
        try:
            # Check if first 5 fields are valid cron patterns
            for field in parts[:5]:
                if field == "*":
                    continue
                # Handle */n format (e.g., */5)
                if field.startswith("*/"):
                    num_part = field[2:]
                    if not num_part.isdigit():
                        return False
                    continue
                # Check if it's a number
                if not field.isdigit():
                    return False
            return True
        except (ValueError, IndexError):
            return False

    def add_entry(self, entry: str, validate: bool = True) -> bool:
        """
        Add entry to crontab.

        Args:
            entry: Crontab entry to add
            validate: Whether to validate entry format

        Returns:
            True if successful, False otherwise
        """
        if validate and not self._validate_entry(entry):
            logger.error("Invalid crontab entry", entry=entry)
            return False

        # Backup current crontab
        current_crontab = self._backup_crontab()

        try:
            # Add marker comments
            new_crontab = current_crontab.copy()
            new_crontab.append(self.CC_BRIDGE_MARKER)
            new_crontab.append(entry)
            new_crontab.append(self.CC_BRIDGE_MARKER_END)

            # Write new crontab
            subprocess.run(
                ["crontab", "-"], input=("\n".join(new_crontab) + "\n").encode(), check=True
            )

            logger.info("Crontab entry added", entry=entry)
            return True

        except subprocess.CalledProcessError as e:
            logger.error("Failed to add crontab entry", error=str(e))
            return False

    def remove_entry(self) -> bool:
        """
        Remove CC-BRIDGE entries from crontab.

        Returns:
            True if successful, False otherwise
        """
        current_crontab = self._get_current_crontab()

        # Filter out CC-BRIDGE entries
        new_crontab = []
        skip = False
        for line in current_crontab:
            if self.CC_BRIDGE_MARKER in line:
                skip = True
            elif skip and self.CC_BRIDGE_MARKER_END in line:
                skip = False
            else:
                new_crontab.append(line)

        try:
            # Write modified crontab
            subprocess.run(
                ["crontab", "-"], input=("\n".join(new_crontab) + "\n").encode(), check=True
            )

            logger.info("Crontab entries removed")
            return True

        except subprocess.CalledProcessError as e:
            logger.error("Failed to remove crontab entries", error=str(e))
            return False

    def has_entries(self) -> bool:
        """
        Check if CC-BRIDGE entries exist in crontab.

        Returns:
            True if entries found, False otherwise
        """
        crontab_lines = self._get_current_crontab()
        return any(self.CC_BRIDGE_MARKER in line for line in crontab_lines)

    def restore_backup(self) -> bool:
        """
        Restore crontab from backup file.

        Returns:
            True if successful, False otherwise
        """
        backup_file = Path.home() / ".claude" / "bridge" / "crontab.backup"

        if not backup_file.exists():
            logger.warning("Crontab backup not found", path=str(backup_file))
            return False

        try:
            backup_content = backup_file.read_text()
            subprocess.run(["crontab", "-"], input=backup_content.encode(), check=True)

            logger.info("Crontab restored from backup")
            return True

        except (OSError, subprocess.CalledProcessError) as e:
            logger.error("Failed to restore crontab backup", error=str(e))
            return False
