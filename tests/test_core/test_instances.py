"""
Tests for Claude instance management.
"""

# ruff: noqa: PLC0415 (intentional lazy imports in tests)
from pathlib import Path

import pytest

from cc_bridge.core.instances import InstanceManager, get_instance_manager


@pytest.fixture
def test_instances_file(tmp_path: Path):
    """Create temporary instances file."""
    instances_file = tmp_path / "instances.json"
    return instances_file


@pytest.fixture
def instance_manager(test_instances_file):
    """Create instance manager for testing."""
    return InstanceManager(instances_file=str(test_instances_file))


class TestInstanceManager:
    """Test InstanceManager class."""

    @pytest.mark.asyncio
    async def test_create_instance(self, instance_manager):
        """Should create instance with metadata."""
        instance = await instance_manager.create_instance(
            name="test", tmux_session="claude-test", cwd="/home/user/project"
        )

        assert instance.name == "test"
        assert instance.tmux_session == "claude-test"
        assert instance.cwd == "/home/user/project"
        assert instance.status == "created"

    @pytest.mark.asyncio
    async def test_get_instance(self, instance_manager):
        """Should retrieve instance by name."""
        await instance_manager.create_instance(name="test", tmux_session="claude-test")

        instance = instance_manager.get_instance("test")
        assert instance is not None
        assert instance.name == "test"

    def test_get_nonexistent_instance(self, instance_manager):
        """Should return None for non-existent instance."""
        instance = instance_manager.get_instance("nonexistent")
        assert instance is None

    @pytest.mark.asyncio
    async def test_list_instances(self, instance_manager):
        """Should list all instances."""
        await instance_manager.create_instance(name="test1", tmux_session="claude-test1")
        await instance_manager.create_instance(name="test2", tmux_session="claude-test2")

        instances = instance_manager.list_instances()
        assert len(instances) == 2
        assert {i.name for i in instances} == {"test1", "test2"}

    @pytest.mark.asyncio
    async def test_update_instance(self, instance_manager):
        """Should update instance attributes."""
        await instance_manager.create_instance(name="test", tmux_session="claude-test")

        updated = await instance_manager.update_instance("test", pid=12345, status="running")
        assert updated.pid == 12345
        assert updated.status == "running"

    @pytest.mark.asyncio
    async def test_delete_instance(self, instance_manager):
        """Should delete instance."""
        await instance_manager.create_instance(name="test", tmux_session="claude-test")

        result = await instance_manager.delete_instance("test")
        assert result is True

        # Verify it's gone
        assert instance_manager.get_instance("test") is None

    @pytest.mark.asyncio
    async def test_delete_nonexistent_instance(self, instance_manager):
        """Should return False when deleting non-existent instance."""
        result = await instance_manager.delete_instance("nonexistent")
        assert result is False

    @pytest.mark.asyncio
    async def test_get_instance_status_no_pid(self, instance_manager):
        """Should return 'no_pid' for instance without PID."""
        await instance_manager.create_instance(name="test", tmux_session="claude-test")

        status = await instance_manager.aget_instance_status("test")
        assert status == "no_pid"

    @pytest.mark.asyncio
    async def test_save_and_load_instances(self, test_instances_file):
        """Should persist instances to file and reload."""
        manager1 = InstanceManager(instances_file=str(test_instances_file))

        await manager1.create_instance(name="persisted", tmux_session="claude-persisted")

        # Force save
        manager1._save()

        # Create new manager to test loading
        manager2 = InstanceManager(instances_file=str(test_instances_file))

        instance = manager2.get_instance("persisted")
        assert instance is not None
        assert instance.name == "persisted"


class TestGetInstanceManager:
    """Test global instance manager singleton."""

    def test_get_instance_manager_returns_singleton(self):
        """Should return same instance on multiple calls."""
        # Reset global state
        import cc_bridge.core.instances as instances_module

        instances_module._instance_manager = None

        manager1 = get_instance_manager()
        manager2 = get_instance_manager()

        assert manager1 is manager2

    def test_get_instance_manager_creates_if_none(self):
        """Should create manager if none exists."""
        # Reset global state
        import cc_bridge.core.instances as instances_module

        instances_module._instance_manager = None

        manager = get_instance_manager()
        assert manager is not None
        assert isinstance(manager, InstanceManager)
