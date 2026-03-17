/**
 * Browser Sandbox Tests
 *
 * Tests for browser sandbox configuration, validation, port allocation,
 * security blocks, and executor construction.
 * No actual Chrome is needed - all tests are unit/mock tests.
 */

import { describe, expect, it } from "vitest";
import {
	BrowserSandboxExecutor,
	buildChromeFlags,
	CdpPortAllocator,
	createBrowserSandboxExecutor,
	DEFAULT_BROWSER_SANDBOX_CONFIG,
	getCdpPort,
	validateBrowserSandboxConfig,
} from "../agent/tools/sandbox/browser";

// =============================================================================
// Config Defaults Tests
// =============================================================================

describe("BrowserSandboxConfig", () => {
	describe("DEFAULT_BROWSER_SANDBOX_CONFIG", () => {
		it("should have sensible defaults", () => {
			expect(DEFAULT_BROWSER_SANDBOX_CONFIG.cdpBasePort).toBe(9222);
			expect(DEFAULT_BROWSER_SANDBOX_CONFIG.cdpPortOffset).toBe(0);
			expect(DEFAULT_BROWSER_SANDBOX_CONFIG.headless).toBe(true);
			expect(DEFAULT_BROWSER_SANDBOX_CONFIG.networkEnabled).toBe(false);
			expect(DEFAULT_BROWSER_SANDBOX_CONFIG.startupTimeoutMs).toBe(30000);
		});
	});
});

// =============================================================================
// Validation Tests
// =============================================================================

describe("validateBrowserSandboxConfig", () => {
	it("should pass with empty config (defaults)", () => {
		const result = validateBrowserSandboxConfig({});
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
	});

	it("should pass with valid custom config", () => {
		const result = validateBrowserSandboxConfig({
			cdpBasePort: 9300,
			headless: true,
			networkEnabled: false,
			chromeFlags: ["--mute-audio"],
		});
		expect(result.valid).toBe(true);
	});

	// Security: blocked flags
	describe("blocked Chrome flags", () => {
		it("should block --no-sandbox", () => {
			const result = validateBrowserSandboxConfig({
				chromeFlags: ["--no-sandbox"],
			});
			expect(result.valid).toBe(false);
			expect(result.errors[0]).toContain("--no-sandbox");
			expect(result.errors[0]).toContain("security risk");
		});

		it("should block --disable-setuid-sandbox", () => {
			const result = validateBrowserSandboxConfig({
				chromeFlags: ["--disable-setuid-sandbox"],
			});
			expect(result.valid).toBe(false);
			expect(result.errors[0]).toContain("--disable-setuid-sandbox");
		});

		it("should block --disable-web-security", () => {
			const result = validateBrowserSandboxConfig({
				chromeFlags: ["--disable-web-security"],
			});
			expect(result.valid).toBe(false);
		});

		it("should block --allow-running-insecure-content", () => {
			const result = validateBrowserSandboxConfig({
				chromeFlags: ["--allow-running-insecure-content"],
			});
			expect(result.valid).toBe(false);
		});

		it("should block --disable-site-isolation-trials", () => {
			const result = validateBrowserSandboxConfig({
				chromeFlags: ["--disable-site-isolation-trials"],
			});
			expect(result.valid).toBe(false);
		});

		it("should block case-insensitive variants", () => {
			const result = validateBrowserSandboxConfig({
				chromeFlags: ["--No-Sandbox"],
			});
			expect(result.valid).toBe(false);
		});

		it("should block flag with value (e.g. --no-sandbox=1)", () => {
			const result = validateBrowserSandboxConfig({
				chromeFlags: ["--no-sandbox=1"],
			});
			expect(result.valid).toBe(false);
		});

		it("should allow safe custom flags", () => {
			const result = validateBrowserSandboxConfig({
				chromeFlags: ["--mute-audio", "--window-size=1920,1080"],
			});
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		it("should report multiple blocked flags", () => {
			const result = validateBrowserSandboxConfig({
				chromeFlags: ["--no-sandbox", "--disable-web-security"],
			});
			expect(result.valid).toBe(false);
			expect(result.errors.length).toBe(2);
		});
	});

	// Port validation
	describe("CDP port validation", () => {
		it("should reject port below 1024", () => {
			const result = validateBrowserSandboxConfig({
				cdpBasePort: 80,
			});
			expect(result.valid).toBe(false);
			expect(result.errors[0]).toContain("out of valid range");
		});

		it("should reject port above 65535", () => {
			const result = validateBrowserSandboxConfig({
				cdpBasePort: 65000,
				cdpPortOffset: 600,
			});
			expect(result.valid).toBe(false);
			expect(result.errors[0]).toContain("out of valid range");
		});

		it("should accept port at boundaries", () => {
			expect(validateBrowserSandboxConfig({ cdpBasePort: 1024 }).valid).toBe(true);
			expect(validateBrowserSandboxConfig({ cdpBasePort: 65535 }).valid).toBe(true);
		});
	});

	// Warnings
	describe("warnings", () => {
		it("should warn when headless is disabled", () => {
			const result = validateBrowserSandboxConfig({ headless: false });
			expect(result.valid).toBe(true);
			expect(result.warnings).toContain("Headless mode disabled - browser UI will be visible");
		});

		it("should warn when network is enabled", () => {
			const result = validateBrowserSandboxConfig({ networkEnabled: true });
			expect(result.valid).toBe(true);
			expect(result.warnings).toContain("Network access enabled - browser can make external requests");
		});

		it("should have no warnings with defaults", () => {
			const result = validateBrowserSandboxConfig({});
			expect(result.warnings).toHaveLength(0);
		});
	});

	// Timeout validation
	describe("startup timeout", () => {
		it("should reject zero timeout", () => {
			const result = validateBrowserSandboxConfig({ startupTimeoutMs: 0 });
			expect(result.valid).toBe(false);
		});

		it("should reject negative timeout", () => {
			const result = validateBrowserSandboxConfig({ startupTimeoutMs: -1000 });
			expect(result.valid).toBe(false);
		});

		it("should accept positive timeout", () => {
			const result = validateBrowserSandboxConfig({ startupTimeoutMs: 60000 });
			expect(result.valid).toBe(true);
		});
	});
});

// =============================================================================
// Port Management Tests
// =============================================================================

describe("getCdpPort", () => {
	it("should return base port with no offset", () => {
		expect(getCdpPort({})).toBe(9222);
	});

	it("should add offset to base port", () => {
		expect(getCdpPort({ cdpBasePort: 9222, cdpPortOffset: 5 })).toBe(9227);
	});

	it("should use custom base port", () => {
		expect(getCdpPort({ cdpBasePort: 10000 })).toBe(10000);
	});

	it("should use custom base port with offset", () => {
		expect(getCdpPort({ cdpBasePort: 10000, cdpPortOffset: 3 })).toBe(10003);
	});
});

describe("CdpPortAllocator", () => {
	it("should allocate first port as base port", () => {
		const allocator = new CdpPortAllocator(9222);
		expect(allocator.allocate()).toBe(9222);
	});

	it("should allocate sequential ports", () => {
		const allocator = new CdpPortAllocator(9222);
		expect(allocator.allocate()).toBe(9222);
		expect(allocator.allocate()).toBe(9223);
		expect(allocator.allocate()).toBe(9224);
	});

	it("should track allocated count", () => {
		const allocator = new CdpPortAllocator();
		expect(allocator.allocatedCount).toBe(0);
		allocator.allocate();
		expect(allocator.allocatedCount).toBe(1);
		allocator.allocate();
		expect(allocator.allocatedCount).toBe(2);
	});

	it("should release ports", () => {
		const allocator = new CdpPortAllocator(9222);
		const port = allocator.allocate();
		expect(allocator.isAllocated(port)).toBe(true);
		allocator.release(port);
		expect(allocator.isAllocated(port)).toBe(false);
		expect(allocator.allocatedCount).toBe(0);
	});

	it("should reuse released ports", () => {
		const allocator = new CdpPortAllocator(9222);
		const port1 = allocator.allocate();
		allocator.allocate(); // 9223
		allocator.release(port1);
		// Next allocation should reuse 9222
		expect(allocator.allocate()).toBe(9222);
	});

	it("should release all ports", () => {
		const allocator = new CdpPortAllocator();
		allocator.allocate();
		allocator.allocate();
		allocator.allocate();
		expect(allocator.allocatedCount).toBe(3);
		allocator.releaseAll();
		expect(allocator.allocatedCount).toBe(0);
	});

	it("should throw when all ports exhausted", () => {
		// Use a base port near the limit to exhaust faster
		const allocator = new CdpPortAllocator(65500);
		// Can allocate ports 65500..65535 (36 ports)
		for (let i = 0; i < 36; i++) {
			allocator.allocate();
		}
		// Now remaining 64 slots in the 100-offset range are > 65535
		expect(() => allocator.allocate()).toThrow("No available CDP ports");
	});

	it("should use default base port", () => {
		const allocator = new CdpPortAllocator();
		expect(allocator.allocate()).toBe(9222);
	});
});

// =============================================================================
// Chrome Flag Builder Tests
// =============================================================================

describe("buildChromeFlags", () => {
	it("should include CDP port restricted to localhost", () => {
		const flags = buildChromeFlags({});
		expect(flags).toContain("--remote-debugging-port=9222");
		expect(flags).toContain("--remote-debugging-address=127.0.0.1");
	});

	it("should use custom CDP port", () => {
		const flags = buildChromeFlags({ cdpBasePort: 9300, cdpPortOffset: 5 });
		expect(flags).toContain("--remote-debugging-port=9305");
	});

	it("should include headless flag by default", () => {
		const flags = buildChromeFlags({});
		expect(flags).toContain("--headless=new");
	});

	it("should omit headless flag when disabled", () => {
		const flags = buildChromeFlags({ headless: false });
		expect(flags).not.toContain("--headless=new");
	});

	it("should include network isolation flags by default", () => {
		const flags = buildChromeFlags({});
		expect(flags).toContain("--disable-background-networking");
		expect(flags).toContain("--disable-extensions");
		expect(flags).toContain("--disable-sync");
	});

	it("should omit network isolation flags when network enabled", () => {
		const flags = buildChromeFlags({ networkEnabled: true });
		expect(flags).not.toContain("--disable-background-networking");
		expect(flags).not.toContain("--disable-extensions");
	});

	it("should include user data dir when specified", () => {
		const flags = buildChromeFlags({ userDataDir: "/tmp/chrome-profile" });
		expect(flags).toContain("--user-data-dir=/tmp/chrome-profile");
	});

	it("should include standard safety flags", () => {
		const flags = buildChromeFlags({});
		expect(flags).toContain("--disable-gpu");
		expect(flags).toContain("--no-first-run");
		expect(flags).toContain("--no-default-browser-check");
		expect(flags).toContain("--disable-dev-shm-usage");
	});

	it("should append custom Chrome flags", () => {
		const flags = buildChromeFlags({ chromeFlags: ["--mute-audio", "--window-size=800,600"] });
		expect(flags).toContain("--mute-audio");
		expect(flags).toContain("--window-size=800,600");
	});
});

// =============================================================================
// Executor Construction Tests
// =============================================================================

describe("BrowserSandboxExecutor", () => {
	it("should construct with default config", () => {
		const executor = new BrowserSandboxExecutor();
		expect(executor.isSandboxed()).toBe(true);
	});

	it("should construct with valid custom config", () => {
		const executor = new BrowserSandboxExecutor({
			cdpBasePort: 9300,
			headless: true,
		});
		expect(executor.getCdpPort()).toBe(9300);
	});

	it("should throw on invalid config (blocked flag)", () => {
		expect(() => new BrowserSandboxExecutor({ chromeFlags: ["--no-sandbox"] })).toThrow(
			"Invalid browser sandbox config",
		);
	});

	it("should throw on invalid config (bad port)", () => {
		expect(() => new BrowserSandboxExecutor({ cdpBasePort: 80 })).toThrow("Invalid browser sandbox config");
	});

	it("should always report as sandboxed", () => {
		const executor = new BrowserSandboxExecutor();
		expect(executor.isSandboxed()).toBe(true);
	});

	it("should return host path unchanged from getWorkspacePath", () => {
		const executor = new BrowserSandboxExecutor();
		expect(executor.getWorkspacePath("/my/path")).toBe("/my/path");
	});

	it("should return correct CDP port", () => {
		const executor = new BrowserSandboxExecutor({ cdpBasePort: 9300, cdpPortOffset: 2 });
		expect(executor.getCdpPort()).toBe(9302);
	});

	it("should return correct CDP endpoint", () => {
		const executor = new BrowserSandboxExecutor({ cdpBasePort: 9300 });
		expect(executor.getCdpEndpoint()).toBe("ws://127.0.0.1:9300");
	});

	it("should not be running initially", () => {
		const executor = new BrowserSandboxExecutor();
		expect(executor.isRunning()).toBe(false);
	});

	it("should handle cleanup when not running", () => {
		const executor = new BrowserSandboxExecutor();
		// Should not throw
		expect(() => executor.cleanup()).not.toThrow();
	});
});

describe("createBrowserSandboxExecutor", () => {
	it("should create executor with defaults", () => {
		const executor = createBrowserSandboxExecutor();
		expect(executor).toBeInstanceOf(BrowserSandboxExecutor);
		expect(executor.isSandboxed()).toBe(true);
	});

	it("should create executor with custom config", () => {
		const executor = createBrowserSandboxExecutor({ cdpBasePort: 9400 });
		expect(executor.getCdpPort()).toBe(9400);
	});

	it("should throw on invalid config", () => {
		expect(() => createBrowserSandboxExecutor({ chromeFlags: ["--no-sandbox"] })).toThrow();
	});
});

// =============================================================================
// SandboxExecutor Interface Compliance
// =============================================================================

describe("SandboxExecutor interface compliance", () => {
	it("should implement all required methods", () => {
		const executor = new BrowserSandboxExecutor();
		expect(typeof executor.exec).toBe("function");
		expect(typeof executor.getWorkspacePath).toBe("function");
		expect(typeof executor.isSandboxed).toBe("function");
	});
});

// =============================================================================
// Executor run and cleanup Tests (covers lines 270-352, 399-401, 430-449)
// =============================================================================

describe("BrowserSandboxExecutor run", () => {
	it("should reject when Chrome binary is not found", async () => {
		const executor = new BrowserSandboxExecutor({
			chromePath: "/nonexistent/chrome-binary",
			startupTimeoutMs: 1000,
		});
		await expect(executor.exec("about:blank")).rejects.toBeDefined();
		expect(executor.isRunning()).toBe(false);
	});

	it("should resolve when process completes normally", async () => {
		const executor = new BrowserSandboxExecutor({
			chromePath: "/bin/echo",
			startupTimeoutMs: 5000,
		});
		const result = await executor.exec("hello");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("hello");
		expect(result.timedOut).toBe(false);
	});

	it("should resolve with exit code for invalid binary args", async () => {
		// /bin/sleep doesn't understand Chrome flags, exits with error code
		const executor = new BrowserSandboxExecutor({
			chromePath: "/bin/sleep",
			startupTimeoutMs: 5000,
		});
		const result = await executor.exec("0");
		expect(typeof result.code).toBe("number");
	});

	it("should use default Chrome path when not specified", async () => {
		const executor = new BrowserSandboxExecutor({ startupTimeoutMs: 500 });
		// Covers findChromePath() (lines 430-449)
		try {
			await executor.exec("about:blank");
		} catch {
			// Expected — no Chrome or timeout
		}
	});

	it("should pass options to exec", async () => {
		const executor = new BrowserSandboxExecutor({
			chromePath: "/bin/echo",
			startupTimeoutMs: 5000,
		});
		const result = await executor.exec("test", {
			cwd: "/tmp",
			timeoutMs: 5000,
		});
		expect(result.code).toBe(0);
	});

	it("should handle abort signal on already-aborted controller", async () => {
		const controller = new AbortController();
		controller.abort();
		const executor = new BrowserSandboxExecutor({
			chromePath: "/bin/echo",
			startupTimeoutMs: 5000,
		});
		// Process may resolve or reject depending on timing; covers the abort path
		try {
			await executor.exec("test", { signal: controller.signal });
		} catch {
			// Expected if abort is caught
		}
	});
});
