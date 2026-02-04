import { parse } from "jsonc-parser";
import fs from "node:fs";
import path from "node:path";
import { logger } from "@/packages/logger";

export class ConfigLoader {
    /**
     * Loads a JSONC configuration file.
     * @param configPath Path to the .jsonc file
     * @param defaults Default configuration object
     */
    static load<T>(configPath: string, defaults: T): T {
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
            return { ...defaults, ...parsed };
        } catch (error) {
            logger.error({ configPath, error }, "Error loading configuration");
            return defaults;
        }
    }
}
