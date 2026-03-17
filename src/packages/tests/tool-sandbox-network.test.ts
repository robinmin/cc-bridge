/**
 * Tool Sandbox Network Isolation Tests
 *
 * Tests for network isolation configuration, validation, Docker arg generation,
 * preset configs, and security blocks.
 */

import { describe, expect, it } from "vitest";
import {
	FULL_NETWORK,
	ISOLATED_NETWORK,
	type NetworkIsolationConfig,
	networkConfigToDockerArgs,
	RESTRICTED_NETWORK,
	validateNetworkConfig,
} from "../agent/tools/sandbox/network";

// =============================================================================
// Preset Config Tests
// =============================================================================

describe("Network Isolation Presets", () => {
	describe("ISOLATED_NETWORK", () => {
		it("should use mode 'none'", () => {
			expect(ISOLATED_NETWORK.mode).toBe("none");
		});

		it("should have no allowed hosts or ports", () => {
			expect(ISOLATED_NETWORK.allowedHosts).toBeUndefined();
			expect(ISOLATED_NETWORK.allowedPorts).toBeUndefined();
		});
	});

	describe("RESTRICTED_NETWORK", () => {
		it("should use bridge mode", () => {
			expect(RESTRICTED_NETWORK.mode).toBe("bridge");
		});

		it("should allow only HTTP/HTTPS/DNS ports", () => {
			expect(RESTRICTED_NETWORK.allowedPorts).toEqual([53, 80, 443]);
		});

		it("should disable IPv6", () => {
			expect(RESTRICTED_NETWORK.enableIPv6).toBe(false);
		});
	});

	describe("FULL_NETWORK", () => {
		it("should use bridge mode", () => {
			expect(FULL_NETWORK.mode).toBe("bridge");
		});

		it("should not restrict ports", () => {
			expect(FULL_NETWORK.allowedPorts).toBeUndefined();
		});

		it("should not restrict hosts", () => {
			expect(FULL_NETWORK.allowedHosts).toBeUndefined();
		});
	});
});

// =============================================================================
// Validation Tests
// =============================================================================

describe("validateNetworkConfig", () => {
	describe("valid configurations", () => {
		it("should accept mode 'none'", () => {
			const result = validateNetworkConfig({ mode: "none" });
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		it("should accept mode 'bridge'", () => {
			const result = validateNetworkConfig({ mode: "bridge" });
			expect(result.valid).toBe(true);
		});

		it("should accept mode 'internal'", () => {
			const result = validateNetworkConfig({ mode: "internal" });
			expect(result.valid).toBe(true);
		});

		it("should accept mode 'custom'", () => {
			const result = validateNetworkConfig({ mode: "custom" });
			expect(result.valid).toBe(true);
		});

		it("should accept valid allowed hosts", () => {
			const result = validateNetworkConfig({
				mode: "bridge",
				allowedHosts: ["example.com", "192.168.1.1", "*.github.com"],
			});
			expect(result.valid).toBe(true);
		});

		it("should accept valid allowed ports", () => {
			const result = validateNetworkConfig({
				mode: "bridge",
				allowedPorts: [80, 443, 8080],
			});
			expect(result.valid).toBe(true);
		});

		it("should accept valid DNS servers", () => {
			const result = validateNetworkConfig({
				mode: "bridge",
				dnsServers: ["8.8.8.8", "1.1.1.1"],
			});
			expect(result.valid).toBe(true);
		});

		it("should accept all presets as valid", () => {
			expect(validateNetworkConfig(ISOLATED_NETWORK).valid).toBe(true);
			expect(validateNetworkConfig(RESTRICTED_NETWORK).valid).toBe(true);
			expect(validateNetworkConfig(FULL_NETWORK).valid).toBe(true);
		});
	});

	describe("security blocks", () => {
		it("should block host network mode", () => {
			const result = validateNetworkConfig({ mode: "host" as unknown as "none" });
			expect(result.valid).toBe(false);
			expect(result.errors[0].field).toBe("networkIsolation.mode");
			expect(result.errors[0].message).toContain("Host network mode");
		});

		it("should reject unknown mode values", () => {
			const result = validateNetworkConfig({ mode: "macvlan" as unknown as "none" });
			expect(result.valid).toBe(false);
			expect(result.errors[0].message).toContain("Unknown network isolation mode");
		});
	});

	describe("invalid hosts", () => {
		it("should reject empty host entries", () => {
			const result = validateNetworkConfig({
				mode: "bridge",
				allowedHosts: [""],
			});
			expect(result.valid).toBe(false);
			expect(result.errors[0].field).toBe("networkIsolation.allowedHosts");
		});

		it("should reject host entries with invalid characters", () => {
			const result = validateNetworkConfig({
				mode: "bridge",
				allowedHosts: ["example.com; rm -rf /"],
			});
			expect(result.valid).toBe(false);
			expect(result.errors[0].field).toBe("networkIsolation.allowedHosts");
		});
	});

	describe("invalid ports", () => {
		it("should reject port 0", () => {
			const result = validateNetworkConfig({
				mode: "bridge",
				allowedPorts: [0],
			});
			expect(result.valid).toBe(false);
			expect(result.errors[0].field).toBe("networkIsolation.allowedPorts");
		});

		it("should reject negative ports", () => {
			const result = validateNetworkConfig({
				mode: "bridge",
				allowedPorts: [-1],
			});
			expect(result.valid).toBe(false);
		});

		it("should reject ports above 65535", () => {
			const result = validateNetworkConfig({
				mode: "bridge",
				allowedPorts: [70000],
			});
			expect(result.valid).toBe(false);
		});

		it("should reject non-integer ports", () => {
			const result = validateNetworkConfig({
				mode: "bridge",
				allowedPorts: [80.5],
			});
			expect(result.valid).toBe(false);
		});
	});

	describe("invalid DNS servers", () => {
		it("should reject empty DNS entries", () => {
			const result = validateNetworkConfig({
				mode: "bridge",
				dnsServers: [""],
			});
			expect(result.valid).toBe(false);
			expect(result.errors[0].field).toBe("networkIsolation.dnsServers");
		});

		it("should reject DNS entries with invalid characters", () => {
			const result = validateNetworkConfig({
				mode: "bridge",
				dnsServers: ["8.8.8.8 && echo pwned"],
			});
			expect(result.valid).toBe(false);
		});
	});

	describe("warnings", () => {
		it("should warn about allowedHosts in 'none' mode", () => {
			const result = validateNetworkConfig({
				mode: "none",
				allowedHosts: ["example.com"],
			});
			expect(result.valid).toBe(true);
			expect(result.warnings.some((w) => w.includes("allowedHosts is ignored"))).toBe(true);
		});

		it("should warn about allowedPorts in 'none' mode", () => {
			const result = validateNetworkConfig({
				mode: "none",
				allowedPorts: [80],
			});
			expect(result.valid).toBe(true);
			expect(result.warnings.some((w) => w.includes("allowedPorts is ignored"))).toBe(true);
		});

		it("should warn about dnsServers in 'none' mode", () => {
			const result = validateNetworkConfig({
				mode: "none",
				dnsServers: ["8.8.8.8"],
			});
			expect(result.valid).toBe(true);
			expect(result.warnings.some((w) => w.includes("dnsServers is ignored"))).toBe(true);
		});

		it("should warn about unrestricted bridge mode", () => {
			const result = validateNetworkConfig({ mode: "bridge" });
			expect(result.warnings.some((w) => w.includes("all outbound traffic"))).toBe(true);
		});

		it("should not warn about bridge with port restrictions", () => {
			const result = validateNetworkConfig({
				mode: "bridge",
				allowedPorts: [443],
			});
			expect(result.warnings.some((w) => w.includes("all outbound traffic"))).toBe(false);
		});
	});
});

// =============================================================================
// Docker Argument Generation Tests
// =============================================================================

describe("networkConfigToDockerArgs", () => {
	describe("network mode", () => {
		it("should generate --network none for isolated mode", () => {
			const args = networkConfigToDockerArgs({ mode: "none" });
			expect(args).toContain("--network");
			expect(args[args.indexOf("--network") + 1]).toBe("none");
		});

		it("should generate --network bridge for bridge mode", () => {
			const args = networkConfigToDockerArgs({ mode: "bridge" });
			expect(args).toContain("--network");
			expect(args[args.indexOf("--network") + 1]).toBe("bridge");
		});

		it("should generate --network internal for internal mode", () => {
			const args = networkConfigToDockerArgs({ mode: "internal" });
			expect(args).toContain("--network");
			expect(args[args.indexOf("--network") + 1]).toBe("internal");
		});

		it("should generate --network bridge for custom mode", () => {
			const args = networkConfigToDockerArgs({ mode: "custom" });
			expect(args).toContain("--network");
			expect(args[args.indexOf("--network") + 1]).toBe("bridge");
		});
	});

	describe("DNS servers", () => {
		it("should generate --dns flags for DNS servers", () => {
			const args = networkConfigToDockerArgs({
				mode: "bridge",
				dnsServers: ["8.8.8.8", "1.1.1.1"],
			});
			const dnsIndices = args.reduce<number[]>((acc, arg, i) => {
				if (arg === "--dns") acc.push(i);
				return acc;
			}, []);
			expect(dnsIndices).toHaveLength(2);
			expect(args[dnsIndices[0] + 1]).toBe("8.8.8.8");
			expect(args[dnsIndices[1] + 1]).toBe("1.1.1.1");
		});

		it("should not generate --dns flags for 'none' mode", () => {
			const args = networkConfigToDockerArgs({
				mode: "none",
				dnsServers: ["8.8.8.8"],
			});
			expect(args).not.toContain("--dns");
		});
	});

	describe("allowed hosts", () => {
		it("should generate --add-host flags for allowed hosts", () => {
			const args = networkConfigToDockerArgs({
				mode: "bridge",
				allowedHosts: ["example.com", "api.github.com"],
			});
			const addHostIndices = args.reduce<number[]>((acc, arg, i) => {
				if (arg === "--add-host") acc.push(i);
				return acc;
			}, []);
			expect(addHostIndices).toHaveLength(2);
			expect(args[addHostIndices[0] + 1]).toBe("example.com:0.0.0.0");
			expect(args[addHostIndices[1] + 1]).toBe("api.github.com:0.0.0.0");
		});

		it("should not generate --add-host flags for 'none' mode", () => {
			const args = networkConfigToDockerArgs({
				mode: "none",
				allowedHosts: ["example.com"],
			});
			expect(args).not.toContain("--add-host");
		});
	});

	describe("IPv6", () => {
		it("should generate sysctl to disable IPv6 when enableIPv6 is false", () => {
			const args = networkConfigToDockerArgs({
				mode: "bridge",
				enableIPv6: false,
			});
			expect(args).toContain("--sysctl");
			expect(args).toContain("net.ipv6.conf.all.disable_ipv6=1");
		});

		it("should not generate sysctl when enableIPv6 is true", () => {
			const args = networkConfigToDockerArgs({
				mode: "bridge",
				enableIPv6: true,
			});
			expect(args).not.toContain("--sysctl");
		});

		it("should not generate sysctl when enableIPv6 is undefined", () => {
			const args = networkConfigToDockerArgs({ mode: "bridge" });
			expect(args).not.toContain("--sysctl");
		});

		it("should not generate IPv6 sysctl for 'none' mode", () => {
			const args = networkConfigToDockerArgs({
				mode: "none",
				enableIPv6: false,
			});
			expect(args).not.toContain("--sysctl");
		});
	});

	describe("preset Docker args", () => {
		it("should generate minimal args for ISOLATED_NETWORK", () => {
			const args = networkConfigToDockerArgs(ISOLATED_NETWORK);
			expect(args).toEqual(["--network", "none"]);
		});

		it("should generate args with port restrictions for RESTRICTED_NETWORK", () => {
			const args = networkConfigToDockerArgs(RESTRICTED_NETWORK);
			expect(args).toContain("--network");
			expect(args).toContain("--sysctl");
			expect(args).toContain("net.ipv6.conf.all.disable_ipv6=1");
		});

		it("should generate bridge args for FULL_NETWORK", () => {
			const args = networkConfigToDockerArgs(FULL_NETWORK);
			expect(args).toEqual(["--network", "bridge"]);
		});
	});

	describe("combined configuration", () => {
		it("should generate all flags for a fully specified config", () => {
			const config: NetworkIsolationConfig = {
				mode: "custom",
				allowedHosts: ["api.example.com"],
				dnsServers: ["8.8.8.8"],
				enableIPv6: false,
			};
			const args = networkConfigToDockerArgs(config);

			expect(args).toContain("--network");
			expect(args).toContain("--dns");
			expect(args).toContain("--add-host");
			expect(args).toContain("--sysctl");
		});
	});
});

// =============================================================================
// Integration with ToolSandboxDockerSettings
// =============================================================================

describe("ToolSandboxDockerSettings integration", () => {
	it("should accept networkIsolation field in docker settings type", () => {
		// Type-level test: this should compile without error
		const settings: import("../agent/tools/sandbox/config").ToolSandboxDockerSettings = {
			network: "bridge",
			networkIsolation: {
				mode: "bridge",
				allowedPorts: [443],
				dnsServers: ["8.8.8.8"],
			},
		};
		expect(settings.networkIsolation).toBeDefined();
		expect(settings.networkIsolation?.mode).toBe("bridge");
		expect(settings.networkIsolation?.allowedPorts).toEqual([443]);
	});

	it("should allow networkIsolation without legacy network field", () => {
		const settings: import("../agent/tools/sandbox/config").ToolSandboxDockerSettings = {
			networkIsolation: RESTRICTED_NETWORK,
		};
		expect(settings.network).toBeUndefined();
		expect(settings.networkIsolation).toBeDefined();
	});
});
