# How to Set Up Cloudflare Tunnel with brew services

This guide explains how to configure Cloudflare Tunnel (`cloudflared`) to run as a background service using Homebrew services on macOS. This ensures your tunnel auto-starts and keeps running for reliable webhook access.

## Prerequisites

1. **Cloudflare account** with a domain added
2. **cloudflared installed** via Homebrew:
   ```bash
   brew install cloudflared
   ```
3. **A named tunnel created** (not quick tunnel):
   ```bash
   cloudflared tunnel create <tunnel-name>
   ```

## Overview

### Why Use brew services?

| Without brew services | With brew services |
|----------------------|-------------------|
| Must keep terminal open | Runs in background |
| Stops when you logout | Auto-starts on login |
| Manual restart needed | Auto-restart on crash |
| No centralized management | Easy `brew services` commands |

### How It Works

```
brew services → launchd → cloudflared tunnel run → Persistent connection
```

## Step-by-Step Setup

### Step 1: Create a Named Tunnel

If you haven't already, create a tunnel in your Cloudflare account:

```bash
cloudflared tunnel create my-tunnel
```

Save the output - you'll need the **tunnel ID** and **credentials file** location.

Example output:
```
Tunnel ID: 7cbc709b-405e-4231-8eda-c30a7f8f2dd0
Credentials file: /Users/you/.cloudflared/7cbc709b-405e-4231-8eda-c30a7f8f2dd0.json
```

### Step 2: Configure DNS Routing

Route your domain to the tunnel:

```bash
cloudflared tunnel route dns my-tunnel webhook.yourdomain.com
```

This creates a CNAME record in Cloudflare DNS pointing to your tunnel.

### Step 3: Configure Tunnel Ingress

Choose between **local configuration** or **remote configuration**:

#### Option A: Remote Configuration (Recommended)

Configure via Cloudflare Dashboard:

1. Go to **Cloudflare Zero Trust Dashboard**
2. Navigate to **Networks** → **Tunnels**
3. Select your tunnel (`my-tunnel`)
4. Click **Configure**
5. Add your public hostname:
   - **Subdomain**: `webhook`
   - **Domain**: `yourdomain.com`
   - **Service**: `http://localhost:8080`
   - **Path**: (leave empty for root, or enter `/webhook`)

#### Option B: Local Configuration

Create `~/.cloudflared/config.yaml`:

```yaml
tunnel: <tunnel-id-from-step-1>
credentials-file: /Users/you/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: webhook.yourdomain.com
    service: http://localhost:8080
  - service: http_status:404
```

### Step 4: Fix Homebrew plist for Tunnel Running

**Important:** The default Homebrew plist runs `cloudflared` without arguments, causing it to fail. You must update it to include `tunnel run <name>`.

The plist is located at:
```
/opt/homebrew/opt/cloudflared/homebrew.mxcl.cloudflared.plist
```

**Update the plist using Python:**

```bash
python3 << 'EOF'
import plistlib

plist_path = "/opt/homebrew/opt/cloudflared/homebrew.mxcl.cloudflared.plist"

with open(plist_path, "rb") as f:
    plist = plistlib.load(f)

# Update ProgramArguments to run your tunnel
plist["ProgramArguments"] = [
    "/opt/homebrew/opt/cloudflared/bin/cloudflared",
    "tunnel",
    "run",
    "my-tunnel"  # Replace with your tunnel name
]

with open(plist_path, "wb") as f:
    plistlib.dump(plist, f)

print("✅ Updated plist")
print("ProgramArguments:", plist["ProgramArguments"])
EOF
```

**Or edit manually** (if you prefer):

1. Open the plist file:
   ```bash
   nano /opt/homebrew/opt/cloudflared/homebrew.mxcl.cloudflared.plist
   ```

2. Find the `ProgramArguments` section and update it:
   ```xml
   <key>ProgramArguments</key>
   <array>
       <string>/opt/homebrew/opt/cloudflared/bin/cloudflared</string>
       <string>tunnel</string>
       <string>run</string>
       <string>my-tunnel</string>
   </array>
   ```

### Step 5: Start the Service

```bash
brew services start cloudflared
```

### Step 6: Verify It's Running

```bash
# Check service status
brew services list | grep cloudflared

# View logs
tail -f /opt/homebrew/var/log/cloudflared.log
```

You should see:
```
INF Starting tunnel tunnelID=<your-id>
INF Registered tunnel connection
INF Updated to new configuration
```

## Managing the Service

### Common Commands

```bash
# Check status
brew services list | grep cloudflared

# Start the service
brew services start cloudflared

# Stop the service
brew services stop cloudflared

# Restart the service
brew services restart cloudflared

# View logs
tail -f /opt/homebrew/var/log/cloudflared.log
```

### Service States Explained

| State | Meaning |
|-------|---------|
| `started` | Service is running |
| `stopped` | Service is stopped |
| `error` | Service failed to start (check logs) |
| `idle` | Service loaded but not running (normal for some services) |

## Troubleshooting

### Issue: Service shows "error" status

**Check the error log:**
```bash
tail -50 /opt/homebrew/var/log/cloudflared.log
```

**Common causes:**
1. **Wrong tunnel name** in plist - verify `ProgramArguments` includes correct tunnel name
2. **Missing credentials file** - ensure `.json` file exists in `~/.cloudflared/`
3. **Invalid configuration** - check ingress rules match your setup

### Issue: "Use cloudflared tunnel run" message in logs

**Cause:** The plist doesn't include `tunnel run <name>` arguments.

**Fix:** Follow Step 4 above to update the plist.

### Issue: Tunnel connects but webhook returns 404/405

**Check:**
1. Service is running on correct port (default 8080):
   ```bash
   curl http://localhost:8080/health
   ```
2. Webhook URL includes correct path:
   - If server uses `/webhook`: `https://webhook.yourdomain.com/webhook`
   - If server uses root `/`: `https://webhook.yourdomain.com/`

### Issue: Tunnel works manually but not as service

**Cause:** Environment variables or path differences.

**Fix:** Use absolute paths in plist and config.yaml.

### Issue: Service stops when you logout

**Cause:** LaunchAgent session limitations.

**Fix:** The service should auto-start on next login. For system-wide running, consider using a LaunchDaemon (requires root).

## Updating Configuration

### After Changing Remote Config (Dashboard)

1. Changes are applied automatically - no restart needed
2. Cloudflare pushes config to running tunnel

### After Changing Local Config (config.yaml)

1. Restart the service:
   ```bash
   brew services restart cloudflared
   ```

### After Updating Plist

1. Stop the service:
   ```bash
   brew services stop cloudflared
   ```

2. Start the service:
   ```bash
   brew services start cloudflared
   ```

## Example: Complete Setup for cc-bridge

```bash
# 1. Install cloudflared
brew install cloudflared

# 2. Create tunnel
cloudflared tunnel create mac_mini_m4

# 3. Route DNS
cloudflared tunnel route dns mac_mini_m4 ccb.robinmin.net

# 4. Configure in Cloudflare Dashboard
#    Add: ccb.robinmin.net → http://localhost:8080

# 5. Update plist
python3 << 'EOF'
import plistlib
plist_path = "/opt/homebrew/opt/cloudflared/homebrew.mxcl.cloudflared.plist"
with open(plist_path, "rb") as f:
    plist = plistlib.load(f)
plist["ProgramArguments"] = [
    "/opt/homebrew/opt/cloudflared/bin/cloudflared",
    "tunnel",
    "run",
    "mac_mini_m4"
]
with open(plist_path, "wb") as f:
    plistlib.dump(plist, f)
EOF

# 6. Start service
brew services start cloudflared

# 7. Verify
brew services list | grep cloudflared
tail -f /opt/homebrew/var/log/cloudflared.log

# 8. Update Telegram webhook
export $(cat .env | xargs)
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook?url=https://ccb.robinmin.net/webhook"
```

## Security Notes

1. **Credentials file**: Keep `~/.cloudflared/*.json` secure - it authenticates your tunnel
2. **Permissions**: Plist and config files should be readable only by you
3. **Firewall**: Ensure port 8080 (or your service port) is not publicly accessible
4. **HTTPS**: Cloudflare tunnels automatically provide HTTPS/TLS termination

## Important Note: Handling Upgrades

### ⚠️ Problem: `brew upgrade` Overwrites Your Plist

When you run `brew upgrade cloudflared`, Homebrew **overwrites the plist file** with the default configuration, removing your custom `tunnel run <name>` arguments. This causes the service to fail.

### Solution: Re-apply the Fix After Each Upgrade

After upgrading cloudflared, you need to re-apply the plist fix:

```bash
# Upgrade cloudflared
brew upgrade cloudflared

# Re-apply the fix (replace mac_mini_m4 with your tunnel name)
python3 << 'EOF'
import plistlib

plist_path = "/opt/homebrew/opt/cloudflared/homebrew.mxcl.cloudflared.plist"

with open(plist_path, "rb") as f:
    plist = plistlib.load(f)

plist["ProgramArguments"] = [
    "/opt/homebrew/opt/cloudflared/bin/cloudflared",
    "tunnel",
    "run",
    "mac_mini_m4"  # Your tunnel name here
]

with open(plist_path, "wb") as f:
    plistlib.dump(plist, f)

print("✅ Fixed plist")
EOF

# Restart the service
brew services restart cloudflared
```

### Alternative: Use the Included Script

If you have the cc-bridge repository, use the included fix script:

```bash
./scripts/fix-cloudflared-plist.sh mac_mini_m4
```

This script:
1. Fixes the plist with your tunnel name
2. Restarts the service
3. Verifies the status

### Verification

After upgrading and fixing, always verify:

```bash
brew services list | grep cloudflared
# Should show: cloudflared started

tail -f /opt/homebrew/var/log/cloudflared.log
# Should show: Registered tunnel connection
```

## Related Documentation

- [Cloudflare Tunnels Documentation](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/)
- [cloudflared GitHub Repository](https://github.com/cloudflare/cloudflared)
- [Homebrew Services Documentation](https://docs.brew.sh/Manpage#services-subcommands)
- [cc-bridge Setup Guide](./USER_MANUAL.md)
