"""
Tunnel command implementation.

This module implements Cloudflare tunnel management with automatic
webhook configuration.
"""

import re
import subprocess
import sys
from typing import Optional

from cc_bridge.logging import get_logger

logger = get_logger(__name__)

# Pattern to match cloudflared quick tunnel URL
# Example: "https://abc123.trycloudflare.com"
TUNNEL_URL_PATTERN = re.compile(r'https://[a-z0-9\-]+\.trycloudflare\.com')


def parse_tunnel_url(output: str) -> Optional[str]:
    """
    Parse tunnel URL from cloudflared output.

    Args:
        output: stdout/stderr from cloudflared process

    Returns:
        Tunnel URL if found, None otherwise
    """
    match = TUNNEL_URL_PATTERN.search(output)
    if match:
        url = match.group(0)
        logger.info("Extracted tunnel URL", url=url)
        return url
    return None


def start_tunnel(port: int = 8080, timeout: int = 30) -> str:
    """
    Start Cloudflare tunnel and return URL.

    Spawns cloudflared process, monitors output for the tunnel URL,
    and returns it once found.

    Args:
        port: Local port to expose
        timeout: Maximum seconds to wait for URL

    Returns:
        Tunnel URL

    Raises:
        RuntimeError: If tunnel fails to start or URL not found
    """
    logger.info("Starting cloudflared tunnel", port=port)

    try:
        # Start cloudflared as subprocess
        process = subprocess.Popen(
            ["cloudflared", "tunnel", "--url", f"http://localhost:{port}"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True
        )

        # Monitor output for tunnel URL
        import time
        start_time = time.time()
        url = None

        while time.time() - start_time < timeout:
            try:
                # Non-blocking read with timeout
                line = process.stdout.readline()
                if not line:
                    # Process ended
                    if process.poll() is not None:
                        raise RuntimeError("cloudflared process terminated unexpectedly")
                    time.sleep(0.1)
                    continue

                # Parse URL from output
                url = parse_tunnel_url(line)
                if url:
                    logger.info("Tunnel URL found", url=url)
                    return url

            except Exception as e:
                logger.debug("Error reading cloudflared output", error=str(e))
                time.sleep(0.1)

        # Timeout reached
        process.terminate()
        process.wait(timeout=5)
        raise RuntimeError(f"Timeout waiting for tunnel URL ({timeout}s)")

    except FileNotFoundError:
        raise RuntimeError(
            "cloudflared not found. Install from: "
            "https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/"
        )
    except Exception as e:
        logger.error("Failed to start tunnel", error=str(e))
        raise RuntimeError(f"Failed to start tunnel: {e}")


def stop_tunnel() -> None:
    """
    Stop running Cloudflare tunnel.

    Gracefully shuts down the cloudflared process.
    """
    # Find and terminate cloudflared processes
    try:
        result = subprocess.run(
            ["pgrep", "-f", "cloudflared tunnel"],
            capture_output=True,
            text=True
        )

        if result.returncode == 0:
            pids = result.stdout.strip().split('\n')
            for pid in pids:
                try:
                    subprocess.run(["kill", pid], check=True)
                    logger.info("Terminated cloudflared process", pid=pid)
                except subprocess.CalledProcessError:
                    pass

        logger.info("Cloudflare tunnel stopped")

    except Exception as e:
        logger.error("Failed to stop tunnel", error=str(e))
        raise RuntimeError(f"Failed to stop tunnel: {e}")


async def set_webhook(url: str, bot_token: str) -> bool:
    """
    Set Telegram webhook to tunnel URL.

    Args:
        url: Tunnel URL
        bot_token: Telegram bot token

    Returns:
        True if webhook set successfully
    """
    import httpx

    api_url = f"https://api.telegram.org/bot{bot_token}/setWebhook"

    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                api_url,
                json={"url": url}
            )
            result = response.json()

            if result.get("ok"):
                logger.info("Webhook set successfully", url=url)
                return True
            else:
                logger.error("Failed to set webhook", error=result)
                return False

    except Exception as e:
        logger.error("Failed to set webhook", error=str(e))
        return False


def main(start: bool = False, stop: bool = False, port: int = 8080) -> int:
    """
    Main entry point for tunnel command.

    Args:
        start: Start a new tunnel
        stop: Stop the running tunnel
        port: Local port to expose

    Returns:
        Exit code (0 for success, 1 for error)
    """
    try:
        if start:
            url = start_tunnel(port)
            print(f"Tunnel started: {url}")

            # Auto-set webhook if bot token available
            # TODO: Get bot token from config
            # await set_webhook(url, bot_token)

        elif stop:
            stop_tunnel()
            print("Tunnel stopped")

        else:
            print("Error: Specify --start or --stop")
            return 1

        return 0
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
