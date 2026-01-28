"""
Tests for tunnel command.
"""

from cc_bridge.commands.tunnel import start_tunnel, stop_tunnel


def test_start_tunnel():
    """Test starting tunnel."""
    # TODO: Implement tunnel tests (Task 0010)
    url = start_tunnel(port=8080)
    assert url is not None
    assert url.startswith("https://")


def test_stop_tunnel():
    """Test stopping tunnel."""
    # TODO: Implement tunnel tests (Task 0010)
    stop_tunnel()
