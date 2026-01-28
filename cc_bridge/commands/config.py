"""
Config command implementation.

This module implements configuration management commands:
- Get configuration values
- Set configuration values
- Delete configuration values
"""

from cc_bridge.config import Config


def get_value(key: str) -> str:
    """
    Get configuration value by dot-separated key.

    Args:
        key: Dot-separated key (e.g., "telegram.bot_token")

    Returns:
        Configuration value as string
    """
    config = Config()
    value = config.get(key)
    if value is None:
        print(f"Key not found: {key}")
        return ""
    return str(value)


def set_value(key: str, value: str) -> None:
    """
    Set configuration value by dot-separated key.

    Args:
        key: Dot-separated key (e.g., "telegram.bot_token")
        value: Value to set
    """
    config = Config()
    config.set(key, value)
    config.save()
    print(f"Set {key} = {value}")


def delete_value(key: str) -> None:
    """
    Delete configuration value by dot-separated key.

    Args:
        key: Dot-separated key (e.g., "telegram.bot_token")
    """
    config = Config()
    config.delete(key)
    config.save()
    print(f"Deleted {key}")


def main(key: str | None = None, value: str | None = None, delete: bool = False) -> int:
    """
    Main entry point for config command.

    Args:
        key: Configuration key
        value: Configuration value to set
        delete: Delete the configuration key

    Returns:
        Exit code (0 for success, 1 for error)
    """
    try:
        # TODO: Implement config command (Task 0009)
        if key and value:
            set_value(key, value)
        elif key and delete:
            delete_value(key)
        elif key:
            result = get_value(key)
            if result:
                print(result)
        else:
            # Show all config
            config = Config()
            print("Current configuration:")
            # TODO: Pretty print config
        return 0
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
