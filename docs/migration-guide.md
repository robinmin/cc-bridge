# Migration Guide: Exec Mode to FIFO Mode

This guide helps you migrate from legacy exec mode to the new FIFO daemon mode.

## Why Migrate?

### Exec Mode (Legacy)
- ❌ Spawns new process for each command
- ❌ Higher latency (process overhead)
- ❌ No session persistence
- ❌ Limited health monitoring

### FIFO Mode (Daemon)
- ✅ Single persistent process
- ✅ Lower latency and overhead
- ✅ Session tracking and persistence
- ✅ Built-in health monitoring and recovery
- ✅ Better resource utilization

## Pre-Migration Checklist

- [ ] Back up your current configuration
- [ ] Ensure Docker daemon is running
- [ ] Verify you have write access to `/tmp/cc-bridge/pipes` (or custom pipe_dir)
- [ ] Check that `mkfifo` command is available on your system
- [ ] Stop any running cc-bridge instances

## Migration Steps

### Step 1: Update Configuration

Edit `~/.config/cc-bridge/config.yaml`:

```yaml
docker:
  # Change from "exec" to "fifo"
  communication_mode: fifo

  # Add pipe directory configuration
  pipe_dir: /tmp/cc-bridge/pipes

  # Optional: Configure session tracking
  session:
    idle_timeout: 300  # 5 minutes
    request_timeout: 120  # 2 minutes
    max_history: 100

  # Optional: Configure health monitoring
  health:
    enabled: true
    check_interval: 30  # seconds
    max_consecutive_failures: 3
    recovery_delay: 5  # seconds
```

### Step 2: Create Pipe Directory

```bash
# Create pipe directory with proper permissions
sudo mkdir -p /tmp/cc-bridge/pipes
sudo chmod 1777 /tmp/cc-bridge/pipes

# Or use a custom directory without sudo
mkdir -p ~/.local/share/cc-bridge/pipes
```

Then update your config:

```yaml
docker:
  pipe_dir: ~/.local/share/cc-bridge/pipes
```

### Step 3: Restart cc-bridge

```bash
# Stop cc-bridge
cc-bridge stop
brew services stop cc-bridge

# Start cc-bridge
brew services start cc-bridge
cc-bridge start
```

### Step 4: Recreate Instances

```bash
# Remove existing instances (this won't delete containers)
cc-bridge docker remove <instance_name>

# Re-add with FIFO mode
cc-bridge docker add <instance_name> --mode fifo --container-id <container_id>
```

Or if using auto-discovery:

```bash
# Re-discover instances
cc-bridge docker discover --mode fifo
```

### Step 5: Verify Migration

```bash
# Check instance status
cc-bridge docker list

# Verify FIFO mode is active
cc-bridge docker status <instance_name>
# Should show "communication_mode: fifo"

# Run health checks
cc-bridge health
```

## Rollback

If you encounter issues, you can roll back to exec mode:

### Step 1: Update Configuration

```yaml
docker:
  communication_mode: exec  # Change back to exec
```

### Step 2: Restart and Recreate

```bash
cc-bridge stop
cc-bridge docker remove <instance_name>
cc-bridge docker add <instance_name> --mode exec --container-id <container_id>
cc-bridge start
```

## Common Issues

### Issue: Permission Denied on Pipe Directory

**Solution**:
```bash
# Fix permissions
sudo chmod 1777 /tmp/cc-bridge/pipes

# Or use a user-writable location
mkdir -p ~/.local/share/cc-bridge/pipes
# Update config.yaml with new pipe_dir
```

### Issue: FIFO Pipes Not Created

**Solution**:
```bash
# Check if mkfifo is available
which mkfifo

# Manually create pipes to test
mkfifo /tmp/test.fifo
ls -l /tmp/test.fifo  # Should show 'p' for pipe
rm /tmp/test.fifo
```

### Issue: Container Agent Not Starting

**Solution**:
```bash
# Check container logs
docker logs <container_id>

# Verify container has Python
docker exec <container_id> which python3

# Check if container_agent.py is accessible
docker exec <container_id> ls -la /app/container_agent.py
```

### Issue: Health Check Failures

**Solution**:
```bash
# Run detailed health check
cc-bridge health

# Check specific component
cc-bridge health --component docker_daemon
cc-bridge health --component fifo_pipes

# View health monitor logs
tail -f ~/Library/Logs/cc-bridge/daemon.log
```

## Post-Migration Verification

After migration, verify:

1. **Basic Functionality**:
   ```bash
   cc-bridge claude-list
   cc-bridge claude-attach <instance_name>
   ```

2. **Session Persistence**:
   - Send multiple commands
   - Verify conversation history is maintained

3. **Health Monitoring**:
   ```bash
   # Wait for health check interval (default 30s)
   sleep 35
   cc-bridge health
   ```

4. **Resource Usage**:
   ```bash
   # Check Docker processes
   docker ps

   # Check pipe files
   ls -la /tmp/cc-bridge/pipes/*.fifo
   ```

## Advanced Configuration

### Custom Pipe Directory

```yaml
docker:
  pipe_dir: /var/run/cc-bridge/pipes
```

Don't forget to create the directory and set permissions:
```bash
sudo mkdir -p /var/run/cc-bridge/pipes
sudo chmod 1777 /var/run/cc-bridge/pipes
```

### Adjusted Timeouts

```yaml
docker:
  session:
    idle_timeout: 600  # 10 minutes
    request_timeout: 300  # 5 minutes
```

### Aggressive Health Monitoring

```yaml
docker:
  health:
    enabled: true
    check_interval: 10  # Check every 10 seconds
    max_consecutive_failures: 2  # Trigger recovery after 2 failures
    recovery_delay: 2  # Wait 2 seconds before recovery attempt
```

## Support

For issues or questions:
- Check logs: `tail -f ~/Library/Logs/cc-bridge/daemon.log`
- Run health checks: `cc-bridge health`
- Review documentation: `docs/fifo-mode.md`
