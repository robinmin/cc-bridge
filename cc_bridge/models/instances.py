"""
Pydantic models for Claude instance management.
"""

from datetime import datetime
from typing import Any, ClassVar

from pydantic import BaseModel, Field


class ClaudeInstance(BaseModel):
    """Represents a Claude Code instance."""

    name: str = Field(description="Instance name")
    pid: int | None = Field(default=None, description="Process ID")
    tmux_session: str = Field(description="tmux session name")
    cwd: str | None = Field(default=None, description="Working directory")
    status: str = Field(default="stopped", description="Instance status: running, stopped, crashed")
    created_at: datetime = Field(
        default_factory=datetime.now, description="Instance creation timestamp"
    )
    last_activity: datetime | None = Field(default=None, description="Last activity timestamp")


class InstancesData(BaseModel):
    """Container for all Claude instances."""

    instances: dict[str, ClaudeInstance] = Field(
        default_factory=dict, description="All instances by name"
    )

    class Config:
        """Pydantic configuration."""

        json_encoders: ClassVar[dict[type | str, Any]] = {
            datetime: lambda v: v.isoformat(),
            "datetime.fromisoformat": datetime.fromisoformat,
        }
