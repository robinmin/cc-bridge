"""
Cloudflare Tunnel Management

This module provides business logic for managing Cloudflare tunnels
with automatic webhook configuration.
"""

from __future__ import annotations

import re
import subprocess
import time

from cc_bridge.packages.logging import get_logger

__all__ = [
    "CloudflareTunnelManager",
    "parse_tunnel_url",
    "TUNNEL_URL_PATTERN",
]

logger = get_logger(__name__)

# Pattern to match cloudflared quick tunnel URL
TUNNEL_URL_PATTERN = re.compile(r"https://[a-z0-9\-]+\.trycloudflare\.com")


def parse_tunnel_url(output: str) -> str | None:
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


class CloudflareTunnelManager:
    """
    Manages Cloudflare tunnel lifecycle.

    Handles starting, stopping, and monitoring cloudflared tunnels
    for exposing local services to the internet.
    """

    def __init__(self, port: int = 8080, timeout: int = 30) -> None:
        """
        Initialize tunnel manager.

        Args:
            port: Local port to expose through the tunnel
            timeout: Maximum seconds to wait for tunnel URL
        """
        self._port = port
        self._timeout = timeout
        self._process: subprocess.Popen[str] | None = None
        self._url: str | None = None
        self._running = False

    async def start(self) -> str:
        """
        Start Cloudflare tunnel and return URL.

        Spawns cloudflared process, monitors output for the tunnel URL,
        and returns it once found.

        Returns:
            Tunnel URL

        Raises:
            RuntimeError: If tunnel fails to start or URL not found
        """
        logger.info("Starting cloudflared tunnel", port=self._port)

        try:
            # Start cloudflared as subprocess
            self._process = subprocess.Popen(
                ["cloudflared", "tunnel", "--url", f"http://localhost:{self._port}"],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
            )
            self._running = True

            # Monitor output for tunnel URL
            start_time = time.time()
            url = None

            while time.time() - start_time < self._timeout:
                try:
                    # Non-blocking read with timeout
                    assert self._process is not None  # for type checker
                    assert self._process.stdout is not None  # for type checker
                    line = self._process.stdout.readline()
                    if not line:
                        # Process ended
                        if self._process.poll() is not None:
                            self._running = False
                            raise RuntimeError(
                                "cloudflared process terminated unexpectedly"
                            )
                        time.sleep(0.1)
                        continue

                    # Parse URL from output
                    url = parse_tunnel_url(line)
                    if url:
                        self._url = url
                        logger.info("Tunnel URL found", url=url)
                        return url

                except Exception as e:
                    logger.debug("Error reading cloudflared output", error=str(e))
                    time.sleep(0.1)

            # Timeout reached
            self.stop()
            raise RuntimeError(f"Timeout waiting for tunnel URL ({self._timeout}s)")

        except FileNotFoundError:
            self._running = False
            raise RuntimeError(
                "cloudflared not found. Install from: "
                "https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/"
            ) from None
        except Exception as e:
            self._running = False
            logger.error("Failed to start tunnel", error=str(e))
            raise RuntimeError(f"Failed to start tunnel: {e}") from e

    def stop(self) -> None:
        """
        Stop running Cloudflare tunnel.

        Gracefully shuts down the cloudflared process.
        """
        # Stop our managed process
        if self._process is not None:
            try:
                self._process.terminate()
                self._process.wait(timeout=5)
                logger.info("Terminated cloudflared process")
            except subprocess.TimeoutExpired:
                self._process.kill()
                logger.warning("Killed cloudflared process (timeout)")
            except Exception as e:
                logger.debug("Error terminating process", error=str(e))
            finally:
                self._process = None

        self._running = False
        self._url = None

        # Also clean up any orphaned cloudflared processes
        self._cleanup_orphaned_processes()

    def _cleanup_orphaned_processes(self) -> None:
        """Find and terminate any orphaned cloudflared tunnel processes."""
        try:
            result = subprocess.run(
                ["pgrep", "-f", "cloudflared tunnel"],
                capture_output=True,
                text=True,
                check=False,
            )

            if result.returncode == 0:
                pids = result.stdout.strip().split("\n")
                for pid in pids:
                    try:
                        subprocess.run(["kill", pid], check=True)
                        logger.info("Terminated orphaned cloudflared process", pid=pid)
                    except subprocess.CalledProcessError:
                        pass

        except FileNotFoundError:
            # pgrep not available on this system
            pass
        except Exception as e:
            logger.debug("Error cleaning up orphaned processes", error=str(e))

    def is_running(self) -> bool:
        """
        Check if tunnel is running.

        Returns:
            True if tunnel process is active
        """
        if not self._running or self._process is None:
            return False

        # Check if process is still alive
        return self._process.poll() is None

    @property
    def url(self) -> str | None:
        """
        Get the tunnel URL.

        Returns:
            Tunnel URL if available, None otherwise
        """
        return self._url

    @property
    def port(self) -> int:
        """Get the local port being exposed."""
        return self._port
