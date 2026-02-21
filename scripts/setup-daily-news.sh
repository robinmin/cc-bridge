#!/usr/bin/env bash
# Setup script for Daily News Summary task

set -euo pipefail

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
INSTANCE="${CC_BRIDGE_INSTANCE:-cc-bridge}"
SCHEDULE_TYPE="${NEWS_SCHEDULE_TYPE:-recurring}"
SCHEDULE_VALUE="${NEWS_SCHEDULE_VALUE:-8h}"
APP_ID="${NEWS_APP_ID:-daily-news}"
APP_INPUT="${NEWS_APP_INPUT:-}"
if [[ -n "${APP_INPUT}" ]]; then
	PROMPT="@miniapp:${APP_ID} ${APP_INPUT}"
else
	PROMPT="@miniapp:${APP_ID}"
fi

echo -e "${BLUE}📰 Daily News Summary - Setup${NC}"
echo ""
echo "Configuration:"
echo "  Instance: ${INSTANCE}"
echo "  Schedule: ${SCHEDULE_TYPE} ${SCHEDULE_VALUE}"
echo "  Mini-App: ${APP_ID}"
echo "  Prompt Token: ${PROMPT}"
echo ""

# Check if host_cmd.sh exists
if [[ ! -f "scripts/host_cmd.sh" ]]; then
	echo -e "${YELLOW}⚠️  Warning: scripts/host_cmd.sh not found${NC}"
	echo "Please run this from the cc-bridge root directory"
	exit 1
fi

# Add the scheduled task
echo -e "${GREEN}➕ Adding scheduled task...${NC}"
bun run scripts/host_cmd.ts scheduler_add "${INSTANCE}" "${SCHEDULE_TYPE}" "${SCHEDULE_VALUE}" "${PROMPT}"

echo ""
echo -e "${GREEN}✅ Setup complete!${NC}"
echo ""
echo "To view scheduled tasks:"
echo "  scripts/host_cmd.sh schedulers"
echo ""
echo "To delete this task:"
echo "  scripts/host_cmd.sh scheduler_del <task_id>"
