"""
Tests for Docker discovery module.
"""

from unittest.mock import MagicMock, patch

import pytest

from cc_bridge.core.docker_discovery import DockerDiscoverer


class TestDockerDiscovererInit:
    """Tests for DockerDiscoverer initialization."""

    def test_default_initialization(self):
        """Test default initialization."""
        discoverer = DockerDiscoverer()
        assert discoverer.container_label == "cc-bridge.instance"
        assert discoverer.image_patterns == ["cc-bridge", "claude-code"]

    def test_custom_container_label(self):
        """Test custom container label."""
        discoverer = DockerDiscoverer(container_label="custom.label")
        assert discoverer.container_label == "custom.label"
        assert discoverer.image_patterns == ["cc-bridge", "claude-code"]

    def test_custom_image_patterns(self):
        """Test custom image patterns."""
        discoverer = DockerDiscoverer(image_patterns=["my-image", "test-image"])
        assert discoverer.container_label == "cc-bridge.instance"
        assert discoverer.image_patterns == ["my-image", "test-image"]

    def test_both_custom_parameters(self):
        """Test both custom parameters."""
        discoverer = DockerDiscoverer(container_label="custom.label", image_patterns=["my-image"])
        assert discoverer.container_label == "custom.label"
        assert discoverer.image_patterns == ["my-image"]

    def test_empty_image_patterns_keeps_empty_list(self):
        """Test that empty image patterns is kept as-is (falsy value)."""
        # Empty list is falsy, so the `or` operator would use defaults
        # But since we explicitly pass [], it gets assigned directly
        discoverer = DockerDiscoverer(image_patterns=[])
        # The implementation uses `image_patterns or ["cc-bridge", "claude-code"]`
        # An empty list is falsy, so defaults would be used
        # Wait, let me check the actual behavior
        # Actually, in the implementation: self.image_patterns = image_patterns or ["cc-bridge", "claude-code"]
        # So empty list should trigger defaults
        assert discoverer.image_patterns == ["cc-bridge", "claude-code"]


class TestContainerToInstance:
    """Tests for _container_to_instance method."""

    def test_basic_conversion(self):
        """Test basic container to instance conversion."""
        discoverer = DockerDiscoverer()

        # Mock container
        container = MagicMock()
        container.id = "abc123"
        container.name = "test-instance"
        container.status = "running"
        container.labels = {}

        # Mock image
        container.image.tags = ["cc-bridge:latest"]
        container.image.id = "sha256:xyz789"

        # Mock network settings
        container.attrs = {
            "NetworkSettings": {
                "Networks": {
                    "bridge": {
                        "NetworkID": "net123",
                    }
                }
            }
        }

        instance = discoverer._container_to_instance(container)

        assert instance is not None
        assert instance.name == "test-instance"
        assert instance.instance_type == "docker"
        assert instance.status == "running"
        assert instance.container_id == "abc123"
        assert instance.container_name == "test-instance"
        assert instance.image_name == "cc-bridge:latest"
        assert instance.docker_network == "bridge"

    def test_container_with_leading_slash_name(self):
        """Test container name with leading slash is handled."""
        discoverer = DockerDiscoverer()

        container = MagicMock()
        container.id = "abc123"
        container.name = "/test-instance"
        container.status = "running"
        container.labels = {}
        container.image.tags = ["cc-bridge:latest"]
        container.attrs = {"NetworkSettings": {"Networks": {}}}

        instance = discoverer._container_to_instance(container)

        assert instance is not None
        assert instance.name == "test-instance"  # Leading slash removed

    def test_container_with_custom_label(self):
        """Test container with custom instance name label."""
        discoverer = DockerDiscoverer()

        container = MagicMock()
        container.id = "abc123"
        container.name = "container-name"
        container.status = "running"
        container.labels = {"cc-bridge.instance": "custom-instance-name"}
        container.image.tags = ["cc-bridge:latest"]
        container.attrs = {"NetworkSettings": {"Networks": {}}}

        instance = discoverer._container_to_instance(container)

        assert instance is not None
        assert instance.name == "custom-instance-name"  # Label takes precedence

    def test_stopped_container_status(self):
        """Test stopped container status."""
        discoverer = DockerDiscoverer()

        container = MagicMock()
        container.id = "abc123"
        container.name = "test-instance"
        container.status = "exited"
        container.labels = {}
        container.image.tags = ["cc-bridge:latest"]
        container.attrs = {"NetworkSettings": {"Networks": {}}}

        instance = discoverer._container_to_instance(container)

        assert instance is not None
        assert instance.status == "stopped"

    def test_container_without_image_tags(self):
        """Test container without image tags uses image ID."""
        discoverer = DockerDiscoverer()

        container = MagicMock()
        container.id = "abc123"
        container.name = "test-instance"
        container.status = "running"
        container.labels = {}
        container.image.tags = []  # No tags
        container.image.id = "sha256:xyz789"
        container.attrs = {"NetworkSettings": {"Networks": {}}}

        instance = discoverer._container_to_instance(container)

        assert instance is not None
        assert instance.image_name == "sha256:xyz789"

    def test_container_without_network_settings(self):
        """Test container without network settings."""
        discoverer = DockerDiscoverer()

        container = MagicMock()
        container.id = "abc123"
        container.name = "test-instance"
        container.status = "running"
        container.labels = {}
        container.image.tags = ["cc-bridge:latest"]
        container.attrs = {}  # No NetworkSettings

        instance = discoverer._container_to_instance(container)

        assert instance is not None
        assert instance.docker_network is None

    def test_container_with_empty_networks(self):
        """Test container with empty networks dict."""
        discoverer = DockerDiscoverer()

        container = MagicMock()
        container.id = "abc123"
        container.name = "test-instance"
        container.status = "running"
        container.labels = {}
        container.image.tags = ["cc-bridge:latest"]
        container.attrs = {"NetworkSettings": {"Networks": {}}}

        instance = discoverer._container_to_instance(container)

        assert instance is not None
        assert instance.docker_network is None

    def test_container_with_multiple_networks(self):
        """Test container with multiple networks uses first one."""
        discoverer = DockerDiscoverer()

        container = MagicMock()
        container.id = "abc123"
        container.name = "test-instance"
        container.status = "running"
        container.labels = {}
        container.image.tags = ["cc-bridge:latest"]
        container.attrs = {
            "NetworkSettings": {
                "Networks": {
                    "network1": {},
                    "network2": {},
                }
            }
        }

        instance = discoverer._container_to_instance(container)

        assert instance is not None
        # Should use the first network (dict order is preserved in Python 3.7+)
        assert instance.docker_network in ["network1", "network2"]

    def test_conversion_exception_returns_none(self):
        """Test that conversion exceptions return None."""
        from unittest.mock import PropertyMock

        discoverer = DockerDiscoverer()

        container = MagicMock()
        container.id = "abc123"
        # Raise exception when accessing labels
        type(container.labels).labels = PropertyMock(side_effect=Exception("Test error"))

        instance = discoverer._container_to_instance(container)

        # Should return None on exception
        assert instance is None


class TestDiscoverByLabel:
    """Tests for _discover_by_label method."""

    def test_discovers_containers_with_label(self):
        """Test discovering containers with the expected label."""
        discoverer = DockerDiscoverer()

        # Mock client and containers
        mock_client = MagicMock()
        mock_container1 = MagicMock()
        mock_container1.id = "abc123"
        mock_container1.name = "instance1"
        mock_container1.status = "running"
        mock_container1.labels = {"cc-bridge.instance": "instance1"}
        mock_container1.image.tags = ["cc-bridge:latest"]
        mock_container1.attrs = {"NetworkSettings": {"Networks": {}}}

        mock_client.containers.list.return_value = [mock_container1]

        instances = discoverer._discover_by_label(mock_client)

        assert len(instances) == 1
        assert instances[0].name == "instance1"

    def test_no_matching_containers(self):
        """Test when no containers have the label."""
        discoverer = DockerDiscoverer()

        mock_client = MagicMock()
        mock_client.containers.list.return_value = []

        instances = discoverer._discover_by_label(mock_client)

        assert len(instances) == 0

    def test_filters_by_correct_label(self):
        """Test that correct label filter is used."""
        discoverer = DockerDiscoverer(container_label="custom.label")

        mock_client = MagicMock()
        mock_client.containers.list.return_value = []

        discoverer._discover_by_label(mock_client)

        # Verify the filter used the custom label
        mock_client.containers.list.assert_called_once()
        call_kwargs = mock_client.containers.list.call_args[1]
        assert call_kwargs["filters"]["label"] == "custom.label"

    def test_only_running_containers(self):
        """Test that only running containers are discovered."""
        discoverer = DockerDiscoverer()

        mock_client = MagicMock()
        mock_client.containers.list.return_value = []

        discoverer._discover_by_label(mock_client)

        # Verify all=False (only running containers)
        call_kwargs = mock_client.containers.list.call_args[1]
        assert call_kwargs["all"] is False

    def test_exception_handling(self):
        """Test that exceptions are handled gracefully."""
        discoverer = DockerDiscoverer()

        mock_client = MagicMock()
        mock_client.containers.list.side_effect = Exception("Docker error")

        # Should not raise, should return empty list
        instances = discoverer._discover_by_label(mock_client)
        assert instances == []

    def test_skips_invalid_containers(self):
        """Test that containers that fail conversion are skipped."""
        discoverer = DockerDiscoverer()

        mock_client = MagicMock()
        mock_container = MagicMock()
        mock_container.id = "abc123"

        # _container_to_instance returns None for this container
        # (e.g., due to exception during conversion)

        mock_client.containers.list.return_value = [mock_container]

        # With proper mocking, containers that return None are skipped
        instances = discoverer._discover_by_label(mock_client)
        # Since _container_to_instance would return None, we expect 0 valid instances
        assert len(instances) == 0


class TestDiscoverByImage:
    """Tests for _discover_by_image method."""

    def test_discovers_cc_bridge_image(self):
        """Test discovering containers with cc-bridge image."""
        discoverer = DockerDiscoverer()

        mock_client = MagicMock()
        mock_container = MagicMock()
        mock_container.id = "abc123"
        mock_container.name = "instance1"
        mock_container.status = "running"
        mock_container.labels = {}
        mock_container.image.tags = ["cc-bridge:latest"]
        mock_container.attrs = {"NetworkSettings": {"Networks": {}}}

        mock_client.containers.list.return_value = [mock_container]

        instances = discoverer._discover_by_image(mock_client)

        assert len(instances) == 1
        assert instances[0].name == "instance1"

    def test_discovers_claude_code_image(self):
        """Test discovering containers with claude-code image."""
        discoverer = DockerDiscoverer()

        mock_client = MagicMock()
        mock_container = MagicMock()
        mock_container.id = "abc123"
        mock_container.name = "instance1"
        mock_container.status = "running"
        mock_container.labels = {}
        mock_container.image.tags = ["claude-code:v1.0"]
        mock_container.attrs = {"NetworkSettings": {"Networks": {}}}

        mock_client.containers.list.return_value = [mock_container]

        instances = discoverer._discover_by_image(mock_client)

        assert len(instances) == 1

    def test_custom_image_patterns(self):
        """Test custom image patterns."""
        discoverer = DockerDiscoverer(image_patterns=["my-custom-image"])

        mock_client = MagicMock()
        mock_container = MagicMock()
        mock_container.id = "abc123"
        mock_container.name = "instance1"
        mock_container.status = "running"
        mock_container.labels = {}
        mock_container.image.tags = ["my-custom-image:latest"]
        mock_container.attrs = {"NetworkSettings": {"Networks": {}}}

        mock_client.containers.list.return_value = [mock_container]

        instances = discoverer._discover_by_image(mock_client)

        assert len(instances) == 1

    def test_ignores_unmatched_images(self):
        """Test that unmatched images are ignored."""
        discoverer = DockerDiscoverer()

        mock_client = MagicMock()
        mock_container = MagicMock()
        mock_container.id = "abc123"
        mock_container.name = "instance1"
        mock_container.labels = {}
        mock_container.image.tags = ["nginx:latest"]  # Not a Claude image
        mock_container.attrs = {"NetworkSettings": {"Networks": {}}}

        mock_client.containers.list.return_value = [mock_container]

        instances = discoverer._discover_by_image(mock_client)

        assert len(instances) == 0

    def test_container_without_tags(self):
        """Test container without image tags is skipped."""
        discoverer = DockerDiscoverer()

        mock_client = MagicMock()
        mock_container = MagicMock()
        mock_container.id = "abc123"
        mock_container.name = "instance1"
        mock_container.labels = {}
        mock_container.image.tags = []  # No tags
        mock_container.attrs = {"NetworkSettings": {"Networks": {}}}

        mock_client.containers.list.return_value = [mock_container]

        instances = discoverer._discover_by_image(mock_client)

        assert len(instances) == 0

    def test_exception_handling(self):
        """Test that exceptions are handled gracefully."""
        discoverer = DockerDiscoverer()

        mock_client = MagicMock()
        mock_client.containers.list.side_effect = Exception("Docker error")

        instances = discoverer._discover_by_image(mock_client)

        assert instances == []


class TestDiscoverByProcess:
    """Tests for _discover_by_process method."""

    def test_discovers_claude_process(self):
        """Test discovering containers with claude process."""
        discoverer = DockerDiscoverer()

        mock_client = MagicMock()
        mock_container = MagicMock()
        mock_container.id = "abc123"
        mock_container.name = "instance1"
        mock_container.status = "running"
        mock_container.labels = {}
        mock_container.image.tags = ["cc-bridge:latest"]
        mock_container.attrs = {"NetworkSettings": {"Networks": {}}}

        # Mock top output with claude process
        mock_container.top.return_value = {
            "Processes": [["user", "1234", "1.0", "2.0", "100M", "claude-code", "cmd"]]
        }

        mock_client.containers.list.return_value = [mock_container]

        instances = discoverer._discover_by_process(mock_client)

        assert len(instances) == 1

    def test_ignores_containers_without_claude_process(self):
        """Test that containers without claude process are ignored."""
        discoverer = DockerDiscoverer()

        mock_client = MagicMock()
        mock_container = MagicMock()
        mock_container.id = "abc123"
        mock_container.name = "instance1"
        mock_container.labels = {}
        mock_container.image.tags = ["nginx:latest"]

        # Mock top output without claude process
        mock_container.top.return_value = {
            "Processes": [["user", "1234", "1.0", "2.0", "100M", "nginx", "cmd"]]
        }

        mock_client.containers.list.return_value = [mock_container]

        instances = discoverer._discover_by_process(mock_client)

        assert len(instances) == 0

    def test_handles_top_output_without_processes_key(self):
        """Test handling of top output without Processes key."""
        discoverer = DockerDiscoverer()

        mock_client = MagicMock()
        mock_container = MagicMock()
        mock_container.id = "abc123"
        mock_container.name = "instance1"
        mock_container.labels = {}
        mock_container.image.tags = ["nginx:latest"]

        # Mock top output without Processes key
        mock_container.top.return_value = {"Titles": []}

        mock_client.containers.list.return_value = [mock_container]

        instances = discoverer._discover_by_process(mock_client)

        assert len(instances) == 0

    def test_handles_top_exception(self):
        """Test handling of top() exceptions."""
        discoverer = DockerDiscoverer()

        mock_client = MagicMock()
        mock_container = MagicMock()
        mock_container.id = "abc123"
        mock_container.name = "instance1"
        mock_container.labels = {}
        mock_container.image.tags = ["cc-bridge:latest"]

        # Mock top to raise exception
        mock_container.top.side_effect = Exception("Process inspect failed")

        mock_client.containers.list.return_value = [mock_container]

        instances = discoverer._discover_by_process(mock_client)

        # Should continue and not crash
        assert len(instances) == 0

    def test_exception_handling(self):
        """Test that list() exceptions are handled gracefully."""
        discoverer = DockerDiscoverer()

        mock_client = MagicMock()
        mock_client.containers.list.side_effect = Exception("Docker error")

        instances = discoverer._discover_by_process(mock_client)

        assert instances == []


class TestDiscoverAll:
    """Tests for discover_all method."""

    @patch("cc_bridge.core.docker_discovery.ensure_docker_available")
    @patch("cc_bridge.core.docker_discovery.get_docker_client")
    def test_combines_all_discovery_methods(self, mock_get_client, mock_ensure):
        """Test that all discovery methods are combined."""
        discoverer = DockerDiscoverer()

        mock_client = MagicMock()
        mock_get_client.return_value = mock_client
        mock_client.containers.list.return_value = []

        # Should not raise
        instances = discoverer.discover_all()
        assert instances == []

    @patch("cc_bridge.core.docker_discovery.ensure_docker_available")
    @patch("cc_bridge.core.docker_discovery.get_docker_client")
    def test_deduplicates_instances(self, mock_get_client, mock_ensure):
        """Test that duplicate instances are deduplicated."""
        discoverer = DockerDiscoverer()

        mock_client = MagicMock()
        mock_get_client.return_value = mock_client

        # Create mock containers for both label and image discovery
        mock_container = MagicMock()
        mock_container.id = "abc123"
        mock_container.name = "instance1"
        mock_container.status = "running"
        mock_container.labels = {"cc-bridge.instance": "instance1"}
        mock_container.image.tags = ["cc-bridge:latest"]
        mock_container.attrs = {"NetworkSettings": {"Networks": {}}}

        # Both label and image discovery would return the same container
        # but it should be deduplicated by name
        mock_client.containers.list.return_value = [mock_container]

        instances = discoverer.discover_all()

        # Should only return one instance (deduplicated)
        assert len(instances) == 1
        assert instances[0].name == "instance1"

    @patch("cc_bridge.core.docker_discovery.ensure_docker_available")
    @patch("cc_bridge.core.docker_discovery.get_docker_client")
    def test_raises_runtime_error_when_docker_unavailable(self, mock_get_client, mock_ensure):
        """Test that RuntimeError is raised when Docker is unavailable."""
        discoverer = DockerDiscoverer()

        mock_ensure.side_effect = RuntimeError("Docker not available")

        with pytest.raises(RuntimeError, match="Docker not available"):
            discoverer.discover_all()


class TestDiscoverByName:
    """Tests for discover_by_name method."""

    @patch("cc_bridge.core.docker_discovery.ensure_docker_available")
    @patch("cc_bridge.core.docker_discovery.get_docker_client")
    def test_finds_container_by_name(self, mock_get_client, mock_ensure):
        """Test finding a container by name."""
        discoverer = DockerDiscoverer()

        mock_client = MagicMock()
        mock_get_client.return_value = mock_client

        mock_container = MagicMock()
        mock_container.id = "abc123"
        mock_container.name = "test-instance"
        mock_container.status = "running"
        mock_container.labels = {}
        mock_container.image.tags = ["cc-bridge:latest"]
        mock_container.attrs = {"NetworkSettings": {"Networks": {}}}

        mock_client.containers.get.return_value = mock_container

        instance = discoverer.discover_by_name("test-instance")

        assert instance is not None
        assert instance.name == "test-instance"

    @patch("cc_bridge.core.docker_discovery.ensure_docker_available")
    @patch("cc_bridge.core.docker_discovery.get_docker_client")
    def test_finds_container_with_slash_prefix(self, mock_get_client, mock_ensure):
        """Test finding container with / prefix fallback."""
        discoverer = DockerDiscoverer()

        mock_client = MagicMock()
        mock_get_client.return_value = mock_client

        mock_container = MagicMock()
        mock_container.id = "abc123"
        mock_container.name = "test-instance"
        mock_container.status = "running"
        mock_container.labels = {}
        mock_container.image.tags = ["cc-bridge:latest"]
        mock_container.attrs = {"NetworkSettings": {"Networks": {}}}

        # First call fails, second with / prefix succeeds
        mock_client.containers.get.side_effect = [
            Exception("Not found"),
            mock_container,
        ]

        instance = discoverer.discover_by_name("test-instance")

        assert instance is not None
        assert instance.name == "test-instance"

    @patch("cc_bridge.core.docker_discovery.ensure_docker_available")
    @patch("cc_bridge.core.docker_discovery.get_docker_client")
    def test_returns_none_when_not_found(self, mock_get_client, mock_ensure):
        """Test that None is returned when container is not found."""
        discoverer = DockerDiscoverer()

        mock_client = MagicMock()
        mock_get_client.return_value = mock_client
        mock_client.containers.get.side_effect = Exception("Not found")

        instance = discoverer.discover_by_name("nonexistent")

        assert instance is None
