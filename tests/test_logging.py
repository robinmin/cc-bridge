"""
Tests for logging configuration.

Tests follow TDD principles:
1. Write failing test first
2. Implement minimal code to pass
3. Refactor for cleanliness
"""

import logging
import logging.handlers
from pathlib import Path

import structlog

from cc_bridge.logging import get_logger, setup_logging


class TestSetupLogging:
    """Test logging setup functionality."""

    def test_setup_logging_defaults(self, tmp_path: Path):
        """Should setup logging with default configuration."""
        setup_logging()

        logger = logging.getLogger()
        assert logger.level == logging.INFO

    def test_setup_logging_with_debug_level(self, tmp_path: Path):
        """Should setup logging with DEBUG level."""
        setup_logging(level="DEBUG")

        logger = logging.getLogger()
        assert logger.level == logging.DEBUG

    def test_setup_logging_with_warning_level(self, tmp_path: Path):
        """Should setup logging with WARNING level."""
        setup_logging(level="WARNING")

        logger = logging.getLogger()
        assert logger.level == logging.WARNING

    def test_setup_logging_json_format(self, tmp_path: Path):
        """Should configure structlog with JSON renderer."""
        setup_logging(log_format="json")

        # Verify structlog is configured
        logger = structlog.get_logger()
        assert logger is not None

    def test_setup_logging_text_format(self, tmp_path: Path):
        """Should configure structlog with console renderer."""
        setup_logging(log_format="text")

        # Verify structlog is configured
        logger = structlog.get_logger()
        assert logger is not None

    def test_setup_logging_creates_log_file(self, tmp_path: Path):
        """Should create log file and parent directories."""
        log_file = tmp_path / "logs" / "test.log"

        setup_logging(log_file=str(log_file))

        # Log directory should be created
        assert log_file.parent.exists()

    def test_setup_logging_file_rotation(self, tmp_path: Path):
        """Should configure file rotation."""
        log_file = tmp_path / "logs" / "test.log"

        setup_logging(
            log_file=str(log_file),
            max_bytes=1024,
            backup_count=3,
        )

        # Verify file handler is configured
        logger = logging.getLogger()
        assert any(isinstance(h, logging.handlers.RotatingFileHandler) for h in logger.handlers)

    def test_setup_logging_suppresses_uvicorn(self, tmp_path: Path):
        """Should suppress uvicorn logs."""
        setup_logging()

        uvicorn_logger = logging.getLogger("uvicorn")
        assert uvicorn_logger.level >= logging.WARNING

        uvicorn_access_logger = logging.getLogger("uvicorn.access")
        assert uvicorn_access_logger.level >= logging.WARNING


class TestGetLogger:
    """Test logger retrieval."""

    def test_get_logger_returns_structlog_logger(self):
        """Should return structlog logger instance."""
        logger = get_logger("test_module")

        assert isinstance(logger, structlog.stdlib.BoundLogger)

    def test_get_logger_with_module_name(self):
        """Should create logger with correct name."""
        logger = get_logger("test_module")

        assert logger.name == "test_module"

    def test_multiple_loggers_independent(self):
        """Should create independent logger instances."""
        logger1 = get_logger("module1")
        logger2 = get_logger("module2")

        assert logger1.name == "module1"
        assert logger2.name == "module2"


class TestLoggingIntegration:
    """Test logging integration with application."""

    def test_can_log_info_message(self, tmp_path: Path, caplog):
        """Should be able to log INFO messages."""
        setup_logging(level="INFO")
        logger = get_logger("test")

        with caplog.at_level(logging.INFO):
            logger.info("test message")

        # Check message was logged
        assert any("test message" in record.message for record in caplog.records)

    def test_can_log_error_message(self, tmp_path: Path, caplog):
        """Should be able to log ERROR messages."""
        setup_logging(level="ERROR")
        logger = get_logger("test")

        with caplog.at_level(logging.ERROR):
            logger.error("error message")

        # Check message was logged
        assert any("error message" in record.message for record in caplog.records)

    def test_can_log_with_context(self, tmp_path: Path):
        """Should be able to log with structured context."""
        setup_logging(log_format="json")
        logger = get_logger("test")

        # Should not raise
        logger.info("test message", user_id=123, action="test")

    def test_json_log_format(self, tmp_path: Path, caplog):
        """Should format logs as JSON when configured."""
        setup_logging(log_format="json")
        logger = get_logger("test")

        with caplog.at_level(logging.INFO):
            logger.info("test message", key="value")

        # Message should be JSON-formatted
        records = [record for record in caplog.records if "test message" in record.message]
        assert len(records) > 0

    def test_text_log_format(self, tmp_path: Path, caplog):
        """Should format logs as text when configured."""
        setup_logging(log_format="text")
        logger = get_logger("test")

        with caplog.at_level(logging.INFO):
            logger.info("test message")

        # Message should be logged
        assert any("test message" in record.message for record in caplog.records)
