#!/bin/bash
# Fix cloudflared plist after Homebrew upgrade
# This restores the tunnel run arguments that get overwritten

PLIST_PATH="/opt/homebrew/opt/cloudflared/homebrew.mxcl.cloudflared.plist"
TUNNEL_NAME="${1:-mac_mini_m4}"

echo "Fixing cloudflared plist for tunnel: $TUNNEL_NAME"

python3 << EOF
import plistlib

plist_path = "$PLIST_PATH"

with open(plist_path, "rb") as f:
    plist = plistlib.load(f)

plist["ProgramArguments"] = [
    "/opt/homebrew/opt/cloudflared/bin/cloudflared",
    "tunnel",
    "run",
    "$TUNNEL_NAME"
]

with open(plist_path, "wb") as f:
    plistlib.dump(plist, f)

print("✅ Fixed plist with tunnel arguments:")
for arg in plist["ProgramArguments"]:
    print(f"  {arg}")
EOF

# Restart the service
echo ""
echo "Restarting cloudflared service..."
brew services restart cloudflared

echo ""
echo "Verifying status..."
sleep 2
brew services list | grep cloudflared
