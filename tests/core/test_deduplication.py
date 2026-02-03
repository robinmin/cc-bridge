import pytest
from cc_bridge.core.webhook.handlers import ProcessedUpdateTracker


@pytest.mark.asyncio
async def test_update_deduplication():
    tracker = ProcessedUpdateTracker(max_size=5)

    # First time processing
    assert await tracker.is_processed(100) is False

    # Second time processing (duplicate)
    assert await tracker.is_processed(100) is True

    # Different ID
    assert await tracker.is_processed(101) is False

    # Wait for cleanup (simulated by small window if we could, but here we just test max_size)
    await tracker.is_processed(102)
    await tracker.is_processed(103)
    await tracker.is_processed(104)
    # 100, 101, 102, 103, 104 are in (5 items)

    assert await tracker.is_processed(105) is False
    # 105 added, 100 should be removed (oldest)

    # This might depend on dict ordering, but usually min(key) or first inserted
    # In our implementation: del self._processed[oldest_uid] where oldest_uid = min(self._processed, key=lambda k: self._processed[k])
    # 100 was the earliest timestamp.

    # If we check 100 again, it should be False (not in tracker anymore)
    assert await tracker.is_processed(100) is False
