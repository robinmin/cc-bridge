"""
Tests for configuration management.

Tests follow TDD principles:
1. Write failing test first
2. Implement minimal code to pass
3. Refactor for cleanliness
"""

import os
from pathlib import Path
from unittest.mock import patch

import toml

from cc_bridge.config import Config, get_config


class TestConfigDefaults:
    """Test default configuration values."""

    def test_config_has_all_required_defaults(self, test_config_dir: Path):
        """Config should have all required default values."""
        # Use unique filename to avoid collisions
        config = Config(config_path=test_config_dir / "defaults_test.toml")

        assert config.get("telegram.bot_token") == ""
        assert config.get("telegram.webhook_url") == ""
        assert config.get("server.host") == "0.0.0.0"
        assert config.get("server.port") == 8080
        assert config.get("server.reload") is False
        assert config.get("tmux.session") == "claude"
        assert config.get("tmux.auto_attach") is True
        assert config.get("logging.level") == "INFO"
        assert config.get("logging.format") == "json"
        assert config.get("logging.max_bytes") == 10485760
        assert config.get("logging.backup_count") == 5
        assert config.get("health.enabled") is True
        assert config.get("health.interval_minutes") == 5
        assert config.get("tunnel.auto_start") is False

    def test_config_path_property_returns_expected_path(self):
        """Config should use correct default path."""
        config = Config()
        expected_path = Path.home() / ".claude" / "bridge" / "config.toml"
        assert config.config_path == expected_path


class TestConfigLoading:
    """Test configuration loading from file."""

    def test_loads_config_from_toml_file(self, test_config_dir: Path):
        """Config should load from TOML file."""
        config_file = test_config_dir / "load_toml_test.toml"
        config_data = {
            "telegram": {"bot_token": "test_token", "webhook_url": "https://test.com"},
            "server": {"host": "127.0.0.1", "port": 9000},
        }

        with config_file.open("w") as f:
            toml.dump(config_data, f)

        config = Config(config_path=config_file)

        assert config.get("telegram.bot_token") == "test_token"
        assert config.get("telegram.webhook_url") == "https://test.com"
        assert config.get("server.host") == "127.0.0.1"
        assert config.get("server.port") == 9000

    def test_uses_defaults_when_file_missing(self, test_config_dir: Path):
        """Config should use defaults when file doesn't exist."""
        config = Config(config_path=test_config_dir / "nonexistent.toml")

        # Should still have all defaults
        assert config.get("server.host") == "0.0.0.0"
        assert config.get("server.port") == 8080

    def test_expands_tilde_in_log_file_path(self, test_config_dir: Path):
        """Config should expand ~ in file paths."""
        config_file = test_config_dir / "expand_tilde_test.toml"
        config_data = {"logging": {"file": "~/logs/test.log"}}

        with config_file.open("w") as f:
            toml.dump(config_data, f)

        config = Config(config_path=config_file)
        log_file = config.get("logging.file")

        # Should be expanded to absolute path
        assert "~" not in log_file
        assert str(Path.home()) in log_file


class TestConfigEnvironmentVariables:
    """Test environment variable overrides."""

    def test_env_var_override_bot_token(self, test_config_dir: Path):
        """Environment variable should override config file."""
        config_file = test_config_dir / "env_bot_token_test.toml"
        config_data = {"telegram": {"bot_token": "file_token"}}
        with config_file.open("w") as f:
            toml.dump(config_data, f)

        with patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "env_token"}):
            config = Config(config_path=config_file)
            assert config.get("telegram.bot_token") == "env_token"

    def test_env_var_override_webhook_url(self, test_config_dir: Path):
        """Environment variable should override webhook URL."""
        config_file = test_config_dir / "env_webhook_test.toml"
        config_data = {"telegram": {"webhook_url": "https://file.com"}}
        with config_file.open("w") as f:
            toml.dump(config_data, f)

        with patch.dict(os.environ, {"TELEGRAM_WEBHOOK_URL": "https://env.com"}):
            config = Config(config_path=config_file)
            assert config.get("telegram.webhook_url") == "https://env.com"

    def test_env_var_override_tmux_session(self, test_config_dir: Path):
        """Environment variable should override tmux session."""
        config_file = test_config_dir / "env_tmux_test.toml"
        config_data = {"tmux": {"session": "file_session"}}
        with config_file.open("w") as f:
            toml.dump(config_data, f)

        with patch.dict(os.environ, {"TMUX_SESSION": "env_session"}):
            config = Config(config_path=config_file)
            assert config.get("tmux.session") == "env_session"

    def test_env_var_override_port(self, test_config_dir: Path):
        """Environment variable should override port."""
        config_file = test_config_dir / "env_port_test.toml"
        config_data = {"server": {"port": 8080}}
        with config_file.open("w") as f:
            toml.dump(config_data, f)

        with patch.dict(os.environ, {"PORT": "9000"}):
            config = Config(config_path=config_file)
            assert config.get("server.port") == 9000

    def test_env_var_override_log_level(self, test_config_dir: Path):
        """Environment variable should override log level."""
        config_file = test_config_dir / "env_log_level_test.toml"
        config_data = {"logging": {"level": "WARNING"}}
        with config_file.open("w") as f:
            toml.dump(config_data, f)

        with patch.dict(os.environ, {"LOG_LEVEL": "DEBUG"}):
            config = Config(config_path=config_file)
            assert config.get("logging.level") == "DEBUG"


class TestConfigDeepMerge:
    """Test deep merge functionality."""

    def test_deep_merge_preserves_nested_defaults(self, test_config_dir: Path):
        """Deep merge should preserve nested default values."""
        config_file = test_config_dir / "merge_nested_test.toml"
        config_data = {"telegram": {"bot_token": "test_token"}}
        with config_file.open("w") as f:
            toml.dump(config_data, f)

        config = Config(config_path=config_file)

        # Should have overridden value
        assert config.get("telegram.bot_token") == "test_token"
        # Should still have default for webhook_url
        assert config.get("telegram.webhook_url") == ""

    def test_deep_merge_multiple_levels(self, test_config_dir: Path):
        """Deep merge should work at multiple nesting levels."""
        config_file = test_config_dir / "merge_levels_test.toml"
        config_data = {
            "server": {"host": "127.0.0.1"},
            "logging": {"level": "DEBUG", "format": "text"},
        }
        with config_file.open("w") as f:
            toml.dump(config_data, f)

        config = Config(config_path=config_file)

        assert config.get("server.host") == "127.0.0.1"
        assert config.get("server.port") == 8080  # Default preserved
        assert config.get("logging.level") == "DEBUG"
        assert config.get("logging.format") == "text"
        # Path is expanded, so check that it starts with home directory
        log_file = config.get("logging.file")
        assert log_file.endswith(".claude/bridge/logs/bridge.log")


class TestConfigGetSetDelete:
    """Test get, set, and delete operations."""

    def test_get_with_dot_notation(self, test_config_dir: Path):
        """Should get values using dot notation."""
        config = Config(config_path=test_config_dir / "get_test.toml")

        assert config.get("server.host") == "0.0.0.0"
        assert config.get("logging.level") == "INFO"

    def test_get_returns_default_for_missing_key(self, test_config_dir: Path):
        """Should return default value for missing keys."""
        config = Config(config_path=test_config_dir / "get_test.toml")

        assert config.get("missing.key", "default") == "default"
        assert config.get("missing.key") is None

    def test_set_creates_nested_structure(self, test_config_dir: Path):
        """Should create nested structure when setting."""
        config = Config(config_path=test_config_dir / "set_test.toml")
        config.set("new.nested.key", "value")

        assert config.get("new.nested.key") == "value"

    def test_set_overwrites_existing_value(self, test_config_dir: Path):
        """Should overwrite existing values."""
        config = Config(config_path=test_config_dir / "set_test.toml")
        config.set("server.port", 9000)

        assert config.get("server.port") == 9000

    def test_delete_removes_key(self, test_config_dir: Path):
        """Should delete keys."""
        config = Config(config_path=test_config_dir / "delete_test.toml")
        config.set("test.key", "value")
        config.delete("test.key")

        assert config.get("test.key") is None

    def test_delete_missing_key_is_safe(self, test_config_dir: Path):
        """Deleting missing key should not raise error."""
        config = Config(config_path=test_config_dir / "delete_safe_test.toml")

        # Should not raise
        config.delete("missing.key")


class TestConfigSave:
    """Test configuration saving."""

    def test_save_creates_parent_directories(self, test_config_dir: Path):
        """Save should create parent directories."""
        config_file = test_config_dir / "nested" / "dir" / "config.toml"
        config = Config(config_path=config_file)
        config.set("test.key", "value")
        config.save()

        assert config_file.exists()
        assert config_file.parent.exists()

    def test_save_writes_toml_format(self, test_config_dir: Path):
        """Save should write valid TOML."""
        config_file = test_config_dir / "save_toml_test.toml"
        config = Config(config_path=config_file)
        config.set("telegram.bot_token", "test_token")
        config.save()

        # Load and verify
        loaded = toml.load(config_file)
        assert loaded["telegram"]["bot_token"] == "test_token"

    def test_save_preserves_all_config(self, test_config_dir: Path):
        """Save should preserve entire configuration."""
        config_file = test_config_dir / "save_test.toml"
        config = Config(config_path=config_file)
        config.set("server.port", 9000)
        config.save()

        # Create new instance and verify
        config2 = Config(config_path=config_file)
        assert config2.get("server.port") == 9000
        assert config2.get("server.host") == "0.0.0.0"


class TestConfigProperties:
    """Test configuration section properties."""

    def test_telegram_property(self, test_config_dir: Path):
        """Should return telegram section."""
        config_file = test_config_dir / "telegram_test.toml"
        config = Config(config_path=config_file)
        telegram = config.telegram

        assert telegram["bot_token"] == ""
        assert telegram["webhook_url"] == ""

    def test_server_property(self, test_config_dir: Path):
        """Should return server section."""
        config_file = test_config_dir / "server_test.toml"
        config = Config(config_path=config_file)
        server = config.server

        assert server["host"] == "0.0.0.0"
        assert server["port"] == 8080
        assert server["reload"] is False

    def test_tmux_property(self, test_config_dir: Path):
        """Should return tmux section."""
        config_file = test_config_dir / "tmux_test.toml"
        config = Config(config_path=config_file)
        tmux = config.tmux

        assert tmux["session"] == "claude"
        assert tmux["auto_attach"] is True

    def test_logging_property(self, test_config_dir: Path):
        """Should return logging section."""
        config = Config(config_path=test_config_dir / "logging_test.toml")
        logging = config.logging

        assert logging["level"] == "INFO"
        assert logging["format"] == "json"

    def test_health_property(self, test_config_dir: Path):
        """Should return health section."""
        config = Config(config_path=test_config_dir / "health_test.toml")
        health = config.health

        assert health["enabled"] is True
        assert health["interval_minutes"] == 5

    def test_tunnel_property(self, test_config_dir: Path):
        """Should return tunnel section."""
        config = Config(config_path=test_config_dir / "tunnel_test.toml")
        tunnel = config.tunnel

        assert tunnel["auto_start"] is False


class TestGlobalConfig:
    """Test global configuration instance."""

    def test_get_config_returns_singleton(self, test_config_dir: Path):
        """Should return same instance on multiple calls."""
        config1 = get_config()
        config2 = get_config()

        assert config1 is config2

    def test_get_config_creates_instance_if_none(self):
        """Should create instance if not exists."""
        # Reset global config
        import cc_bridge.config  # noqa: PLC0415

        cc_bridge.config._config = None

        config = get_config()
        assert config is not None
        assert isinstance(config, Config)
