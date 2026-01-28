# Rate Limiting Quick Reference

## Quick Start

### 1. Basic Usage

```python
from claudecode_telegram import RateLimiter

# Create limiter (20 msg/min, burst 20)
limiter = RateLimiter(rate=20.0/60.0, capacity=20, enabled=True)

# Check rate limit
result = limiter.consume("chat_id_123")
if result:
    print(f"Rate limited! Retry after {result.retry_after:.1f}s")
else:
    print("Allowed!")
```

### 2. Environment Configuration

```bash
# Enable rate limiting (default: true)
export RATE_LIMIT_ENABLED=true

# Set rate (default: 20)
export MESSAGES_PER_MINUTE=20

# Set burst capacity (default: 20)
export BURST_CAPACITY=20

# Disable rate limiting
export RATE_LIMIT_ENABLED=false
```

### 3. Telegram API Integration

```python
from claudecode_telegram import send_message, get_rate_limit_status

# Automatic rate limiting
success = send_message("123456", "Hello!")
if not success:
    print("Rate limited or failed")

# Check status
status = get_rate_limit_status("123456")
print(f"Tokens: {status['tokens']}/{status['capacity']}")
```

## Common Patterns

### Pattern 1: Decorator for Functions

```python
from claudecode_telegram import rate_limit, RateLimiter

limiter = RateLimiter(rate=1.0, capacity=10, enabled=True)

def get_user_id(args, kwargs):
    return kwargs.get('chat_id', args[0] if args else 'default')

@rate_limit(limiter, get_user_id)
def send_notification(chat_id, message):
    # Your send logic here
    pass
```

### Pattern 2: Handle Rate Limit Errors

```python
from claudecode_telegram import RateLimiter, RateLimitExceeded

limiter = RateLimiter(rate=1.0, capacity=5, enabled=True)

try:
    result = limiter.consume("chat_id")
    if result:
        # Rate limit exceeded
        print(f"Retry after {result.retry_after:.1f}s")
        # Implement backoff/retry logic
    else:
        # Send message
        pass
except Exception as e:
    print(f"Error: {e}")
```

### Pattern 3: Check Status Before Sending

```python
from claudecode_telegram import get_rate_limit_status

status = get_rate_limit_status("123456")
if status['tokens'] >= 1:
    # Safe to send
    send_message("123456", "Hello")
else:
    print(f"Wait {status['retry_after']:.1f}s")
```

### Pattern 4: Reset Rate Limits

```python
from claudecode_telegram import reset_rate_limit

# Reset specific user
reset_rate_limit("123456")

# Reset all users (via limiter)
limiter.reset_all()
```

## Configuration Examples

### High Burst, Low Sustained

```bash
# Burst 50 messages, then 5/minute
export MESSAGES_PER_MINUTE=5
export BURST_CAPACITY=50
```

### Low Burst, High Sustained

```bash
# Burst 5 messages, then 60/minute
export MESSAGES_PER_MINUTE=60
export BURST_CAPACITY=5
```

### Disable for Testing

```bash
export RATE_LIMIT_ENABLED=false
```

## Troubleshooting

### Problem: Messages Not Sending

**Check rate limit status:**
```python
status = get_rate_limit_status("123456")
print(f"Tokens: {status['tokens']}, Retry: {status['retry_after']}s")
```

### Problem: Too Many Rate Limits

**Increase limits:**
```bash
export MESSAGES_PER_MINUTE=30
export BURST_CAPACITY=30
```

### Problem: Need to Bypass for Admin

```python
# Create separate limiter for admin
admin_limiter = RateLimiter(rate=1000, capacity=1000, enabled=False)

if user_is_admin:
    admin_limiter.consume(chat_id)
else:
    regular_limiter.consume(chat_id)
```

## API Reference

### RateLimiter Class

```python
class RateLimiter:
    def __init__(self, rate: float, capacity: int, enabled: bool = True)
    def consume(self, user_id: str, tokens: int = 1) -> Optional[RateLimitExceeded]
    def get_status(self, user_id: str) -> Dict[str, float]
    def reset_user(self, user_id: str) -> None
    def reset_all(self) -> None
```

### TokenBucket Class

```python
class TokenBucket:
    def __init__(self, rate: float, capacity: int)
    def consume(self, tokens: int = 1) -> bool
    def get_retry_after(self) -> float
    def get_status(self) -> Dict[str, float]
```

### RateLimitExceeded Class

```python
@dataclass
class RateLimitExceeded:
    retry_after: float  # Seconds until next token
    limit: int          # Capacity limit
    remaining: int      # Remaining tokens (0)
```

### Functions

```python
def send_message(chat_id: str, text: str, ...) -> bool
def get_rate_limiter() -> RateLimiter
def get_rate_limit_status(chat_id: str) -> dict
def reset_rate_limit(chat_id: str) -> None
def rate_limit(limiter, get_user_id, on_limit=None) -> decorator
```

## Testing

### Unit Test Example

```python
import pytest
from claudecode_telegram import RateLimiter

def test_rate_limit():
    limiter = RateLimiter(rate=1.0, capacity=5, enabled=True)

    # Burst 5 messages
    for _ in range(5):
        assert limiter.consume("user") is None

    # 6th message rate limited
    result = limiter.consume("user")
    assert result is not None
    assert result.remaining == 0
```

### Manual Test Example

```python
from claudecode_telegram import RateLimiter
import time

limiter = RateLimiter(rate=10.0/60.0, capacity=10, enabled=True)

# Send burst
for i in range(10):
    result = limiter.consume("test")
    print(f"Message {i+1}: {'OK' if result is None else 'Limited'}")

# Wait and retry
time.sleep(6)
result = limiter.consume("test")
print(f"After 6s: {'OK' if result is None else 'Limited'}")
```

## Best Practices

1. **Monitor Limits** - Check status before important messages
2. **Handle Failures** - Implement retry with exponential backoff
3. **Adjust Capacity** - Balance burst vs sustained rate
4. **Test First** - Verify limits in development
5. **Document Limits** - Communicate limits to users

## Performance Tips

- **Memory** - Each user ~100 bytes, reset old users
- **CPU** - O(1) operations, minimal overhead
- **Concurrency** - Not thread-safe, use locks if needed
- **Cleanup** - Call `reset_user()` for inactive users

## Environment Variables Reference

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `RATE_LIMIT_ENABLED` | bool | true | Enable/disable rate limiting |
| `MESSAGES_PER_MINUTE` | int | 20 | Sustained message rate |
| `BURST_CAPACITY` | int | 20 | Burst message capacity |
| `TELEGRAM_BOT_TOKEN` | str | required | Bot token for API |

## See Also

- [Full Documentation](./rate_limiting.md)
- [Verification Report](./rate_limiting_verification.md)
- [Demo Script](../examples/rate_limit_demo.py)
- [Task Completion Report](./task_0016_completion.md)
