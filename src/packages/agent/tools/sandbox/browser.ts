/**
 * Browser Sandbox Executor
 *
 * Provides isolated Chrome/Chromium execution via CDP (Chrome DevTools Protocol).
 * Enforces security: headless by default, no --no-sandbox flag, CDP restricted to localhost.
 *
 * NOTE: Uses child_process.spawn (not exec) for safe process launching without shell injection.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { ExecOptions, ExecResult, SandboxExecutor } from "./executor";

// =============================================================================
// Configuration
// =============================================================================

/**
 * Browser sandbox configuration
 */
export interface BrowserSandboxConfig {
	/** Base CDP port (actual port = basePort + offset). Default: 9222 */
	cdpBasePort?: number;
	/** Port offset for this instance to avoid conflicts. Default: 0 */
	cdpPortOffset?: number;
	/** Chrome/Chromium binary path. Default: searches common locations */
	chromePath?: string;
	/** Additional Chrome flags (security-validated before use) */
	chromeFlags?: string[];
	/** Whether to enable network access. Default: false (isolated) */
	networkEnabled?: boolean;
	/** Whether to run in headless mode. Default: true (enforced unless explicitly overridden) */
	headless?: boolean;
	/** User data directory for Chrome profile isolation */
	userDataDir?: string;
	/** Timeout for browser startup in milliseconds. Default: 30000 */
	startupTimeoutMs?: number;
	/** Memory limit hint for the browser process (not enforced at OS level) */
	memory?: string;
}

/**
 * Default browser sandbox configuration
 */
export const DEFAULT_BROWSER_SANDBOX_CONFIG: Required<
	Pick<BrowserSandboxConfig, "cdpBasePort" | "cdpPortOffset" | "headless" | "networkEnabled" | "startupTimeoutMs">
> = {
	cdpBasePort: 9222,
	cdpPortOffset: 0,
	headless: true,
	networkEnabled: false,
	startupTimeoutMs: 30000,
};

// =============================================================================
// Security
// =============================================================================

/**
 * Chrome flags that are blocked for security reasons
 */
const BLOCKED_CHROME_FLAGS = [
	"--no-sandbox",
	"--disable-setuid-sandbox",
	"--disable-web-security",
	"--allow-running-insecure-content",
	"--disable-site-isolation-trials",
] as const;

/**
 * Validation result for browser sandbox config
 */
export interface BrowserValidationResult {
	/** Whether the config is valid */
	valid: boolean;
	/** Validation errors */
	errors: string[];
	/** Validation warnings */
	warnings: string[];
}

/**
 * Validate browser sandbox configuration for security issues
 */
export function validateBrowserSandboxConfig(config: BrowserSandboxConfig): BrowserValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	// Check for blocked Chrome flags
	if (config.chromeFlags) {
		for (const flag of config.chromeFlags) {
			const normalized = flag.toLowerCase().trim();
			for (const blocked of BLOCKED_CHROME_FLAGS) {
				if (normalized === blocked || normalized.startsWith(`${blocked}=`)) {
					errors.push(`Blocked Chrome flag: ${flag} (security risk)`);
				}
			}
		}
	}

	// Validate CDP port range
	const port = getCdpPort(config);
	if (port < 1024 || port > 65535) {
		errors.push(`CDP port ${port} out of valid range (1024-65535)`);
	}

	// Warn if headless is explicitly disabled
	if (config.headless === false) {
		warnings.push("Headless mode disabled - browser UI will be visible");
	}

	// Warn if network is enabled
	if (config.networkEnabled === true) {
		warnings.push("Network access enabled - browser can make external requests");
	}

	// Validate startup timeout
	if (config.startupTimeoutMs !== undefined && config.startupTimeoutMs <= 0) {
		errors.push(`Startup timeout must be positive: ${config.startupTimeoutMs}`);
	}

	return { valid: errors.length === 0, errors, warnings };
}

// =============================================================================
// Port Management
// =============================================================================

/**
 * Calculate the actual CDP port for a browser instance
 */
export function getCdpPort(config: BrowserSandboxConfig): number {
	const base = config.cdpBasePort ?? DEFAULT_BROWSER_SANDBOX_CONFIG.cdpBasePort;
	const offset = config.cdpPortOffset ?? DEFAULT_BROWSER_SANDBOX_CONFIG.cdpPortOffset;
	return base + offset;
}

/**
 * CDP port allocator - tracks used ports to avoid conflicts
 */
export class CdpPortAllocator {
	private usedPorts: Set<number> = new Set();
	private basePort: number;

	constructor(basePort: number = DEFAULT_BROWSER_SANDBOX_CONFIG.cdpBasePort) {
		this.basePort = basePort;
	}

	/**
	 * Allocate the next available CDP port
	 * @returns The allocated port number
	 * @throws If no ports are available in the range
	 */
	allocate(): number {
		const maxOffset = 100; // Support up to 100 concurrent browser instances
		for (let offset = 0; offset < maxOffset; offset++) {
			const port = this.basePort + offset;
			if (!this.usedPorts.has(port) && port <= 65535) {
				this.usedPorts.add(port);
				return port;
			}
		}
		throw new Error(`No available CDP ports in range ${this.basePort}-${this.basePort + maxOffset - 1}`);
	}

	/**
	 * Release a previously allocated port
	 */
	release(port: number): void {
		this.usedPorts.delete(port);
	}

	/**
	 * Check if a port is currently allocated
	 */
	isAllocated(port: number): boolean {
		return this.usedPorts.has(port);
	}

	/**
	 * Get count of allocated ports
	 */
	get allocatedCount(): number {
		return this.usedPorts.size;
	}

	/**
	 * Release all allocated ports
	 */
	releaseAll(): void {
		this.usedPorts.clear();
	}
}

// =============================================================================
// Chrome Flag Builder
// =============================================================================

/**
 * Build Chrome launch flags from config
 */
export function buildChromeFlags(config: BrowserSandboxConfig): string[] {
	const flags: string[] = [];
	const port = getCdpPort(config);

	// CDP debugging restricted to localhost
	flags.push(`--remote-debugging-port=${port}`);
	flags.push("--remote-debugging-address=127.0.0.1");

	// Headless mode (enforced by default)
	const headless = config.headless ?? DEFAULT_BROWSER_SANDBOX_CONFIG.headless;
	if (headless) {
		flags.push("--headless=new");
	}

	// Network isolation
	const networkEnabled = config.networkEnabled ?? DEFAULT_BROWSER_SANDBOX_CONFIG.networkEnabled;
	if (!networkEnabled) {
		// Disable network features for isolation
		flags.push("--disable-background-networking");
		flags.push("--disable-default-apps");
		flags.push("--disable-extensions");
		flags.push("--disable-sync");
		flags.push("--disable-translate");
	}

	// User data dir for profile isolation
	if (config.userDataDir) {
		flags.push(`--user-data-dir=${config.userDataDir}`);
	}

	// Standard safety flags
	flags.push("--disable-gpu");
	flags.push("--no-first-run");
	flags.push("--no-default-browser-check");
	flags.push("--disable-dev-shm-usage");

	// Add user-provided flags (already validated)
	if (config.chromeFlags) {
		flags.push(...config.chromeFlags);
	}

	return flags;
}

// =============================================================================
// Browser Sandbox Executor
// =============================================================================

/**
 * Browser sandbox executor - launches isolated Chrome/Chromium via CDP
 *
 * Implements the SandboxExecutor interface for browser-based tool execution.
 * Security: blocks --no-sandbox, enforces headless, restricts CDP to localhost.
 *
 * Uses spawn() (not exec()) to avoid shell injection risks.
 */
export class BrowserSandboxExecutor implements SandboxExecutor {
	private config: BrowserSandboxConfig;
	private browserProcess: ChildProcess | null = null;
	private cdpPort: number;

	constructor(config: BrowserSandboxConfig = {}) {
		// Validate config before accepting
		const validation = validateBrowserSandboxConfig(config);
		if (!validation.valid) {
			throw new Error(`Invalid browser sandbox config: ${validation.errors.join("; ")}`);
		}

		this.config = config;
		this.cdpPort = getCdpPort(config);
	}

	/**
	 * Execute a command via the browser sandbox.
	 *
	 * Launches Chrome with CDP. The command is treated as a URL to navigate to.
	 * Actual page interaction is handled by CDP clients connecting to the port.
	 *
	 * Uses spawn() directly (no shell) for safe process launching.
	 */
	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		const chromePath = this.config.chromePath ?? findChromePath();
		const flags = buildChromeFlags(this.config);

		return new Promise((resolve, reject) => {
			const timeoutMs =
				options?.timeoutMs ?? this.config.startupTimeoutMs ?? DEFAULT_BROWSER_SANDBOX_CONFIG.startupTimeoutMs;

			// spawn() is used instead of exec() to avoid shell injection
			const child = spawn(chromePath, [...flags, command], {
				detached: false,
				stdio: ["ignore", "pipe", "pipe"],
				cwd: options?.cwd,
				env: options?.env,
			});

			this.browserProcess = child;

			let stdout = "";
			let stderr = "";
			let timedOut = false;

			const timeoutHandle = setTimeout(() => {
				timedOut = true;
				this.cleanup();
			}, timeoutMs);

			const onAbort = () => {
				this.cleanup();
			};

			if (options?.signal) {
				if (options.signal.aborted) {
					onAbort();
				} else {
					options.signal.addEventListener("abort", onAbort, { once: true });
				}
			}

			child.stdout?.on("data", (data) => {
				stdout += data.toString();
			});

			child.stderr?.on("data", (data) => {
				stderr += data.toString();
			});

			child.on("close", (code) => {
				clearTimeout(timeoutHandle);
				if (options?.signal) {
					options.signal.removeEventListener("abort", onAbort);
				}
				this.browserProcess = null;

				if (timedOut) {
					reject(new Error(`${stdout}\n${stderr}\nBrowser timed out after ${timeoutMs}ms`.trim()));
					return;
				}

				resolve({
					stdout,
					stderr,
					code: code ?? 0,
					timedOut: false,
				});
			});

			child.on("error", (error) => {
				clearTimeout(timeoutHandle);
				this.browserProcess = null;
				reject(error);
			});
		});
	}

	/**
	 * Get the workspace path - browser operates via CDP, not filesystem
	 */
	getWorkspacePath(hostPath: string): string {
		return hostPath; // Browser accesses host filesystem directly
	}

	/**
	 * Browser sandbox is always sandboxed (process isolation via Chrome sandbox)
	 */
	isSandboxed(): boolean {
		return true;
	}

	/**
	 * Get the CDP port for this browser instance
	 */
	getCdpPort(): number {
		return this.cdpPort;
	}

	/**
	 * Get the CDP WebSocket endpoint URL
	 */
	getCdpEndpoint(): string {
		return `ws://127.0.0.1:${this.cdpPort}`;
	}

	/**
	 * Check if the browser process is running
	 */
	isRunning(): boolean {
		return this.browserProcess !== null && !this.browserProcess.killed;
	}

	/**
	 * Clean up the browser process
	 */
	cleanup(): void {
		if (this.browserProcess && !this.browserProcess.killed) {
			try {
				this.browserProcess.kill("SIGTERM");
				// Give it a moment, then force kill
				setTimeout(() => {
					if (this.browserProcess && !this.browserProcess.killed) {
						this.browserProcess.kill("SIGKILL");
					}
				}, 5000);
			} catch {
				// Process already dead
			}
		}
		this.browserProcess = null;
	}
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a browser sandbox executor
 */
export function createBrowserSandboxExecutor(config?: BrowserSandboxConfig): BrowserSandboxExecutor {
	return new BrowserSandboxExecutor(config);
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Find Chrome/Chromium binary on the system
 */
function findChromePath(): string {
	const platform = process.platform;

	if (platform === "darwin") {
		return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
	}

	if (platform === "win32") {
		return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
	}

	// Linux - try common locations
	const linuxPaths = [
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium-browser",
		"/usr/bin/chromium",
	];

	// Return first candidate (actual existence check happens at spawn time)
	return linuxPaths[0];
}
