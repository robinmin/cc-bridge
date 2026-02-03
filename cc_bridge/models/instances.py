"""
Pydantic models for Claude instance management.
"""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_serializer, model_validator


class ClaudeInstance(BaseModel):
    """Represents a Claude Code instance (tmux or Docker-based)."""

    name: str = Field(description="Instance name")
    instance_type: Literal["tmux", "docker"] = Field(
        default="tmux", description="Instance type: tmux or docker"
    )
    status: str = Field(
        default="stopped", description="Instance status: running, stopped, crashed"
    )
    created_at: datetime = Field(
        default_factory=datetime.now, description="Instance creation timestamp"
    )
    last_activity: datetime | None = Field(
        default=None, description="Last activity timestamp"
    )

    # Communication mode for Docker instances
    communication_mode: Literal["exec", "fifo"] = Field(
        default="fifo",
        description="Docker communication mode: exec (legacy) or fifo (daemon mode)",
    )

    # Tmux-specific fields
    pid: int | None = Field(default=None, description="Process ID (tmux instances)")
    tmux_session: str | None = Field(default=None, description="tmux session name")
    cwd: str | None = Field(
        default=None, description="Working directory (tmux instances)"
    )

    # Docker-specific fields
    container_id: str | None = Field(default=None, description="Docker container ID")
    container_name: str | None = Field(
        default=None, description="Docker container name"
    )
    image_name: str | None = Field(default=None, description="Docker image name")
    docker_network: str | None = Field(default=None, description="Docker network name")

    @model_validator(mode="after")
    def validate_instance_fields(self) -> "ClaudeInstance":
        """Validate that instance type matches the populated fields."""
        if self.instance_type == "tmux":
            # For tmux instances, Docker fields should be None
            docker_fields = [
                self.container_id,
                self.container_name,
                self.image_name,
                self.docker_network,
            ]
            if any(field is not None for field in docker_fields):
                raise ValueError(
                    f"Tmux instance '{self.name}' cannot have Docker fields populated. "
                    f"Set instance_type='docker' or remove Docker-specific fields."
                )
            # tmux_session is required for tmux instances
            if not self.tmux_session:
                raise ValueError(
                    f"Tmux instance '{self.name}' requires tmux_session field."
                )
        elif self.instance_type == "docker":
            # For docker instances, tmux fields should be None
            tmux_fields = [self.pid, self.tmux_session, self.cwd]
            if any(field is not None for field in tmux_fields):
                raise ValueError(
                    f"Docker instance '{self.name}' cannot have tmux fields populated. "
                    f"Set instance_type='tmux' or remove tmux-specific fields."
                )
            # container_id is required for docker instances
            if not self.container_id:
                raise ValueError(
                    f"Docker instance '{self.name}' requires container_id field."
                )
        return self

    @field_serializer("created_at", "last_activity")
    def serialize_datetime(self, value: datetime | None) -> str | None:
        """Serialize datetime fields to ISO format strings."""
        return value.isoformat() if value else None


class InstancesData(BaseModel):
    """Container for all Claude instances."""

    model_config = ConfigDict(
        # Use enum values (not names) in JSON
        use_enum_values=True,
        # Serialize datetime using custom serializer
        ser_json_timedelta="iso8601",
    )

    instances: dict[str, ClaudeInstance] = Field(
        default_factory=dict, description="All instances by name"
    )
