"""
Configuration models for cc-bridge.

This module contains Pydantic models for configuration validation.
"""

from pydantic import BaseModel, Field


class TelegramConfig(BaseModel):
    """Telegram configuration model."""

    bot_token: str = Field(..., min_length=1, description="Telegram bot token")
    webhook_url: str | None = Field(None, description="Webhook URL")


class ServerConfig(BaseModel):
    """Server configuration model."""

    host: str = Field(default="0.0.0.0", description="Server host address")
    port: int = Field(default=8080, ge=1, le=65535, description="Server port")
    reload: bool = Field(default=False, description="Enable auto-reload")


class TmuxConfig(BaseModel):
    """tmux configuration model."""

    session: str = Field(default="claude", description="tmux session name")
    auto_attach: bool = Field(default=True, description="Auto-attach to session")


class LoggingConfig(BaseModel):
    """Logging configuration model."""

    level: str = Field(default="INFO", description="Log level")
    format: str = Field(default="json", description="Log format (json or text)")
    file: str = Field(default="~/.claude/bridge/logs/bridge.log", description="Log file path")
    max_bytes: int = Field(default=10485760, description="Max log file size in bytes")
    backup_count: int = Field(default=5, ge=0, description="Number of backup files")


class HealthConfig(BaseModel):
    """Health check configuration model."""

    enabled: bool = Field(default=True, description="Enable health checks")
    interval_minutes: int = Field(default=5, ge=1, description="Health check interval")


class TunnelConfig(BaseModel):
    """Tunnel configuration model."""

    auto_start: bool = Field(default=False, description="Auto-start tunnel with server")


class BridgeConfig(BaseModel):
    """Complete bridge configuration model."""

    telegram: TelegramConfig
    server: ServerConfig = Field(default_factory=ServerConfig)
    tmux: TmuxConfig = Field(default_factory=TmuxConfig)
    logging: LoggingConfig = Field(default_factory=LoggingConfig)
    health: HealthConfig = Field(default_factory=HealthConfig)
    tunnel: TunnelConfig = Field(default_factory=TunnelConfig)
