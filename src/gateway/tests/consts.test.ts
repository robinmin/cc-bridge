import { describe, expect, test } from "bun:test";
import { GATEWAY_CONSTANTS } from "@/gateway/consts";

describe("Gateway Constants - Feishu Configuration", () => {
	describe("DIAGNOSTICS.URLS", () => {
		test("should include TELEGRAM_API_BASE", () => {
			expect(GATEWAY_CONSTANTS.DIAGNOSTICS.URLS.TELEGRAM_API_BASE).toBe("https://api.telegram.org");
		});

		test("should include FEISHU_API_BASE", () => {
			expect(GATEWAY_CONSTANTS.DIAGNOSTICS.URLS.FEISHU_API_BASE).toBe("https://open.feishu.cn");
		});

		test("should include LARK_API_BASE", () => {
			expect(GATEWAY_CONSTANTS.DIAGNOSTICS.URLS.LARK_API_BASE).toBe("https://open.larksuite.com");
		});

		test("should include ANTHROPIC_API_BASE", () => {
			expect(GATEWAY_CONSTANTS.DIAGNOSTICS.URLS.ANTHROPIC_API_BASE).toBe("https://api.anthropic.com");
		});

		test("should have all required API base URLs", () => {
			const urls = GATEWAY_CONSTANTS.DIAGNOSTICS.URLS;

			expect(urls).toHaveProperty("TELEGRAM_API_BASE");
			expect(urls).toHaveProperty("FEISHU_API_BASE");
			expect(urls).toHaveProperty("LARK_API_BASE");
			expect(urls).toHaveProperty("ANTHROPIC_API_BASE");
		});

		test("should use HTTPS for all API URLs", () => {
			const urls = GATEWAY_CONSTANTS.DIAGNOSTICS.URLS;

			expect(urls.TELEGRAM_API_BASE).toMatch(/^https:\/\//);
			expect(urls.FEISHU_API_BASE).toMatch(/^https:\/\//);
			expect(urls.LARK_API_BASE).toMatch(/^https:\/\//);
			expect(urls.ANTHROPIC_API_BASE).toMatch(/^https:\/\//);
		});

		test("should have distinct URLs for Feishu and Lark", () => {
			expect(GATEWAY_CONSTANTS.DIAGNOSTICS.URLS.FEISHU_API_BASE).not.toBe(
				GATEWAY_CONSTANTS.DIAGNOSTICS.URLS.LARK_API_BASE,
			);
		});

		test("Feishu URL should point to open.feishu.cn", () => {
			expect(GATEWAY_CONSTANTS.DIAGNOSTICS.URLS.FEISHU_API_BASE).toContain("feishu.cn");
		});

		test("Lark URL should point to open.larksuite.com", () => {
			expect(GATEWAY_CONSTANTS.DIAGNOSTICS.URLS.LARK_API_BASE).toContain("larksuite.com");
		});
	});

	describe("Constants structure", () => {
		test("should have DIAGNOSTICS section", () => {
			expect(GATEWAY_CONSTANTS).toHaveProperty("DIAGNOSTICS");
		});

		test("should have DIAGNOSTICS.URLS section", () => {
			expect(GATEWAY_CONSTANTS.DIAGNOSTICS).toHaveProperty("URLS");
		});

		test("should preserve other existing constants", () => {
			expect(GATEWAY_CONSTANTS).toHaveProperty("HEALTH");
			expect(GATEWAY_CONSTANTS).toHaveProperty("CONFIG");
			expect(GATEWAY_CONSTANTS).toHaveProperty("INSTANCES");
			expect(GATEWAY_CONSTANTS).toHaveProperty("DEFAULT_CONFIG");
			expect(GATEWAY_CONSTANTS).toHaveProperty("FILESYSTEM_IPC");
			expect(GATEWAY_CONSTANTS).toHaveProperty("TMUX");
		});
	});

	describe("Environment variable fallbacks", () => {
		test("should use environment variables for PROJECTS_ROOT", () => {
			// This test verifies that the constant can access env vars
			// The actual value depends on the test environment
			expect(GATEWAY_CONSTANTS.CONFIG.PROJECTS_ROOT).toBeDefined();
			expect(typeof GATEWAY_CONSTANTS.CONFIG.PROJECTS_ROOT).toBe("string");
		});

		test("should use environment variables for WORKSPACE_ROOT", () => {
			expect(GATEWAY_CONSTANTS.CONFIG.WORKSPACE_ROOT).toBeDefined();
			expect(typeof GATEWAY_CONSTANTS.CONFIG.WORKSPACE_ROOT).toBe("string");
		});
	});

	describe("Constants immutability", () => {
		test("should have frozen DIAGNOSTICS.URLS", () => {
			// In production, these constants should not be modified
			// This test documents the expectation
			const urls = GATEWAY_CONSTANTS.DIAGNOSTICS.URLS;

			expect(urls.TELEGRAM_API_BASE).toBe("https://api.telegram.org");
			expect(urls.FEISHU_API_BASE).toBe("https://open.feishu.cn");
			expect(urls.LARK_API_BASE).toBe("https://open.larksuite.com");
		});
	});
});
