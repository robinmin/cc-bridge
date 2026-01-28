# Rate Limiting Configuration

## Overview

The Claude Code Telegram bridge includes rate limiting to prevent abuse and comply with Telegram API limits. The implementation uses the **token bucket algorithm** for fair rate limiting.

## Features

- **Token bucket algorithm** - Fair rate limiting with burst capacity
- **Per-user limits** - Separate rate limits per chat_id
- **Configurable limits** - Adjust rates via environment variables
- **Graceful handling** - Returns error message when limit exceeded

## Configuration

Rate limiting is controlled via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `RATE_LIMIT_ENABLED` | `true` | Enable/disable rate limiting |
| `MESSAGES_PER_MINUTE` | `20` | Sustained message rate |
| `BURST_CAPACITY` | `20` | Burst message capacity |

## Examples

### Enable Rate Limiting (Default)

```bash
export RATE_LIMIT_ENABLED="true"
export MESSAGES_PER_MINUTE="20"
export BURST_CAPACITY="20"
```

### Disable Rate Limiting

```bash
export RATE_LIMIT_ENABLED="false"
```

### Custom Rate Limits

```bash
# 30 messages per minute, burst capacity of 10
export MESSAGES_PER_MINUTE="30"
export BURST_CAPACITY="10"
```

## Token Bucket Algorithm

The token bucket algorithm allows:
- **Burst capacity**: Send up to `BURST_CAPACITY` messages immediately
- **Sustained rate**: After burst, refill at `MESSAGES_PER_MINUTE` rate
- **Fairness**: Each user/chat has independent bucket

### Example

With `MESSAGES_PER_MINUTE=20` and `BURST_CAPACITY=20`:

```
Time 0s:  Send 20 messages (burst)
Time 1s:  0 tokens remaining (must wait)
Time 3s:  1 token available (20/60 = 0.33 tokens/sec)
Time 60s: 20 tokens available (full refill)
```

## API Usage

### Check Rate Limit Status

```python
from claudecode_telegram import get_rate_limit_status

status = get_rate_limit_status("123456")
print(f"Tokens: {status['tokens']}/{status['capacity']}")
print(f"Retry after: {status['retry_after']}s")
```

### Reset Rate Limit

```python
from claudecode_telegram import reset_rate_limit

reset_rate_limit("123456")  # Reset for specific chat
```

### Custom Rate Limiter

```python
from claudecode_telegram import RateLimiter

# Create custom limiter: 10 messages/min, burst of 5
limiter = RateLimiter(rate=10.0/60.0, capacity=5, enabled=True)

result = limiter.consume("chat_id")
if result:
    print(f"Rate limited, retry after {result.retry_after}s")
```

## Integration with Telegram API

Rate limiting is automatically applied to `send_message()` calls:

```python
from claudecode_telegram import send_message

# Automatic rate limiting
for i in range(25):
    success = send_message("123456", f"Message {i}")
    if not success:
        print("Rate limit exceeded, message not sent")
```

## Best Practices

1. **Monitor rate limits** - Check status before sending important messages
2. **Handle failures** - Implement retry logic with exponential backoff
3. **Adjust capacity** - Balance burst capacity vs sustained rate
4. **Test limits** - Verify rate limiting works in development

## Troubleshooting

### Messages Not Sending

Check rate limit status:
```bash
# Set RATE_LIMIT_ENABLED to see rate limit messages
export RATE_LIMIT_ENABLED="true"
```

### Adjusting Limits

If hitting limits too frequently:
```bash
# Increase burst capacity
export BURST_CAPACITY="30"

# Or increase sustained rate
export MESSAGES_PER_MINUTE="30"
```

### Disabling for Testing

```bash
export RATE_LIMIT_ENABLED="false"
```

**Warning**: Disabling rate limiting may cause Telegram API errors or bans.

## Technical Details

### Algorithm

Token bucket refill formula:
```
tokens = min(capacity, tokens + elapsed_time * rate)
```

Where:
- `elapsed_time` = time since last update
- `rate` = tokens per second (MESSAGES_PER_MINUTE / 60)
- `capacity` = BURST_CAPACITY

### Per-User Buckets

Each chat_id gets independent token bucket:
```python
limiter._buckets = {
    "chat_id_1": TokenBucket(...),
    "chat_id_2": TokenBucket(...),
    ...
}
```

### Memory Management

Old buckets can be reset:
```python
limiter.reset_user("chat_id")  # Reset specific user
limiter.reset_all()            # Reset all users
```

## References

- [Token Bucket Algorithm](https://en.wikipedia.org/wiki/Token_bucket)
- [Telegram Bot API Rate Limits](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this)
- [HTTP 429 Too Many Requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/429)
