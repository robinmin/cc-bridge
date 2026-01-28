"""
Configuration management for cc-bridge.

This module provides a layered configuration system with priority:
1. CLI arguments
2. Environment variables
3. TOML config file (~/.claude/bridge/config.toml)
4. Defaults
"""

import os
from copy import deepcopy
from pathlib import Path
from typing import Any

import toml


class Config:
    """
    Configuration manager with layered priority system.

    Configuration is loaded from multiple sources with the following priority:
    1. CLI arguments (highest priority)
    2. Environment variables
    3. TOML config file
    4. Defaults (lowest priority)
    """

    DEFAULTS: dict[str, Any] = {
        "telegram": {
            "bot_token": "",
            "chat_id": None,
            "webhook_url": "",
        },
        "server": {
            "host": "0.0.0.0",
            "port": 8080,
            "reload": False,
        },
        "tmux": {
            "session": "claude",
            "auto_attach": True,
        },
        "instances": {
            "data_file": "~/.claude/bridge/instances.json",
        },
        "logging": {
            "level": "INFO",
            "format": "json",
            "file": "~/.claude/bridge/logs/bridge.log",
            "max_bytes": 10485760,  # 10MB
            "backup_count": 5,
        },
        "health": {
            "enabled": True,
            "interval_minutes": 5,
        },
        "tunnel": {
            "auto_start": False,
        },
    }

    CONFIG_PATH = Path.home() / ".claude" / "bridge" / "config.toml"

    def __init__(self, config_path: Path | None = None, env_file: Path | None = None):
        """
        Initialize configuration manager.

        Args:
            config_path: Optional path to config file (defaults to ~/.claude/bridge/config.toml)
            env_file: Optional path to .env file (defaults to ./env in current directory)
        """
        self.config_path = config_path or self.CONFIG_PATH
        self._config: dict[str, Any] = {}
        self._load_env_file(env_file)
        self._load()
        self._apply_env_overrides()
        self._expand_paths()

    def _load_env_file(self, env_file: Path | None) -> None:
        """
        Load environment variables from .env file.

        Args:
            env_file: Path to .env file, or None to auto-detect
        """
        # Try to find .env file
        if env_file is None:
            # Check current directory
            cwd_env = Path.cwd() / ".env"
            if cwd_env.exists():
                env_file = cwd_env
            else:
                # Check home directory
                home_env = Path.home() / ".claude" / "bridge" / ".env"
                if home_env.exists():
                    env_file = home_env

        if env_file and env_file.exists():
            try:
                with open(env_file) as f:
                    for line in f:
                        line = line.strip()
                        # Skip comments and empty lines
                        if not line or line.startswith("#"):
                            continue
                        # Parse KEY=VALUE format
                        if "=" in line:
                            key, value = line.split("=", 1)
                            # Remove quotes if present
                            value = value.strip().strip('"').strip("'")
                            # Set as environment variable
                            os.environ[key.strip()] = value
                logger_debug = lambda msg: None  # No logger available at init
            except Exception:
                pass  # Silently ignore .env loading errors

    def _load(self) -> None:
        """
        Load configuration from file.

        If config file doesn't exist, use defaults.
        """
        if self.config_path.exists():
            with open(self.config_path) as f:
                file_config = toml.load(f)
            self._merge_config(file_config)
        else:
            self._config = deepcopy(self.DEFAULTS)

    def _merge_config(self, new_config: dict[str, Any]) -> None:
        """
        Merge new configuration into existing config using deep merge.

        Args:
            new_config: New configuration dictionary to merge
        """
        self._config = self._deep_merge(deepcopy(self.DEFAULTS), new_config)

    def _deep_merge(self, base: dict[str, Any], update: dict[str, Any]) -> dict[str, Any]:
        """
        Deep merge two dictionaries.

        Args:
            base: Base dictionary
            update: Dictionary to merge into base

        Returns:
            Merged dictionary
        """
        result = deepcopy(base)

        for key, value in update.items():
            if key in result and isinstance(result[key], dict) and isinstance(value, dict):
                result[key] = self._deep_merge(result[key], value)
            else:
                result[key] = value

        return result

    def _apply_env_overrides(self) -> None:
        """
        Apply environment variable overrides to configuration.

        Environment variables take precedence over config file values.
        Supported variables:
        - TELEGRAM_BOT_TOKEN
        - TELEGRAM_WEBHOOK_URL
        - TMUX_SESSION
        - PORT
        - LOG_LEVEL
        """
        env_mappings = {
            "TELEGRAM_BOT_TOKEN": "telegram.bot_token",
            "TELEGRAM_CHAT_ID": "telegram.chat_id",
            "TELEGRAM_WEBHOOK_URL": "telegram.webhook_url",
            "TMUX_SESSION": "tmux.session",
            "PORT": "server.port",
            "LOG_LEVEL": "logging.level",
        }

        for env_var, config_key in env_mappings.items():
            env_value = os.environ.get(env_var)
            if env_value is not None:
                # Convert port to integer
                if env_var == "PORT":
                    try:
                        env_value = int(env_value)
                    except ValueError:
                        continue

                self.set(config_key, env_value)

    def get(self, key: str, default: Any = None) -> Any:
        """
        Get configuration value by dot-separated key.

        Args:
            key: Dot-separated key (e.g., "telegram.bot_token")
            default: Default value if key not found

        Returns:
            Configuration value or default
        """
        keys = key.split(".")
        value = self._config

        for k in keys:
            if isinstance(value, dict) and k in value:
                value = value[k]
            else:
                return default

        return value

    def set(self, key: str, value: Any) -> None:
        """
        Set configuration value by dot-separated key.

        Args:
            key: Dot-separated key (e.g., "telegram.bot_token")
            value: Value to set
        """
        keys = key.split(".")
        config = self._config

        for k in keys[:-1]:
            if k not in config:
                config[k] = {}
            config = config[k]

        config[keys[-1]] = value

    def delete(self, key: str) -> None:
        """
        Delete configuration value by dot-separated key.

        Args:
            key: Dot-separated key (e.g., "telegram.bot_token")
        """
        keys = key.split(".")
        config = self._config

        for k in keys[:-1]:
            if k not in config:
                return
            config = config[k]

        if keys[-1] in config:
            del config[keys[-1]]

    def save(self) -> None:
        """
        Save configuration to file.

        Creates parent directories if they don't exist.
        """
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.config_path, "w") as f:
            toml.dump(self._config, f)

    @property
    def telegram(self) -> dict[str, Any]:
        """Get Telegram configuration section."""
        return self._config.get("telegram", {})

    @property
    def server(self) -> dict[str, Any]:
        """Get server configuration section."""
        return self._config.get("server", {})

    @property
    def tmux(self) -> dict[str, Any]:
        """Get tmux configuration section."""
        return self._config.get("tmux", {})

    @property
    def logging(self) -> dict[str, Any]:
        """Get logging configuration section."""
        return self._config.get("logging", {})

    @property
    def health(self) -> dict[str, Any]:
        """Get health configuration section."""
        return self._config.get("health", {})

    @property
    def tunnel(self) -> dict[str, Any]:
        """Get tunnel configuration section."""
        return self._config.get("tunnel", {})

    @property
    def instances(self) -> dict[str, Any]:
        """Get instances configuration section."""
        return self._config.get("instances", {})

    def _expand_paths(self) -> None:
        """
        Expand ~ in file paths to absolute paths.

        This is called after loading configuration to ensure all paths
        are expanded to their absolute form.
        """
        log_file = self.get("logging.file")
        if log_file and isinstance(log_file, str):
            if log_file.startswith("~"):
                self.set("logging.file", str(Path(log_file).expanduser()))


# Global config instance
_config: Config | None = None


def get_config() -> Config:
    """
    Get global configuration instance.

    Returns:
        Global Config instance
    """
    global _config
    if _config is None:
        _config = Config()
    return _config


# Convenience alias for settings
settings = get_config
