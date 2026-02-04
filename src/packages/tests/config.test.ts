import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { ConfigLoader } from "@/packages/config";
import fs from "node:fs";

describe("ConfigLoader", () => {
    const testConfigPath = "test_config.jsonc";

    afterEach(() => {
        if (fs.existsSync(testConfigPath)) {
            fs.unlinkSync(testConfigPath);
        }
    });

    test("should load configuration from JSONC file with comments", () => {
        const content = `{
            /* Multi-line 
               comment */
            "port": 9090, // inline comment
            "debug": true
        }`;
        fs.writeFileSync(testConfigPath, content);

        const config = ConfigLoader.load(testConfigPath, { port: 8080, debug: false });
        expect(config.port).toBe(9090);
        expect(config.debug).toBe(true);
    });

    test("should use defaults if file does not exist", () => {
        const config = ConfigLoader.load("non_existent.jsonc", { port: 8080 });
        expect(config.port).toBe(8080);
    });

    test("should handle invalid JSONC by returning defaults", () => {
        fs.writeFileSync(testConfigPath, "{ invalid json }");
        const config = ConfigLoader.load(testConfigPath, { port: 8080 });
        expect(config.port).toBe(8080);
    });
});
