import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
	applyToolPolicy,
	ChatToolPolicy,
	createReadOnlyPolicyPipeline,
	createToolPolicyPipeline,
	GlobalToolPolicy,
	ToolGranularPolicy,
	type ToolPolicyConfig,
	ToolPolicyPipeline,
} from "@/gateway/engine/tools/policy";

describe("tools/policy", () => {
	describe("GlobalToolPolicy", () => {
		test("allows all tools by default", () => {
			const policy = new GlobalToolPolicy();
			const tool = { name: "any_tool", label: "Any", description: "test", parameters: {} };
			const result = policy.evaluate("any_tool", tool as AgentTool);
			expect(result).toBeNull();
		});

		test("denies tools in deny list", () => {
			const policy = new GlobalToolPolicy({ deniedTools: ["bash", "exec"] });
			const tool = { name: "bash", label: "Bash", description: "test", parameters: {} };
			const result = policy.evaluate("bash", tool as AgentTool);
			expect(result).not.toBeNull();
			expect(result?.action).toBe("deny");
		});

		test("allows tools in allow list", () => {
			const policy = new GlobalToolPolicy({ allowedTools: ["read_file", "web_search"] });
			const tool = { name: "read_file", label: "Read", description: "test", parameters: {} };
			const result = policy.evaluate("read_file", tool as AgentTool);
			expect(result).toBeNull();
		});

		test("denies tools not in allow list", () => {
			const policy = new GlobalToolPolicy({ allowedTools: ["read_file"] });
			const tool = { name: "bash", label: "Bash", description: "test", parameters: {} };
			const result = policy.evaluate("bash", tool as AgentTool);
			expect(result).not.toBeNull();
			expect(result?.action).toBe("deny");
		});

		test("deny list takes precedence over allow list", () => {
			const policy = new GlobalToolPolicy({ allowedTools: ["*"], deniedTools: ["bash"] });
			const tool = { name: "bash", label: "Bash", description: "test", parameters: {} };
			expect(policy.evaluate("bash", tool as AgentTool)?.action).toBe("deny");
		});

		test("supports glob patterns in allowed tools", () => {
			const policy = new GlobalToolPolicy({ allowedTools: ["read_*", "write_*"] });
			const tool = { name: "read_file", label: "Read", description: "test", parameters: {} };
			expect(policy.evaluate("read_file", tool as AgentTool)).toBeNull();
			expect(policy.evaluate("write_file", tool as AgentTool)).toBeNull();
			const tool2 = { name: "bash", label: "Bash", description: "test", parameters: {} };
			expect(policy.evaluate("bash", tool2 as AgentTool)).not.toBeNull();
		});

		test("supports ** glob pattern", () => {
			const policy = new GlobalToolPolicy({ allowedTools: ["**"] });
			const tool = { name: "any/tool", label: "Test", description: "test", parameters: {} };
			expect(policy.evaluate("any/tool", tool as AgentTool)).toBeNull();
		});

		test("supports ? wildcard", () => {
			const policy = new GlobalToolPolicy({ allowedTools: ["rea?_file"] });
			const tool1 = { name: "read_file", label: "Read", description: "test", parameters: {} };
			const tool2 = { name: "reax_file", label: "Read", description: "test", parameters: {} };
			expect(policy.evaluate("read_file", tool1 as AgentTool)).toBeNull();
			expect(policy.evaluate("reax_file", tool2 as AgentTool)).toBeNull();
			const tool3 = { name: "reaad_file", label: "Read", description: "test", parameters: {} };
			expect(policy.evaluate("reaad_file", tool3 as AgentTool)).not.toBeNull();
		});

		test("priority is 10", () => {
			const policy = new GlobalToolPolicy();
			expect(policy.priority).toBe(10);
		});

		test("loads allowed tools from environment variable", () => {
			const original = process.env.ALLOWED_TOOLS;
			process.env.ALLOWED_TOOLS = "read_file, write_file";
			try {
				const policy = new GlobalToolPolicy();
				const tool1 = { name: "read_file", label: "Read", description: "test", parameters: {} };
				const tool2 = { name: "write_file", label: "Write", description: "test", parameters: {} };
				const tool3 = { name: "bash", label: "Bash", description: "test", parameters: {} };
				expect(policy.evaluate("read_file", tool1 as AgentTool)).toBeNull();
				expect(policy.evaluate("write_file", tool2 as AgentTool)).toBeNull();
				expect(policy.evaluate("bash", tool3 as AgentTool)).not.toBeNull();
			} finally {
				if (original !== undefined) {
					process.env.ALLOWED_TOOLS = original;
				} else {
					delete process.env.ALLOWED_TOOLS;
				}
			}
		});

		test("loads denied tools from environment variable", () => {
			const original = process.env.DENIED_TOOLS;
			process.env.DENIED_TOOLS = "bash, exec";
			try {
				const policy = new GlobalToolPolicy();
				const tool = { name: "bash", label: "Bash", description: "test", parameters: {} };
				expect(policy.evaluate("bash", tool as AgentTool)?.action).toBe("deny");
			} finally {
				if (original !== undefined) {
					process.env.DENIED_TOOLS = original;
				} else {
					delete process.env.DENIED_TOOLS;
				}
			}
		});

		test("config takes precedence over environment variable", () => {
			const original = process.env.ALLOWED_TOOLS;
			process.env.ALLOWED_TOOLS = "bash";
			try {
				const policy = new GlobalToolPolicy({ allowedTools: ["read_file"] });
				const tool1 = { name: "read_file", label: "Read", description: "test", parameters: {} };
				const tool2 = { name: "bash", label: "Bash", description: "test", parameters: {} };
				// Config should take precedence, allowing read_file
				expect(policy.evaluate("read_file", tool1 as AgentTool)).toBeNull();
				// And denying bash (not in config)
				expect(policy.evaluate("bash", tool2 as AgentTool)).not.toBeNull();
			} finally {
				if (original !== undefined) {
					process.env.ALLOWED_TOOLS = original;
				} else {
					delete process.env.ALLOWED_TOOLS;
				}
			}
		});
	});

	describe("ChatToolPolicy", () => {
		test("returns null when no config", () => {
			const policy = new ChatToolPolicy();
			const tool = { name: "bash", label: "Bash", description: "test", parameters: {} };
			expect(policy.evaluate("bash", tool as AgentTool)).toBeNull();
		});

		test("denies tools in chat denied list", () => {
			const policy = new ChatToolPolicy("chat-123", { deniedTools: ["bash"] });
			const tool = { name: "bash", label: "Bash", description: "test", parameters: {} };
			expect(policy.evaluate("bash", tool as AgentTool)?.action).toBe("deny");
		});

		test("allows tools in chat allowed list", () => {
			const policy = new ChatToolPolicy("chat-123", { allowedTools: ["read_file"] });
			const tool = { name: "read_file", label: "Read", description: "test", parameters: {} };
			expect(policy.evaluate("read_file", tool as AgentTool)).toBeNull();
		});

		test("updateChat changes config", () => {
			const policy = new ChatToolPolicy();
			policy.updateChat("chat-1", { deniedTools: ["bash"] });
			const tool = { name: "bash", label: "Bash", description: "test", parameters: {} };
			expect(policy.evaluate("bash", tool as AgentTool)?.action).toBe("deny");

			policy.updateChat("chat-2", { allowedTools: ["bash"] });
			expect(policy.evaluate("bash", tool as AgentTool)).toBeNull();
		});

		test("priority is 20", () => {
			const policy = new ChatToolPolicy();
			expect(policy.priority).toBe(20);
		});
	});

	describe("ToolGranularPolicy", () => {
		test("blocks write tools in read-only mode - write_file", () => {
			const policy = new ToolGranularPolicy({ readOnly: true });
			const tool = { name: "write_file", label: "Write", description: "test", parameters: {} };
			expect(policy.evaluate("write_file", tool as AgentTool)?.action).toBe("deny");
		});

		test("blocks bash in read-only mode", () => {
			const policy = new ToolGranularPolicy({ readOnly: true });
			const tool = { name: "bash", label: "Bash", description: "test", parameters: {} };
			expect(policy.evaluate("bash", tool as AgentTool)?.action).toBe("deny");
		});

		test("allows read tools in read-only mode", () => {
			const policy = new ToolGranularPolicy({ readOnly: true });
			const tool = { name: "read_file", label: "Read", description: "test", parameters: {} };
			expect(policy.evaluate("read_file", tool as AgentTool)).toBeNull();
		});

		test("handles toolConfig with disabled=true", () => {
			const policy = new ToolGranularPolicy({
				toolConfig: {
					bash: { disabled: true },
				},
			});
			const tool = { name: "bash", label: "Bash", description: "test", parameters: {} };
			// When disabled=true, it returns a "transform" action with _name: "__disabled__"
			expect(policy.evaluate("bash", tool as AgentTool)?.action).toBe("transform");
		});

		test("priority is 30", () => {
			const policy = new ToolGranularPolicy();
			expect(policy.priority).toBe(30);
		});
	});

	describe("ToolPolicyPipeline", () => {
		test("creates pipeline with policies", () => {
			const pipeline = createToolPolicyPipeline({ allowedTools: ["*"] });
			expect(pipeline.getPolicy("global")).toBeDefined();
		});

		test("removes policy by name", () => {
			const pipeline = new ToolPolicyPipeline();
			pipeline.addPolicy(new GlobalToolPolicy());
			expect(pipeline.getPolicy("global")).toBeDefined();
			pipeline.removePolicy("global");
			expect(pipeline.getPolicy("global")).toBeUndefined();
		});

		test("clears all policies", () => {
			const pipeline = new ToolPolicyPipeline();
			pipeline.addPolicy(new GlobalToolPolicy());
			pipeline.addPolicy(new ChatToolPolicy());
			pipeline.clearPolicies();
			expect(pipeline.getPolicy("global")).toBeUndefined();
			expect(pipeline.getPolicy("chat")).toBeUndefined();
		});

		test("evaluates with allow action short-circuits", () => {
			const pipeline = new ToolPolicyPipeline();
			// Add a custom policy that returns allow
			pipeline.addPolicy({
				name: "test",
				priority: 5,
				evaluate: () => ({ action: "allow" as const }),
			});
			const tools = [{ name: "test", label: "Test", description: "test", parameters: {} }] as AgentTool[];
			const result = pipeline.evaluate(tools);
			expect(result).toHaveLength(1);
		});
	});

	describe("createToolPolicyPipeline", () => {
		test("creates pipeline with chatId and chatOverrides", () => {
			const config: ToolPolicyConfig = {
				chatOverrides: {
					"chat-1": { deniedTools: ["bash"] },
				},
			};
			const pipeline = createToolPolicyPipeline(config, "chat-1");
			expect(pipeline.getPolicy("chat")).toBeDefined();
		});
	});

	describe("createReadOnlyPolicyPipeline", () => {
		test("creates read-only pipeline", () => {
			const pipeline = createReadOnlyPolicyPipeline();
			const tool = { name: "bash", label: "Bash", description: "test", parameters: {} };
			// Read-only should block bash
			const tools = [tool] as AgentTool[];
			const result = pipeline.evaluate(tools);
			expect(result).toHaveLength(0);
		});
	});

	describe("applyToolPolicy", () => {
		test("returns empty array when no tools", () => {
			const result = applyToolPolicy([], { allowedTools: ["*"] });
			expect(result).toEqual([]);
		});

		test("filters tools based on policy", () => {
			const tools = [
				{ name: "read_file", label: "Read", description: "read", parameters: {} },
				{ name: "bash", label: "Bash", description: "bash", parameters: {} },
			] as AgentTool[];
			const result = applyToolPolicy(tools, { allowedTools: ["read_file"] });
			expect(result.length).toBe(1);
			expect(result[0].name).toBe("read_file");
		});
	});
});
