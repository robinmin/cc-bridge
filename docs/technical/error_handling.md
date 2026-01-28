# Error Handling Framework

Comprehensive error handling framework for cc-bridge with custom exceptions, retry logic, and enhanced logging.

## Overview

The error handling framework provides:

1. **Custom Exception Hierarchy** - Specific exception types for different error scenarios
2. **Retry Decorator** - Automatic retry with exponential backoff for transient failures
3. **Enhanced Logging** - Structured logging with context for better debugging
4. **User-Friendly Messages** - Clear error messages for end users

## Installation

The error handling framework is part of the `cc_bridge` package:

```python
from cc_bridge import (
    CCBridgeError,
    ConfigError,
    TelegramError,
    TmuxError,
    TunnelError,
    HookError,
    retry,
)
from cc_bridge.logging import setup_logging, get_logger, log_exception, set_context
```

## Custom Exceptions

### Exception Hierarchy

```
CCBridgeError (base)
├── ConfigError (configuration issues)
├── TelegramError (Telegram API errors)
├── TmuxError (tmux operation errors)
├── TunnelError (Cloudflare tunnel errors)
└── HookError (Hook operation errors)
```

### Usage Examples

#### ConfigError

```python
from cc_bridge import ConfigError

# Validate configuration
if not BOT_TOKEN:
    raise ConfigError(
        "TELEGRAM_BOT_TOKEN not set",
        field="TELEGRAM_BOT_TOKEN",
        context={"env_var": "TELEGRAM_BOT_TOKEN"}
    )
```

#### TelegramError

```python
from cc_bridge import TelegramError

# API call failed
if response.status_code == 429:
    raise TelegramError(
        "Rate limit exceeded",
        status_code=429,
        context={"retry_after": 30}
    )
```

#### TmuxError

```python
from cc_bridge import TmuxError

# tmux session not found
if not tmux_exists():
    raise TmuxError(
        "tmux session not found",
        session="claude",
        context={"available_sessions": ["session1", "session2"]}
    )
```

## Retry Decorator

The `@retry` decorator automatically retries failed operations with exponential backoff.

### Basic Usage

```python
from cc_bridge import retry, TelegramError

@retry(max_attempts=3, delay=1.0)
def send_message(chat_id: int, text: str):
    # May fail temporarily due to network issues
    telegram_api.send_message(chat_id, text)
```

### Advanced Usage

```python
from cc_bridge import retry, TelegramError, TmuxError

# Retry only on specific exceptions
@retry(
    max_attempts=5,
    delay=0.5,
    backoff_factor=2.0,
    exceptions=(TelegramError, TmuxError)
)
def flaky_operation():
    # Retries up to 5 times
    # Starts with 0.5s delay, then 1s, 2s, 4s, 8s
    pass
```

### Parameters

- `max_attempts` (int): Maximum number of attempts (default: 3)
- `delay` (float): Initial delay in seconds (default: 1.0)
- `backoff_factor` (float): Exponential backoff multiplier (default: 2.0)
- `exceptions` (tuple): Exception types to catch (default: all exceptions)

### Error Handling

When all retries are exhausted, a `MaxRetriesExceededError` is raised:

```python
from cc_bridge import retry, MaxRetriesExceededError

try:
    @retry(max_attempts=3)
    def failing_function():
        raise Exception("Always fails")
    failing_function()
except MaxRetriesExceededError as e:
    print(f"Failed after {e.max_attempts} attempts")
    print(f"Last error: {e.last_error}")
    # Access original exception
    print(f"Original: {e.__cause__}")
```

## Enhanced Logging

### Setup

```python
from cc_bridge.logging import setup_logging

# Basic setup
setup_logging(level=20)  # INFO level

# With file output
from pathlib import Path
setup_logging(
    level=10,  # DEBUG level
    log_file=Path("~/.claude/bridge/bridge.log").expanduser()
)
```

### Context-Aware Logging

```python
from cc_bridge.logging import set_context, get_logger

logger = get_logger(__name__)

# Set context for all subsequent log messages
set_context(chat_id=12345, session_id="abc")

# Log message will include context
logger.info("Message received")
# Output: 2025-01-27 10:30:00 - __main__ - INFO - Message received | chat_id=12345 | session_id=abc

# Clear context
set_context()
```

### Exception Logging

```python
from cc_bridge.logging import log_exception
from cc_bridge import TelegramError

logger = get_logger(__name__)

try:
    # Some operation that might fail
    telegram_api.send_message(chat_id, text)
except TelegramError as e:
    # Log exception with full context
    log_exception(
        logger,
        "Failed to send message",
        e,
        extra={"chat_id": chat_id, "text": text[:50]}
    )
```

Output includes:
- Human-readable message
- Exception type and message
- Exception context (if available)
- Stack trace
- Extra context information

## Integration with Existing Code

### Example: Updating bridge.py

```python
# Before (old code)
import subprocess

def tmux_exists():
    return subprocess.run(
        ["tmux", "has-session", "-t", TMUX_SESSION],
        capture_output=True
    ).returncode == 0


# After (new code with error handling)
import subprocess
from cc_bridge import TmuxError
from cc_bridge.logging import get_logger, log_exception

logger = get_logger(__name__)

def tmux_exists():
    """Check if tmux session exists

    Raises:
        TmuxError: If tmux command fails unexpectedly
    """
    try:
        result = subprocess.run(
            ["tmux", "has-session", "-t", TMUX_SESSION],
            capture_output=True,
            text=True,
            timeout=5,
        )
        return result.returncode == 0

    except subprocess.TimeoutExpired:
        raise TmuxError(
            "tmux command timed out",
            session=TMUX_SESSION,
            context={"timeout": 5}
        )
    except FileNotFoundError:
        raise TmuxError(
            "tmux not found in PATH",
            session=TMUX_SESSION
        )
```

### Example: Updating webhook handler

```python
# Before (old code)
def handle_message(self, update):
    try:
        # Process message
        pass
    except Exception as e:
        print(f"Error: {e}")


# After (new code with error handling)
from cc_bridge import TelegramError, TmuxError
from cc_bridge.logging import log_exception, set_context

def handle_message(self, update):
    chat_id = update.get("message", {}).get("chat", {}).get("id")
    set_context(chat_id=chat_id)

    try:
        # Process message
        pass

    except TelegramError as e:
        log_exception(self.logger, "Telegram API error", e)
        self.reply(chat_id, f"Telegram error: {e.message}")

    except TmuxError as e:
        log_exception(self.logger, "Tmux error", e)
        self.reply(chat_id, f"tmux error: {e.message}")

    finally:
        set_context()
```

## Best Practices

### 1. Use Specific Exception Types

```python
# Good
raise TelegramError("API call failed", status_code=400)

# Avoid
raise Exception("Something went wrong")
```

### 2. Provide Context

```python
# Good
raise ConfigError(
    "Invalid bot token",
    field="bot_token",
    context={"provided_value": token[:10] + "..."}
)

# Avoid
raise ConfigError("Invalid config")
```

### 3. Use Retry for Transient Failures

```python
# Good - network operations
@retry(max_attempts=3, delay=1.0)
def send_message(chat_id, text):
    telegram_api.send_message(chat_id, text)

# Avoid - don't retry config errors
def validate_config():
    if not BOT_TOKEN:
        raise ConfigError("Missing token")  # No retry
```

### 4. Log All Errors

```python
# Good
try:
    operation()
except Exception as e:
    log_exception(logger, "Operation failed", e)
    # Handle error

# Avoid
try:
    operation()
except Exception:
    pass  # Silent failure
```

### 5. Provide User-Friendly Messages

```python
# Good
except ConfigError as e:
    logger.error(f"Config error: {e}")
    reply(chat_id, "Configuration error. Please check your bot token.")

# Avoid
except ConfigError as e:
    reply(chat_id, f"Error: {e}")  # Too technical
```

## Testing

The error handling framework includes comprehensive tests:

```bash
# Run all tests
pytest tests/

# Run specific test file
pytest tests/test_exceptions.py
pytest tests/test_retry.py
pytest tests/test_logging.py

# Run with coverage
pytest --cov=cc_bridge tests/
```

## Migration Guide

### Step 1: Update Imports

```python
# Add to imports
from cc_bridge import (
    ConfigError,
    TelegramError,
    TmuxError,
    retry,
)
from cc_bridge.logging import setup_logging, get_logger, log_exception
```

### Step 2: Setup Logging

```python
# At the start of your main file
setup_logging(level=20)  # INFO level
logger = get_logger(__name__)
```

### Step 3: Replace Generic Exceptions

```python
# Before
if not BOT_TOKEN:
    raise ValueError("Missing token")

# After
if not BOT_TOKEN:
    raise ConfigError("Missing token", field="TELEGRAM_BOT_TOKEN")
```

### Step 4: Add Retry Logic

```python
# Before
def send_message(chat_id, text):
    telegram_api.send_message(chat_id, text)

# After
@retry(max_attempts=3, delay=1.0)
def send_message(chat_id, text):
    telegram_api.send_message(chat_id, text)
```

### Step 5: Improve Error Logging

```python
# Before
except Exception as e:
    print(f"Error: {e}")

# After
except Exception as e:
    log_exception(logger, "Operation failed", e)
```

## Further Reading

- [Example Integration](../examples/error_handling_example.py) - Complete example with all features
- [Test Suite](../tests/) - Comprehensive test examples
- [Exception Documentation](../cc_bridge/exceptions.py) - Detailed exception class documentation
- [Retry Documentation](../cc_bridge/retry.py) - Retry decorator implementation
- [Logging Documentation](../cc_bridge/logging.py) - Logging utilities
