import type { Context } from "hono";
import { AGENT_CONSTANTS } from "@/agent/consts";
import { ConfigLoader } from "@/packages/config";

export function handleHealth(c: Context) {
	const config = ConfigLoader.load(
		AGENT_CONSTANTS.EXECUTION.CONFIG_FILE,
		AGENT_CONSTANTS.DEFAULT_CONFIG,
	);
	return c.json({
		status: config.healthStatus,
		runtime: config.healthRuntime,
		version: Bun.version,
	});
}

export default handleHealth;
