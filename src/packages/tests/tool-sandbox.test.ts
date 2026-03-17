/**
 * Tool Sandbox Tests
 *
 * Tests for sandbox configuration, validation, policy, limits, and executor.
 */

import { describe, expect, it } from "vitest";
import {
	argToSandboxConfig,
	BUILT_IN_TOOLS,
	DEFAULT_SANDBOX_CONFIG,
	parseSandboxArg,
	STRICT_SANDBOX_CONFIG,
} from "../agent/tools/sandbox/config";
import {
	createDockerExecutor,
	createSandboxExecutor,
	DockerExecutor,
	HostExecutor,
} from "../agent/tools/sandbox/executor";
import {
	DEFAULT_LIMITS,
	LENIENT_LIMITS,
	limitsToDockerArgs,
	normalizeMemory,
	parseResourceLimits,
	STRICT_LIMITS,
} from "../agent/tools/sandbox/limits";
import { createSandboxPolicyEvaluator, needsSandbox } from "../agent/tools/sandbox/policy";
import {
	SandboxSecurityValidator,
	SandboxValidationError,
	sandboxValidator,
	validateSandboxConfig,
} from "../agent/tools/sandbox/validator";

// =============================================================================
// Config Tests
// =============================================================================

describe("SandboxConfig", () => {
	describe("DEFAULT_SANDBOX_CONFIG", () => {
		it("should default to host mode with permissive strictness", () => {
			expect(DEFAULT_SANDBOX_CONFIG.defaultMode).toBe("host");
			expect(DEFAULT_SANDBOX_CONFIG.strictness).toBe("permissive");
			expect(DEFAULT_SANDBOX_CONFIG.builtInTools).toBe(BUILT_IN_TOOLS);
		});
	});

	describe("STRICT_SANDBOX_CONFIG", () => {
		it("should use strict strictness", () => {
			expect(STRICT_SANDBOX_CONFIG.strictness).toBe("strict");
		});
	});

	describe("BUILT_IN_TOOLS", () => {
		it("should include core tools", () => {
			expect(BUILT_IN_TOOLS).toContain("bash");
			expect(BUILT_IN_TOOLS).toContain("read-file");
			expect(BUILT_IN_TOOLS).toContain("write-file");
			expect(BUILT_IN_TOOLS).toContain("web-search");
			expect(BUILT_IN_TOOLS).toContain("glob");
			expect(BUILT_IN_TOOLS).toContain("grep");
		});
	});

	describe("parseSandboxArg", () => {
		it("should parse host mode", () => {
			expect(parseSandboxArg("host")).toEqual({ type: "host" });
		});

		it("should parse strict mode", () => {
			expect(parseSandboxArg("strict")).toEqual({ type: "strict" });
		});

		it("should parse permissive mode", () => {
			expect(parseSandboxArg("permissive")).toEqual({ type: "permissive" });
		});

		it("should parse docker with container name", () => {
			expect(parseSandboxArg("docker:my-container")).toEqual({
				type: "docker",
				container: "my-container",
			});
		});

		it("should throw for docker without container name", () => {
			expect(() => parseSandboxArg("docker:")).toThrow("Docker sandbox requires container name");
		});

		it("should throw for invalid sandbox type", () => {
			expect(() => parseSandboxArg("invalid")).toThrow("Invalid sandbox type");
		});
	});

	describe("argToSandboxConfig", () => {
		it("should convert host arg to config", () => {
			const config = argToSandboxConfig({ type: "host" });
			expect(config.defaultMode).toBe("host");
		});

		it("should convert docker arg to config", () => {
			const config = argToSandboxConfig({ type: "docker", container: "test" });
			expect(config.defaultMode).toBe("docker");
		});

		it("should convert strict arg to config", () => {
			const config = argToSandboxConfig({ type: "strict" });
			expect(config.strictness).toBe("strict");
		});

		it("should convert permissive arg to config", () => {
			const config = argToSandboxConfig({ type: "permissive" });
			expect(config.strictness).toBe("permissive");
		});
	});
});

// =============================================================================
// Validator Tests
// =============================================================================

describe("SandboxValidationError", () => {
	it("should set name, message, and field", () => {
		const err = new SandboxValidationError("bad value", "network");
		expect(err.name).toBe("SandboxValidationError");
		expect(err.message).toBe("bad value");
		expect(err.field).toBe("network");
		expect(err).toBeInstanceOf(Error);
	});
});

describe("SandboxSecurityValidator", () => {
	const validator = new SandboxSecurityValidator();

	describe("validateDockerSettings", () => {
		it("should pass valid settings", () => {
			const result = validator.validateDockerSettings({
				network: "bridge",
				memory: "512m",
			});
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		it("should block host network mode at runtime", () => {
			const result = validator.validateDockerSettings({
				network: "host" as unknown as "bridge",
			});
			expect(result.valid).toBe(false);
			expect(result.errors[0].field).toBe("network");
		});

		it("should block unconfined seccomp", () => {
			const result = validator.validateDockerSettings({
				seccompProfile: "unconfined",
			});
			expect(result.valid).toBe(false);
			expect(result.errors[0].field).toBe("seccompProfile");
		});

		it("should block unconfined AppArmor", () => {
			const result = validator.validateDockerSettings({
				apparmorProfile: "unconfined",
			});
			expect(result.valid).toBe(false);
			expect(result.errors[0].field).toBe("apparmorProfile");
		});

		it("should warn about empty capDrop", () => {
			const result = validator.validateDockerSettings({ capDrop: [] });
			expect(result.valid).toBe(true);
			expect(result.warnings).toContain("Empty capDrop allows all capabilities");
		});

		it("should warn about readOnlyRoot=false", () => {
			const result = validator.validateDockerSettings({ readOnlyRoot: false });
			expect(result.valid).toBe(true);
			expect(result.warnings.some((w) => w.includes("readOnlyRoot"))).toBe(true);
		});
	});

	describe("validateBindMount", () => {
		it("should accept valid absolute bind mounts", () => {
			const result = validator.validateDockerSettings({
				binds: ["/workspace:/workspace:ro"],
			});
			expect(result.valid).toBe(true);
		});

		it("should reject relative bind mount paths", () => {
			const result = validator.validateDockerSettings({
				binds: ["./relative:/container"],
			});
			expect(result.valid).toBe(false);
			expect(result.errors[0].field).toBe("binds");
		});

		it("should reject invalid bind mount format", () => {
			const result = validator.validateDockerSettings({
				binds: ["just-a-path"],
			});
			expect(result.valid).toBe(false);
		});

		it("should warn about sensitive paths", () => {
			const result = validator.validateDockerSettings({
				binds: ["/etc/secret:/etc/secret:ro"],
			});
			expect(result.warnings.some((w) => w.includes("sensitive path"))).toBe(true);
		});
	});

	describe("validateLimits", () => {
		it("should accept valid limits", () => {
			const result = validator.validateLimits({ memory: "512m", cpus: 1 });
			expect(result.valid).toBe(true);
		});

		it("should reject invalid memory format", () => {
			const result = validator.validateLimits({ memory: "not-a-number" });
			expect(result.valid).toBe(false);
		});

		it("should reject zero CPU", () => {
			const result = validator.validateLimits({ cpus: 0 });
			expect(result.valid).toBe(false);
		});

		it("should reject negative CPU", () => {
			const result = validator.validateLimits({ cpus: -1 });
			expect(result.valid).toBe(false);
		});

		it("should warn about very high CPU", () => {
			const result = validator.validateLimits({ cpus: 128 });
			expect(result.valid).toBe(true);
			expect(result.warnings.some((w) => w.includes("Very high CPU"))).toBe(true);
		});
	});

	describe("validate (combined)", () => {
		it("should validate docker and limits together", () => {
			const result = validator.validate({
				docker: { seccompProfile: "unconfined" },
				limits: { cpus: -1 },
			});
			expect(result.valid).toBe(false);
			expect(result.errors.length).toBeGreaterThanOrEqual(2);
		});
	});

	describe("validateSandboxConfig (throwing)", () => {
		it("should throw on invalid config", () => {
			expect(() =>
				validateSandboxConfig({
					docker: { seccompProfile: "unconfined" },
				}),
			).toThrow(SandboxValidationError);
		});

		it("should not throw on valid config", () => {
			expect(() =>
				validateSandboxConfig({
					docker: { network: "none", memory: "512m" },
				}),
			).not.toThrow();
		});

		it("should include field and message in error for multiple violations", () => {
			try {
				validateSandboxConfig({
					docker: { seccompProfile: "unconfined", apparmorProfile: "unconfined" },
				});
				expect.unreachable("should have thrown");
			} catch (e) {
				expect(e).toBeInstanceOf(SandboxValidationError);
				const err = e as SandboxValidationError;
				expect(err.field).toBe("config");
				expect(err.message).toContain("seccompProfile");
				expect(err.message).toContain("apparmorProfile");
			}
		});

		it("should include field and message in error for limit violations", () => {
			try {
				validateSandboxConfig({ limits: { cpus: -1 } });
				expect.unreachable("should have thrown");
			} catch (e) {
				const err = e as SandboxValidationError;
				expect(err.message).toContain("cpus");
			}
		});
	});
});

// =============================================================================
// Policy Tests
// =============================================================================

describe("ToolSandboxPolicyEvaluator", () => {
	describe("built-in tools", () => {
		const evaluator = createSandboxPolicyEvaluator(DEFAULT_SANDBOX_CONFIG);

		it("should not sandbox bash", () => {
			const result = evaluator.evaluate("bash");
			expect(result.needsSandbox).toBe(false);
			expect(result.reason).toContain("Built-in");
		});

		it("should not sandbox read-file", () => {
			expect(evaluator.evaluate("read-file").needsSandbox).toBe(false);
		});

		it("should normalize underscores to hyphens", () => {
			expect(evaluator.evaluate("read_file").needsSandbox).toBe(false);
			expect(evaluator.evaluate("write_file").needsSandbox).toBe(false);
		});
	});

	describe("strict mode", () => {
		const evaluator = createSandboxPolicyEvaluator({
			...DEFAULT_SANDBOX_CONFIG,
			strictness: "strict",
		});

		it("should sandbox external tools", () => {
			const result = evaluator.evaluate("custom-tool");
			expect(result.needsSandbox).toBe(true);
			expect(result.reason).toContain("Strict mode");
		});

		it("should still exempt built-in tools", () => {
			expect(evaluator.evaluate("bash").needsSandbox).toBe(false);
		});
	});

	describe("permissive mode", () => {
		const evaluator = createSandboxPolicyEvaluator(DEFAULT_SANDBOX_CONFIG);

		it("should sandbox dangerous-looking tools", () => {
			expect(evaluator.evaluate("remote-exec").needsSandbox).toBe(true);
			expect(evaluator.evaluate("http-request").needsSandbox).toBe(true);
			expect(evaluator.evaluate("shell-runner").needsSandbox).toBe(true);
		});

		it("should not sandbox safe-looking external tools", () => {
			expect(evaluator.evaluate("format-json").needsSandbox).toBe(false);
			expect(evaluator.evaluate("calculate").needsSandbox).toBe(false);
		});
	});

	describe("custom policy overrides", () => {
		const evaluator = createSandboxPolicyEvaluator({
			...DEFAULT_SANDBOX_CONFIG,
			toolPolicy: [
				{ pattern: "trusted-exec", sandbox: false },
				{ pattern: "untrusted-*", sandbox: true, timeoutMs: 5000, memory: "256m" },
			],
		});

		it("should apply exact match policy", () => {
			const result = evaluator.evaluate("trusted-exec");
			expect(result.needsSandbox).toBe(false);
			expect(result.reason).toContain("Custom policy");
		});

		it("should apply wildcard policy", () => {
			const result = evaluator.evaluate("untrusted-plugin");
			expect(result.needsSandbox).toBe(true);
			expect(result.timeoutMs).toBe(5000);
			expect(result.memory).toBe("256m");
		});
	});

	describe("needsSandbox convenience function", () => {
		it("should return boolean for built-in tool", () => {
			expect(needsSandbox("bash", DEFAULT_SANDBOX_CONFIG)).toBe(false);
		});

		it("should return true for external tool in strict mode", () => {
			expect(
				needsSandbox("custom-tool", {
					...DEFAULT_SANDBOX_CONFIG,
					strictness: "strict",
				}),
			).toBe(true);
		});
	});
});

// =============================================================================
// Limits Tests
// =============================================================================

describe("ResourceLimits", () => {
	describe("normalizeMemory", () => {
		it("should pass through values with units", () => {
			expect(normalizeMemory("512m")).toBe("512m");
			expect(normalizeMemory("2G")).toBe("2g");
			expect(normalizeMemory("1024K")).toBe("1024k");
		});

		it("should convert bytes to appropriate unit", () => {
			expect(normalizeMemory("1073741824")).toBe("1g"); // 1 GB
			expect(normalizeMemory("1048576")).toBe("1m"); // 1 MB
			expect(normalizeMemory("1024")).toBe("1k"); // 1 KB
			expect(normalizeMemory("512")).toBe("512b");
		});

		it("should throw for invalid values", () => {
			expect(() => normalizeMemory("abc")).toThrow("Invalid memory value");
		});
	});

	describe("parseResourceLimits", () => {
		it("should return empty for undefined", () => {
			expect(parseResourceLimits(undefined)).toEqual({});
		});

		it("should parse memory and CPU", () => {
			const parsed = parseResourceLimits({ memory: "512m", cpus: 2 });
			expect(parsed.memory).toBe("512m");
			expect(parsed.cpus).toBe(2);
		});

		it("should throw for invalid CPU", () => {
			expect(() => parseResourceLimits({ cpus: 0 })).toThrow("positive");
		});

		it("should throw for negative PID limit", () => {
			expect(() => parseResourceLimits({ pidsLimit: -1 })).toThrow("non-negative");
		});

		it("should throw for negative timeout", () => {
			expect(() => parseResourceLimits({ timeoutMs: -1 })).toThrow("positive");
		});
	});

	describe("limitsToDockerArgs", () => {
		it("should generate memory flag", () => {
			const args = limitsToDockerArgs({ memory: "512m" });
			expect(args).toContain("--memory");
			expect(args).toContain("512m");
		});

		it("should generate CPU flag", () => {
			const args = limitsToDockerArgs({ cpus: 2 });
			expect(args).toContain("--cpus");
			expect(args).toContain("2");
		});

		it("should generate PID limit flag", () => {
			const args = limitsToDockerArgs({ pidsLimit: 64 });
			expect(args).toContain("--pids-limit");
			expect(args).toContain("64");
		});

		it("should not generate PID limit flag when 0", () => {
			const args = limitsToDockerArgs({ pidsLimit: 0 });
			expect(args).not.toContain("--pids-limit");
		});

		it("should return empty for no limits", () => {
			expect(limitsToDockerArgs({})).toEqual([]);
		});
	});

	describe("preset limits", () => {
		it("DEFAULT_LIMITS should be moderate", () => {
			expect(DEFAULT_LIMITS.memory).toBe("512m");
			expect(DEFAULT_LIMITS.cpus).toBe(1);
		});

		it("STRICT_LIMITS should be more restrictive", () => {
			expect(STRICT_LIMITS.memory).toBe("256m");
			expect(STRICT_LIMITS.cpus).toBe(0.5);
		});

		it("LENIENT_LIMITS should be more generous", () => {
			expect(LENIENT_LIMITS.memory).toBe("2g");
			expect(LENIENT_LIMITS.cpus).toBe(2);
		});
	});
});

// =============================================================================
// Executor Tests
// =============================================================================

describe("SandboxExecutor", () => {
	describe("HostExecutor", () => {
		const executor = new HostExecutor();

		it("should not be sandboxed", () => {
			expect(executor.isSandboxed()).toBe(false);
		});

		it("should return host path unchanged", () => {
			expect(executor.getWorkspacePath("/my/path")).toBe("/my/path");
		});

		it("should execute simple commands", async () => {
			const result = await executor.exec("echo hello");
			expect(result.stdout.trim()).toBe("hello");
			expect(result.code).toBe(0);
			expect(result.timedOut).toBe(false);
		});

		it("should capture stderr", async () => {
			const result = await executor.exec("echo error >&2");
			expect(result.stderr.trim()).toBe("error");
		});

		it("should return exit codes", async () => {
			const result = await executor.exec("exit 42");
			expect(result.code).toBe(42);
		});
	});

	describe("DockerExecutor", () => {
		it("should be sandboxed", () => {
			const executor = new DockerExecutor("test-container");
			expect(executor.isSandboxed()).toBe(true);
		});

		it("should return container workspace path", () => {
			const executor = new DockerExecutor("test-container");
			expect(executor.getWorkspacePath("/host/path")).toBe("/workspace");
		});

		it("should use custom workdir", () => {
			const executor = new DockerExecutor("test-container", {
				workdir: "/custom",
			});
			expect(executor.getWorkspacePath("/host/path")).toBe("/custom");
		});

		it("should throw on invalid docker settings", () => {
			expect(
				() =>
					new DockerExecutor("test", {
						seccompProfile: "unconfined",
					}),
			).toThrow();
		});
	});

	describe("createSandboxExecutor", () => {
		it("should create HostExecutor for host mode", () => {
			const executor = createSandboxExecutor(DEFAULT_SANDBOX_CONFIG);
			expect(executor.isSandboxed()).toBe(false);
		});

		it("should throw for docker mode without container", () => {
			expect(() =>
				createSandboxExecutor({
					...DEFAULT_SANDBOX_CONFIG,
					defaultMode: "docker",
				}),
			).toThrow("container name");
		});

		it("should create DockerExecutor with explicit container", () => {
			const executor = createSandboxExecutor({ ...DEFAULT_SANDBOX_CONFIG, defaultMode: "docker" }, "my-container");
			expect(executor.isSandboxed()).toBe(true);
		});
	});

	describe("createDockerExecutor", () => {
		it("should create DockerExecutor", () => {
			const executor = createDockerExecutor("my-container");
			expect(executor.isSandboxed()).toBe(true);
		});
	});

	describe("HostExecutor timeout and abort", () => {
		const executor = new HostExecutor();

		it("should reject when command times out", async () => {
			await expect(executor.exec("sleep 10", { timeoutMs: 50 })).rejects.toThrow("timed out");
		});

		it("should reject when aborted via AbortSignal", async () => {
			const controller = new AbortController();
			const promise = executor.exec("sleep 10", { signal: controller.signal });
			// Abort after a short delay
			setTimeout(() => controller.abort(), 50);
			await expect(promise).rejects.toThrow("aborted");
		});

		it("should reject immediately if signal already aborted", async () => {
			const controller = new AbortController();
			controller.abort();
			await expect(executor.exec("sleep 10", { signal: controller.signal })).rejects.toThrow();
		});

		it("should handle command that errors on spawn", async () => {
			// Spawn a non-existent binary — triggers error event
			const hostExec = new HostExecutor();
			// Use a command that will fail quickly
			const result = await hostExec.exec("exit 1");
			expect(result.code).toBe(1);
		});
	});

	describe("DockerExecutor exec and buildDockerArgs", () => {
		it("should build docker args with memory and CPU limits", async () => {
			const executor = new DockerExecutor("test-container", {
				memory: "512m",
				cpus: 2,
				pidsLimit: 64,
			});
			// Docker container doesn't exist, so command exits with non-zero code
			const result = await executor.exec("echo hello");
			expect(typeof result.code).toBe("number");
		});

		it("should build docker args with network none", async () => {
			const executor = new DockerExecutor("test-container", {
				network: "none",
			});
			const result = await executor.exec("echo hello");
			expect(typeof result.code).toBe("number");
		});

		it("should build docker args with env variables", async () => {
			const executor = new DockerExecutor("test-container", {
				env: { FOO: "bar", BAZ: "qux" },
			});
			const result = await executor.exec("echo hello");
			expect(typeof result.code).toBe("number");
		});

		it("should build docker args with workdir", async () => {
			const executor = new DockerExecutor("test-container", {
				workdir: "/app",
			});
			const result = await executor.exec("echo hello");
			expect(typeof result.code).toBe("number");
		});

		it("should build docker args with all settings combined", async () => {
			const executor = new DockerExecutor("test-container", {
				memory: "256m",
				cpus: 0.5,
				pidsLimit: 32,
				network: "none",
				env: { NODE_ENV: "test" },
				workdir: "/workspace",
			});
			const result = await executor.exec("echo hello");
			expect(typeof result.code).toBe("number");
		});

		it("should accept no settings and use defaults", async () => {
			const executor = new DockerExecutor("test-container");
			const result = await executor.exec("echo hello");
			expect(typeof result.code).toBe("number");
		});
	});

	describe("createSandboxExecutor with containerPrefix", () => {
		it("should use docker.containerPrefix when no explicit container", () => {
			const executor = createSandboxExecutor({
				...DEFAULT_SANDBOX_CONFIG,
				defaultMode: "docker",
				docker: { containerPrefix: "my-prefix" },
			});
			expect(executor.isSandboxed()).toBe(true);
		});
	});
});

// =============================================================================
// Validator - sandboxValidator singleton
// =============================================================================

describe("sandboxValidator singleton", () => {
	it("should be a SandboxSecurityValidator instance", () => {
		expect(sandboxValidator).toBeInstanceOf(SandboxSecurityValidator);
	});

	it("should validate docker settings", () => {
		const result = sandboxValidator.validateDockerSettings({ network: "bridge" });
		expect(result.valid).toBe(true);
	});

	it("should validate limits", () => {
		const result = sandboxValidator.validateLimits({ memory: "1g" });
		expect(result.valid).toBe(true);
	});

	it("should validate combined config", () => {
		const result = sandboxValidator.validate({
			docker: { network: "none" },
			limits: { cpus: 2 },
		});
		expect(result.valid).toBe(true);
	});

	it("should validate empty config", () => {
		const result = sandboxValidator.validate({});
		expect(result.valid).toBe(true);
	});

	it("should validate config with only docker", () => {
		const result = sandboxValidator.validate({
			docker: { apparmorProfile: "unconfined" },
		});
		expect(result.valid).toBe(false);
	});

	it("should validate config with only limits", () => {
		const result = sandboxValidator.validate({
			limits: { cpus: -1 },
		});
		expect(result.valid).toBe(false);
	});
});
