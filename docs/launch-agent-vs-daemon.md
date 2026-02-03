# LaunchAgent vs LaunchDaemon: Choosing the Right Approach

cc-bridge can be installed as either a **LaunchAgent** (user-level) or **LaunchDaemon** (system-level). This guide explains the differences and helps you choose the right approach for your needs.

## Quick Comparison

| Feature | LaunchAgent | LaunchDaemon |
|---------|-------------|--------------|
| **Starts at** | User login | System boot |
| **Requires** | User logged in | No login required |
| **Runs as** | Your user | Your user (with UserName key) |
| **Install location** | `~/Library/LaunchAgents/` | `/Library/LaunchDaemons/` |
| **Requires sudo** | No | Yes |
| **Security** | Lower risk | Higher risk (system-level) |
| **Best for** | Personal Mac, laptop | Server, always-on machine |

## LaunchAgent (Default - Recommended for Most Users)

### What It Does
- Starts when you log in to your Mac
- Stops when you log out
- Runs as your user account
- Can access your user configuration files

### Installation
```bash
cd /path/to/cc-bridge
./scripts/install-service.sh
```

### Management
```bash
make agent-start      # Start the service
make agent-stop       # Stop the service
make agent-restart    # Restart the service
```

### When to Use
✅ **Use LaunchAgent if:**
- This is your personal Mac
- You want the service to run only when you're logged in
- You don't want to use `sudo`
- You're developing or testing cc-bridge
- Your Mac restarts infrequently

❌ **Don't use LaunchAgent if:**
- You need the service to run 24/7 without login
- This is a server that boots unattended
- Multiple users need the service

## LaunchDaemon (For Servers/Always-On Machines)

### What It Does
- Starts at system boot (before any user logs in)
- Runs continuously (even when no users are logged in)
- Runs as specified user (via `UserName` key)
- Survives user logouts

### Installation
```bash
cd /path/to/cc-bridge
sudo ./scripts/install-daemon.sh
```

### Management
```bash
make daemon-start      # Start the daemon
make daemon-stop       # Stop the daemon
make daemon-restart    # Restart the daemon
```

Or directly with launchctl:
```bash
sudo launchctl start com.cc-bridge.daemon
sudo launchctl stop com.cc-bridge.daemon
sudo launchctl kickstart -k com.cc-bridge.daemon
```

### When to Use
✅ **Use LaunchDaemon if:**
- This is a Mac mini or Mac server that runs 24/7
- You need the service to start at boot without login
- The Mac is headless (no monitor/keyboard)
- You need the service to survive user logouts
- Multiple users need access to the service

❌ **Don't use LaunchDaemon if:**
- This is a personal laptop
- You're not comfortable with `sudo`
- You don't need the service to run at boot

## Migration Guide

### Switching from LaunchAgent to LaunchDaemon

1. **Stop and uninstall the LaunchAgent:**
   ```bash
   make agent-stop
   ./scripts/uninstall-service.sh
   ```

2. **Install the LaunchDaemon:**
   ```bash
   sudo ./scripts/install-daemon.sh
   ```

3. **Verify it's running:**
   ```bash
   curl http://localhost:8080/health
   ```

### Switching from LaunchDaemon to LaunchAgent

1. **Stop and uninstall the LaunchDaemon:**
   ```bash
   sudo make daemon-stop
   sudo ./scripts/uninstall-daemon.sh
   ```

2. **Install the LaunchAgent:**
   ```bash
   ./scripts/install-service.sh
   ```

3. **Verify it's running:**
   ```bash
   curl http://localhost:8080/health
   ```

## Troubleshooting

### LaunchAgent Issues

**Service not starting after login:**
```bash
# Check if service is loaded
launchctl list | grep cc-bridge

# Check logs
tail -f /opt/homebrew/var/log/cc-bridge/server.log

# Try starting manually
launchctl start homebrew.mxcl.cc-bridge
```

**Service stops when you log out:**
- This is normal behavior for LaunchAgents
- Use LaunchDaemon if you need it to stay running

### LaunchDaemon Issues

**Service not starting at boot:**
```bash
# Check if daemon is loaded
sudo launchctl list | grep cc-bridge

# Check logs
tail -f /opt/homebrew/var/log/cc-bridge/server.log

# Check plist syntax
sudo plutil -lint /Library/LaunchDaemons/com.cc-bridge.daemon.plist
```

**Permission errors:**
```bash
# Ensure plist has correct permissions
sudo chmod 644 /Library/LaunchDaemons/com.cc-bridge.daemon.plist

# Ensure executable is accessible
ls -la /Users/robin/xprojects/cc-bridge/.venv/bin/cc-bridge
```

**Wrong user running the service:**
```bash
# Check what user is running the service
ps aux | grep cc-bridge

# Update plist with correct username
sudo plutil -replace UserName "yourusername" /Library/LaunchDaemons/com.cc-bridge.daemon.plist
sudo launchctl unload /Library/LaunchDaemons/com.cc-bridge.daemon.plist
sudo launchctl load /Library/LaunchDaemons/com.cc-bridge.daemon.plist
```

## Security Considerations

### LaunchAgent
- ✅ Lower security risk (runs as your user)
- ✅ Can't affect system files or other users
- ✅ No sudo required for installation
- ❌ Requires user login

### LaunchDaemon
- ⚠️ Higher security risk (system-level)
- ⚠️ Mistakes can affect system stability
- ⚠️ Requires sudo for installation/management
- ✅ Starts at boot without login
- ✅ Survives user logouts

## Recommendation

**For most users:** Use the **LaunchAgent** (default). It's simpler, safer, and sufficient for personal Macs.

**For servers:** Use the **LaunchDaemon** if you have a Mac mini/server that needs to run 24/7 without requiring a user to be logged in.

## Files

| File | Purpose |
|------|---------|
| `contrib/homebrew.mxcl.cc-bridge.plist` | LaunchAgent configuration |
| `contrib/com.cc-bridge.daemon.plist` | LaunchDaemon configuration |
| `scripts/install-service.sh` | LaunchAgent installer |
| `scripts/uninstall-service.sh` | LaunchAgent uninstaller |
| `scripts/install-daemon.sh` | LaunchDaemon installer |
| `scripts/uninstall-daemon.sh` | LaunchDaemon uninstaller |

## References

- [Apple Developer: Creating Launch Daemons and Agents](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
- [launchd.plist(5) Manual Page](https://www.manpagez.com/man/5/launchd.plist/)
- [Difference between LaunchAgents and LaunchDaemons](https://apple.stackexchange.com/questions/283950/what-is-the-difference-between-launchagents-and-launchdaemons)
