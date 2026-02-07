import { discoveryCache } from "@/gateway/services/discovery-cache";
import { logger } from "@/packages/logger";

async function main() {
	try {
		await discoveryCache.refresh();
		logger.info("Discovery cache refreshed successfully");
		process.exit(0);
	} catch (error) {
		logger.error({ error }, "Failed to refresh discovery cache");
		process.exit(1);
	}
}

main();
