import fs from "node:fs";
import { parse } from "jsonc-parser";
import { logger } from "@/packages/logger";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function deepMerge<T>(defaults: T, parsed: unknown): T {
	if (!isRecord(defaults) || !isRecord(parsed)) {
		return (parsed ?? defaults) as T;
	}

	const merged: Record<string, unknown> = { ...defaults };
	for (const [key, parsedValue] of Object.entries(parsed)) {
		const defaultValue = (defaults as Record<string, unknown>)[key];
		if (isRecord(defaultValue) && isRecord(parsedValue)) {
			merged[key] = deepMerge(defaultValue, parsedValue);
			continue;
		}
		merged[key] = parsedValue;
	}
	return merged as T;
}

/**
 * Loads a JSONC configuration file.
 * @param configPath Path to the .jsonc file
 * @param defaults Default configuration object
 */
export function loadConfig<T>(configPath: string, defaults: T): T {
	try {
		if (!fs.existsSync(configPath)) {
			logger.warn({ configPath }, "Configuration file not found, using defaults");
			return defaults;
		}

		const content = fs.readFileSync(configPath, "utf-8");
		const parsed = parse(content);

		if (!parsed || typeof parsed !== "object") {
			logger.error({ configPath }, "Failed to parse configuration file or invalid JSONC");
			return defaults;
		}

		logger.info({ configPath }, "Configuration loaded successfully");
		return deepMerge(defaults, parsed);
	} catch (error) {
		logger.error({ configPath, error }, "Error loading configuration");
		return defaults;
	}
}

// Keep existing API shape for callers using ConfigLoader.load(...)
export const ConfigLoader = {
	load: loadConfig,
} as const;
