"""
Tests for configuration models.

This module tests Pydantic configuration models for validation,
defaults, and field constraints.
"""

import pydantic
import pytest

from cc_bridge.models.config import (
    BridgeConfig,
    HealthConfig,
    LoggingConfig,
    ServerConfig,
    TelegramConfig,
    TmuxConfig,
    TunnelConfig,
)


class TestTelegramConfig:
    """Tests for TelegramConfig model."""

    def test_create_with_required_fields(self):
        """Test creating TelegramConfig with required fields."""
        config = TelegramConfig(bot_token="123456:ABC-DEF")
        assert config.bot_token == "123456:ABC-DEF"
        assert config.webhook_url is None

    def test_create_with_webhook_url(self):
        """Test creating TelegramConfig with webhook URL."""
        config = TelegramConfig(
            bot_token="123456:ABC-DEF", webhook_url="https://example.com/webhook"
        )
        assert config.webhook_url == "https://example.com/webhook"

    def test_bot_token_cannot_be_empty(self):
        """Test that empty bot_token raises validation error."""
        with pytest.raises(pydantic.ValidationError):
            TelegramConfig(bot_token="")

    def test_bot_token_min_length_validation(self):
        """Test bot_token minimum length validation."""
        with pytest.raises(pydantic.ValidationError):
            TelegramConfig(bot_token="")


class TestServerConfig:
    """Tests for ServerConfig model."""

    def test_default_values(self):
        """Test ServerConfig default values."""
        config = ServerConfig()
        assert config.host == "0.0.0.0"
        assert config.port == 8080
        assert config.reload is False

    def test_custom_host(self):
        """Test custom host configuration."""
        config = ServerConfig(host="127.0.0.1")
        assert config.host == "127.0.0.1"

    def test_custom_port(self):
        """Test custom port configuration."""
        config = ServerConfig(port=9000)
        assert config.port == 9000

    def test_port_minimum_boundary(self):
        """Test port minimum boundary (1)."""
        config = ServerConfig(port=1)
        assert config.port == 1

    def test_port_maximum_boundary(self):
        """Test port maximum boundary (65535)."""
        config = ServerConfig(port=65535)
        assert config.port == 65535

    def test_port_below_minimum_raises_error(self):
        """Test that port below 1 raises validation error."""
        with pytest.raises(pydantic.ValidationError):
            ServerConfig(port=0)

    def test_port_above_maximum_raises_error(self):
        """Test that port above 65535 raises validation error."""
        with pytest.raises(pydantic.ValidationError):
            ServerConfig(port=65536)

    def test_reload_enabled(self):
        """Test reload flag can be enabled."""
        config = ServerConfig(reload=True)
        assert config.reload is True


class TestTmuxConfig:
    """Tests for TmuxConfig model."""

    def test_default_values(self):
        """Test TmuxConfig default values."""
        config = TmuxConfig()
        assert config.session == "claude"
        assert config.auto_attach is True

    def test_custom_session(self):
        """Test custom session name."""
        config = TmuxConfig(session="my-session")
        assert config.session == "my-session"

    def test_auto_attach_disabled(self):
        """Test auto_attach can be disabled."""
        config = TmuxConfig(auto_attach=False)
        assert config.auto_attach is False


class TestLoggingConfig:
    """Tests for LoggingConfig model."""

    def test_default_values(self):
        """Test LoggingConfig default values."""
        config = LoggingConfig()
        assert config.level == "INFO"
        assert config.format == "json"
        assert config.file == "~/.claude/bridge/logs/bridge.log"
        assert config.max_bytes == 10485760  # 10MB
        assert config.backup_count == 5

    def test_custom_level(self):
        """Test custom log level."""
        config = LoggingConfig(level="DEBUG")
        assert config.level == "DEBUG"

    def test_text_format(self):
        """Test text format instead of json."""
        config = LoggingConfig(format="text")
        assert config.format == "text"

    def test_custom_file_path(self):
        """Test custom log file path."""
        config = LoggingConfig(file="/var/log/cc-bridge.log")
        assert config.file == "/var/log/cc-bridge.log"

    def test_custom_max_bytes(self):
        """Test custom max_bytes setting."""
        config = LoggingConfig(max_bytes=5242880)  # 5MB
        assert config.max_bytes == 5242880

    def test_custom_backup_count(self):
        """Test custom backup_count setting."""
        config = LoggingConfig(backup_count=10)
        assert config.backup_count == 10

    def test_backup_count_minimum_boundary(self):
        """Test backup_count minimum boundary (0)."""
        config = LoggingConfig(backup_count=0)
        assert config.backup_count == 0

    def test_backup_count_below_minimum_raises_error(self):
        """Test that backup_count below 0 raises validation error."""
        with pytest.raises(pydantic.ValidationError):
            LoggingConfig(backup_count=-1)


class TestHealthConfig:
    """Tests for HealthConfig model."""

    def test_default_values(self):
        """Test HealthConfig default values."""
        config = HealthConfig()
        assert config.enabled is True
        assert config.interval_minutes == 5

    def test_health_disabled(self):
        """Test health checks can be disabled."""
        config = HealthConfig(enabled=False)
        assert config.enabled is False

    def test_custom_interval(self):
        """Test custom interval_minutes."""
        config = HealthConfig(interval_minutes=10)
        assert config.interval_minutes == 10

    def test_interval_minimum_boundary(self):
        """Test interval_minutes minimum boundary (1)."""
        config = HealthConfig(interval_minutes=1)
        assert config.interval_minutes == 1

    def test_interval_below_minimum_raises_error(self):
        """Test that interval_minutes below 1 raises validation error."""
        with pytest.raises(pydantic.ValidationError):
            HealthConfig(interval_minutes=0)


class TestTunnelConfig:
    """Tests for TunnelConfig model."""

    def test_default_values(self):
        """Test TunnelConfig default values."""
        config = TunnelConfig()
        assert config.auto_start is False

    def test_auto_start_enabled(self):
        """Test auto_start can be enabled."""
        config = TunnelConfig(auto_start=True)
        assert config.auto_start is True


class TestBridgeConfig:
    """Tests for BridgeConfig model."""

    def test_create_with_required_telegram(self):
        """Test creating BridgeConfig with required Telegram config."""
        telegram = TelegramConfig(bot_token="123456:ABC-DEF")
        config = BridgeConfig(telegram=telegram)
        assert config.telegram.bot_token == "123456:ABC-DEF"
        assert config.server.host == "0.0.0.0"
        assert config.tmux.session == "claude"

    def test_all_default_sub_configs(self):
        """Test all sub-configs have proper defaults."""
        telegram = TelegramConfig(bot_token="123456:ABC-DEF")
        config = BridgeConfig(telegram=telegram)

        # Server defaults
        assert config.server.port == 8080
        assert config.server.reload is False

        # Tmux defaults
        assert config.tmux.session == "claude"
        assert config.tmux.auto_attach is True

        # Logging defaults
        assert config.logging.level == "INFO"
        assert config.logging.format == "json"

        # Health defaults
        assert config.health.enabled is True
        assert config.health.interval_minutes == 5

        # Tunnel defaults
        assert config.tunnel.auto_start is False

    def test_custom_server_config(self):
        """Test custom server configuration."""
        telegram = TelegramConfig(bot_token="123456:ABC-DEF")
        server = ServerConfig(host="127.0.0.1", port=9000)
        config = BridgeConfig(telegram=telegram, server=server)
        assert config.server.host == "127.0.0.1"
        assert config.server.port == 9000

    def test_custom_logging_config(self):
        """Test custom logging configuration."""
        telegram = TelegramConfig(bot_token="123456:ABC-DEF")
        logging = LoggingConfig(level="DEBUG", format="text")
        config = BridgeConfig(telegram=telegram, logging=logging)
        assert config.logging.level == "DEBUG"
        assert config.logging.format == "text"

    def test_custom_health_config(self):
        """Test custom health configuration."""
        telegram = TelegramConfig(bot_token="123456:ABC-DEF")
        health = HealthConfig(enabled=False, interval_minutes=10)
        config = BridgeConfig(telegram=telegram, health=health)
        assert config.health.enabled is False
        assert config.health.interval_minutes == 10

    def test_serialization_to_dict(self):
        """Test that config can be serialized to dict."""
        telegram = TelegramConfig(bot_token="123456:ABC-DEF")
        config = BridgeConfig(telegram=telegram)
        config_dict = config.model_dump()
        assert "telegram" in config_dict
        assert "server" in config_dict
        assert "tmux" in config_dict

    def test_serialization_to_json(self):
        """Test that config can be serialized to JSON."""
        telegram = TelegramConfig(bot_token="123456:ABC-DEF")
        config = BridgeConfig(telegram=telegram)
        json_str = config.model_dump_json()
        assert "telegram" in json_str
        assert "bot_token" in json_str
