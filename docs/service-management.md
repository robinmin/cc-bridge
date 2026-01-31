# cc-bridge Service Management

This guide explains how to manage the cc-bridge server as a launchd service on macOS, allowing it to start automatically and restart automatically if it crashes.

## Overview

The cc-bridge service runs the FastAPI webhook server that receives Telegram messages and forwards them to Claude Code instances. Running it as a service provides:

- **Automatic startup** - The service starts automatically (at boot or login)
- **Automatic restart on crash** - If the server crashes, launchd automatically restarts it
- **Standardized logging** - Logs are stored in Homebrew's standard log location
- **Easy management** - Use Make targets or launchctl commands to manage the service

## Choose Your Installation Type

cc-bridge can be installed in two ways:

| Type | Starts | Requires Login | Requires Sudo | Best For |
|------|--------|----------------|--------------|----------|
| **LaunchAgent** (default) | User login | Yes | No | Personal Macs, laptops |
| **LaunchDaemon** | System boot | No | Yes | Servers, always-on machines |

**📖 See [launch-agent-vs-daemon.md](launch-agent-vs-daemon.md) for detailed comparison.**

## Prerequisites

Before installing the service, ensure you have:

1. **Homebrew installed**
   ```bash
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   ```

2. **cc-bridge installed**
   ```bash
   cd /path/to/cc-bridge
   pip install -e .
   ```

3. **macOS with launchd support** (all modern macOS versions)

## Installation

### Quick Install

Run the installation script:

```bash
cd /path/to/cc-bridge
./scripts/install-service.sh
```

This script will:
- Check that Homebrew and cc-bridge are installed
- Create the log directory (`/opt/homebrew/var/log/cc-bridge/`)
- Validate and install the plist file
- Load and start the service
- Verify the service is running

### Manual Install

If you prefer to install manually:

1. **Create log directory**
   ```bash
   sudo mkdir -p /opt/homebrew/var/log/cc-bridge
   sudo chown $(whoami):admin /opt/homebrew/var/log/cc-bridge
   ```

2. **Install plist file**
   ```bash
   cp contrib/homebrew.mxcl.cc-bridge.plist ~/Library/LaunchAgents/
   ```

3. **Load the service**
   ```bash
   launchctl load ~/Library/LaunchAgents/homebrew.mxcl.cc-bridge.plist
   ```

4. **Start the service**
   ```bash
   launchctl start homebrew.mxcl.cc-bridge
   ```

## Service Management

### Check Service Status

View the service status:

```bash
# Check if service is loaded
launchctl list | grep cc-bridge

# Check if process is running
pgrep -f "cc-bridge server"

# Check health endpoint
curl http://localhost:8080/health
```

### Start/Stop/Restart

**Using Make targets (recommended):**

```bash
# Start the service
make start

# Stop the service
make stop

# Restart the service
make restart
```

**Using launchctl directly:**

```bash
# Start the service
launchctl start homebrew.mxcl.cc-bridge

# Stop the service
launchctl stop homebrew.mxcl.cc-bridge

# Restart the service (kickstart)
launchctl kickstart -k gui/$(id -u)/homebrew.mxcl.cc-bridge

# Reload the service (after plist changes)
launchctl unload ~/Library/LaunchAgents/homebrew.mxcl.cc-bridge.plist
launchctl load ~/Library/LaunchAgents/homebrew.mxcl.cc-bridge.plist
```

### About Homebrew Services

**Note**: This service does not appear in `brew services list` because it uses launchd directly. This is intentional and provides the following benefits:

- No need to create a brew formula
- Works with virtual environments
- Simpler installation and management
- Standard macOS approach for custom services

If you need brew services integration, you would need to create a brew formula, which is more complex and not necessary for this use case. The launchd approach provides all the same functionality (auto-start, crash recovery, logging) with simpler management.

## Logging

### Log Locations

Service logs are stored in:

```
/opt/homebrew/var/log/cc-bridge/
├── server.log         # Standard output
└── server.error.log   # Standard error
```

### View Logs

```bash
# Follow logs in real-time
tail -f /opt/homebrew/var/log/cc-bridge/server.log

# View error logs
tail -f /opt/homebrew/var/log/cc-bridge/server.error.log

# View last 50 lines
tail -n 50 /opt/homebrew/var/log/cc-bridge/server.log

# Search logs for errors
grep -i error /opt/homebrew/var/log/cc-bridge/server.log
```

### Using macOS Log Utility

You can also view logs using macOS's built-in log utility:

```bash
# View unified log stream (filtered for cc-bridge)
log stream --predicate 'process == "cc-bridge"' --level info

# Search past logs
log show --predicate 'process == "cc-bridge"' --last 1h
```

## Troubleshooting

### Service Not Starting

**Problem**: Service fails to start or crashes immediately.

**Solutions**:

1. **Check error logs**
   ```bash
   tail -f /opt/homebrew/var/log/cc-bridge/server.error.log
   ```

2. **Verify cc-bridge installation**
   ```bash
   which cc-bridge
   cc-bridge --version
   ```

3. **Check plist syntax**
   ```bash
   plutil -lint ~/Library/LaunchAgents/homebrew.mxcl.cc-bridge.plist
   ```

4. **Test server manually**
   ```bash
   cc-bridge server --host 0.0.0.0 --port 8080
   ```

5. **Check port availability**
   ```bash
   lsof -i :8080
   ```

### Service Not Starting on Boot

**Problem**: Service doesn't start automatically after system reboot.

**Solutions**:

1. **Verify plist is in LaunchAgents**
   ```bash
   ls -la ~/Library/LaunchAgents/homebrew.mxcl.cc-bridge.plist
   ```

2. **Check RunAtLoad is set to true**
   ```bash
   plutil -p ~/Library/LaunchAgents/homebrew.mxcl.cc-bridge.plist | grep RunAtLoad
   ```

3. **Reload the service**
   ```bash
   launchctl unload ~/Library/LaunchAgents/homebrew.mxcl.cc-bridge.plist
   launchctl load ~/Library/LaunchAgents/homebrew.mxcl.cc-bridge.plist
   ```

### Service Crashing Repeatedly

**Problem**: Service keeps restarting (crash loop).

**Solutions**:

1. **Check logs for root cause**
   ```bash
   tail -100 /opt/homebrew/var/log/cc-bridge/server.error.log
   ```

2. **Common issues**:
   - **Port already in use**: Another process is using port 8080
   - **Configuration error**: Invalid config in `~/.config/cc-bridge/config.toml`
   - **Missing dependencies**: Python packages not installed
   - **Permission issues**: Log directory not writable

3. **Test manually to see errors**
   ```bash
   cc-bridge server --host 0.0.0.0 --port 8080
   ```

### Logs Not Appearing

**Problem**: Log files are empty or not being created.

**Solutions**:

1. **Verify log directory exists and is writable**
   ```bash
   ls -la /opt/homebrew/var/log/cc-bridge/
   ```

2. **Check plist log paths**
   ```bash
   plutil -p ~/Library/LaunchAgents/homebrew.mxcl.cc-bridge.plist | grep -A 2 StandardOutPath
   ```

3. **Create log directory if missing**
   ```bash
   sudo mkdir -p /opt/homebrew/var/log/cc-bridge
   sudo chown $(whoami):admin /opt/homebrew/var/log/cc-bridge
   ```

## Configuration

### Service Configuration

The service behavior is controlled by the plist file at:

```
~/Library/LaunchAgents/homebrew.mxcl.cc-bridge.plist
```

Key configuration options:

| Key | Value | Description |
|-----|-------|-------------|
| `Label` | `homebrew.mxcl.cc-bridge` | Service identifier |
| `ProgramArguments` | `["cc-bridge", "server", ...]` | Command to run |
| `RunAtLoad` | `true` | Start immediately on load |
| `KeepAlive` | `{"Crashed": true}` | Restart on crash |
| `StandardOutPath` | `/opt/homebrew/var/log/cc-bridge/server.log` | Stdout log |
| `StandardErrorPath` | `/opt/homebrew/var/log/cc-bridge/server.error.log` | Stderr log |

### Changing Server Port

To change the server port from the default 8080:

1. **Edit the plist file**
   ```bash
   nano ~/Library/LaunchAgents/homebrew.mxcl.cc-bridge.plist
   ```

2. **Update the ProgramArguments array** (change port number):
   ```xml
   <key>ProgramArguments</key>
   <array>
       <string>/opt/homebrew/bin/cc-bridge</string>
       <string>server</string>
       <string>--host</string>
       <string>0.0.0.0</string>
       <string>--port</string>
       <string>9090</string>  <!-- New port -->
   </array>
   ```

3. **Reload the service**
   ```bash
   launchctl unload ~/Library/LaunchAgents/homebrew.mxcl.cc-bridge.plist
   launchctl load ~/Library/LaunchAgents/homebrew.mxcl.cc-bridge.plist
   launchctl start homebrew.mxcl.cc-bridge
   ```

### Environment Variables

To add environment variables (e.g., for proxy settings, custom paths):

1. **Edit the plist file**
2. **Add to the EnvironmentVariables dictionary**:
   ```xml
   <key>EnvironmentVariables</key>
   <dict>
       <key>HTTP_PROXY</key>
       <string>http://proxy.example.com:8080</string>
       <key>HTTPS_PROXY</key>
       <string>http://proxy.example.com:8080</string>
   </dict>
   ```
3. **Reload the service**

## Uninstallation

### Quick Uninstall

Run the uninstallation script:

```bash
cd /path/to/cc-bridge
./scripts/uninstall-service.sh
```

This will:
- Stop the service
- Remove the plist file
- Optionally remove log files (with backup)

### Manual Uninstall

```bash
# Stop and unload the service
launchctl stop homebrew.mxcl.cc-bridge
launchctl unload ~/Library/LaunchAgents/homebrew.mxcl.cc-bridge.plist

# Remove the plist file
rm ~/Library/LaunchAgents/homebrew.mxcl.cc-bridge.plist

# Optionally remove logs
sudo rm -rf /opt/homebrew/var/log/cc-bridge

# Note: This does not uninstall cc-bridge itself
# To uninstall cc-bridge:
pip uninstall cc-bridge
```

## Advanced Topics

### Running as Different User

By default, the service runs as the current user. To run as a different user:

1. **Create a system-wide LaunchDaemon** (runs as root):
   ```bash
   sudo cp contrib/homebrew.mxcl.cc-bridge.plist /Library/LaunchDaemons/
   ```

2. **Add UserName key** to specify user:
   ```xml
   <key>UserName</key>
   <string>your_username</string>
   ```

3. **Load as root**:
   ```bash
   sudo launchctl load /Library/LaunchDaemons/homebrew.mxcl.cc-bridge.plist
   ```

**Warning**: Running as root poses security risks. Only do this if necessary.

### Multiple Instances

To run multiple cc-bridge server instances (e.g., on different ports):

1. **Create separate plist files** for each instance:
   - `homebrew.mxcl.cc-bridge-8080.plist`
   - `homebrew.mxcl.cc-bridge-8081.plist`

2. **Change Label and port** in each plist:
   ```xml
   <key>Label</key>
   <string>homebrew.mxcl.cc-bridge-8081</string>
   ```

3. **Use different log files**:
   ```xml
   <key>StandardOutPath</key>
   <string>/opt/homebrew/var/log/cc-bridge/server-8081.log</string>
   ```

4. **Load each instance separately**

### Integration with Other Tools

#### Cloudflare Tunnel

If you're using Cloudflare Tunnel (recommended for external access):

1. **Install cloudflared**:
   ```bash
   brew install cloudflared
   ```

2. **Configure tunnel** to forward `https://ccb.yourdomain.com` to `http://localhost:8080`

3. **Start tunnel as service**:
   ```bash
   brew services start cloudflared
   ```

See [cloudflared setup guide](how_to_setup_cloudflared_with_brew_services.md) for details.

#### Monitoring with Health Checks

The `/health` endpoint can be used for monitoring:

```bash
# Simple health check
curl http://localhost:8080/health

# Expected response: {"status":"healthy"}

# Add to monitoring system (e.g., Nagios, Zabbix)
# Alert if curl returns non-200 status
```

## Security Considerations

### Network Exposure

The service binds to `0.0.0.0:8080`, making it accessible from all network interfaces.

**Recommendations**:

1. **Use firewall** to restrict access:
   ```bash
   # Block external access to port 8080
   sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add /usr/local/bin/cc-bridge
   sudo /usr/libexec/ApplicationFirewall/socketfilterfw --blockincoming /usr/local/bin/cc-bridge
   ```

2. **Use reverse proxy** (nginx, Apache) for SSL/TLS

3. **Use Cloudflare Tunnel** for secure external access without open ports

### Authentication

The webhook endpoint does not include authentication. Consider:

1. **Using Telegram's built-in security** (webhook validation)
2. **Adding API key authentication** (future enhancement)
3. **Restricting to Cloudflare IPs** (if using tunnel)

### File Permissions

Ensure sensitive files have correct permissions:

```bash
# Config directory
chmod 700 ~/.config/cc-bridge/

# Config file
chmod 600 ~/.config/cc-bridge/config.toml

# Log directory (group-readable for troubleshooting)
chmod 750 /opt/homebrew/var/log/cc-bridge/
```

## Performance Tuning

### Resource Limits

The plist includes resource limits. Adjust based on your needs:

```xml
<key>SoftResourceLimits</key>
<dict>
    <key>NumberOfFiles</key>
    <integer>2048</integer>  <!-- Increase for more connections -->
</dict>
```

### Process Priority

Adjust process priority (nice value) if needed:

```xml
<key>Nice</key>
    <integer>-5</integer>  <!-- Higher priority (-20 to 20) -->
```

## FAQ

**Q: Does the service interfere with manual `cc-bridge server` commands?**

A: No, but you can't run both simultaneously. Stop the service first:
```bash
launchctl stop homebrew.mxcl.cc-bridge
cc-bridge server  # Manual start
```

**Q: How do I update cc-bridge while the service is running?**

A: Stop the service, update, then restart:
```bash
launchctl stop homebrew.mxcl.cc-bridge
pip install --upgrade cc-bridge
launchctl start homebrew.mxcl.cc-bridge
```

**Q: Can I use this with a virtual environment?**

A: Yes, update the plist to point to the venv python:
```xml
<key>ProgramArguments</key>
<array>
    <string>/path/to/venv/bin/python</string>
    <string>-m</string>
    <string>cc_bridge.cli</string>
    <string>server</string>
</array>
```

**Q: How do I see launchd error messages?**

A: Check the system log:
```bash
log show --predicate 'eventMessage contains "cc-bridge"' --last 1h
```

## References

- [Homebrew Services Documentation](https://docs.brew.sh/Manpage#services-subcommands)
- [launchd.plist(5) Manual Page](https://www.manpagez.com/man/5/launchd.plist/)
- [macOS Service Programming Guide](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
- [FastAPI Deployment Documentation](https://fastapi.tiangolo.com/deployment/)
