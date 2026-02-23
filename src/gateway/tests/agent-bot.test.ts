import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { instanceManager } from "@/gateway/instance-manager";
import { AgentBot } from "@/gateway/pipeline/agent-bot";
import type { Message } from "@/gateway/pipeline/index";
import { discoveryCache } from "@/gateway/services/discovery-cache";
import * as claudeExecutor from "@/gateway/services/claude-executor";

type SendCall = { chatId: string | number; text: string; options?: unknown };

type MockPoolSession = {
	sessionName: string;
	workspace: string;
	status: "active" | "idle" | "error";
	activeRequests: number;
	totalRequests: number;
	createdAt: number;
	lastActivityAt: number;
};

type MockPool = {
	start: ReturnType<typeof mock>;
	listSessions: ReturnType<typeof mock>;
	getStats: ReturnType<typeof mock>;
	getSession: ReturnType<typeof mock>;
	getOrCreateSession: ReturnType<typeof mock>;
	deleteSession: ReturnType<typeof mock>;
};

describe("AgentBot", () => {
	let calls: SendCall[];
	let channel: { name: string; sendMessage: ReturnType<typeof mock> };
	let persistence: {
		getSession: ReturnType<typeof mock>;
		setSession: ReturnType<typeof mock>;
		getWorkspace: ReturnType<typeof mock>;
		setWorkspace: ReturnType<typeof mock>;
		getHistory: ReturnType<typeof mock>;
		storeMessage: ReturnType<typeof mock>;
		getAllTasks: ReturnType<typeof mock>;
		saveTask: ReturnType<typeof mock>;
		deleteTask: ReturnType<typeof mock>;
	};
	let bot: AgentBot;
	let defaultInstance: { name: string; containerId: string; status: string; image: string };

	const baseMessage: Message = {
		channelId: "telegram",
		chatId: "123",
		text: "hello",
	};

	const mockPool = (overrides?: Partial<MockPool>): MockPool => ({
		start: mock(async () => {}),
		listSessions: mock(() => []),
		getStats: mock(() => ({ totalSessions: 0, maxSessions: 50 })),
		getSession: mock(() => undefined),
		getOrCreateSession: mock(async (workspace: string) => ({
			sessionName: `claude-${workspace}`,
			workspace,
			status: "active",
			activeRequests: 0,
			totalRequests: 1,
			createdAt: Date.now(),
			lastActivityAt: Date.now(),
		})),
		deleteSession: mock(async () => {}),
		...overrides,
	});

	const setRunningInstances = (instances: Array<{ name: string; containerId: string; status: string; image: string }>) => {
		(instanceManager.getInstances as unknown as ReturnType<typeof mock>) = mock(() => instances);
		(instanceManager.getInstance as unknown as ReturnType<typeof mock>) = mock((name: string) =>
			instances.find((inst) => inst.name === name),
		);
		(instanceManager.refresh as unknown as ReturnType<typeof mock>) = mock(async () => instances);
	};

	beforeEach(() => {
		mock.restore();
		calls = [];
		channel = {
			name: "test-channel",
			sendMessage: mock(async (chatId: string | number, text: string, options?: unknown) => {
				calls.push({ chatId, text, options });
			}),
		};

		persistence = {
			getSession: mock(async () => null),
			setSession: mock(async () => {}),
			getWorkspace: mock(async () => "cc-bridge"),
			setWorkspace: mock(async () => {}),
			getHistory: mock(async () => []),
			storeMessage: mock(async () => {}),
			getAllTasks: mock(async () => []),
			saveTask: mock(async () => {}),
			deleteTask: mock(async () => {}),
		};

		defaultInstance = {
			name: "cc-bridge",
			containerId: "container-1",
			status: "running",
			image: "cc-bridge:latest",
		};
		setRunningInstances([defaultInstance]);

		bot = new AgentBot(channel as never, persistence as never);
	});

	test("getMenus exposes static menu list", () => {
		expect(bot.getMenus().length).toBeGreaterThan(0);
		expect(bot.getMenus().some((item) => item.command === "agents")).toBe(true);
	});

	test("handle returns no-instance warning when refresh also has no running instance", async () => {
		setRunningInstances([]);
		const handled = await bot.handle(baseMessage);
		expect(handled).toBe(true);
		expect(calls.at(-1)?.text).toContain("No running Claude instance found");
	});

	test("handle rejects invalid prompt after command routing", async () => {
		spyOn(claudeExecutor, "validateAndSanitizePrompt").mockReturnValueOnce({ valid: false, reason: "bad input" });
		const handled = await bot.handle({ ...baseMessage, text: "bad" });
		expect(handled).toBe(true);
		expect(calls.at(-1)?.text).toContain("Invalid message: bad input");
	});

	test("handle stores user message when async execution result is returned", async () => {
		spyOn(claudeExecutor, "validateAndSanitizePrompt").mockReturnValueOnce({ valid: true });
		spyOn(claudeExecutor, "executeClaude").mockResolvedValueOnce({
			requestId: "req-1",
			mode: "tmux",
		});

		const handled = await bot.handle({ ...baseMessage, text: "run async" });
		expect(handled).toBe(true);
		expect(persistence.storeMessage).toHaveBeenCalledWith("123", "user", "run async", "cc-bridge");
	});

	test("handle sends sync success output and stores assistant message", async () => {
		spyOn(claudeExecutor, "validateAndSanitizePrompt").mockReturnValueOnce({ valid: true });
		spyOn(claudeExecutor, "executeClaude").mockResolvedValueOnce({ success: true, output: "done" });

		const handled = await bot.handle({ ...baseMessage, text: "run sync" });
		expect(handled).toBe(true);
		expect(calls.at(-1)?.text).toBe("done");
		expect(persistence.storeMessage).toHaveBeenCalledWith("123", "agent", "done", "cc-bridge");
	});

	test("handle sends retry error output when execution fails", async () => {
		spyOn(claudeExecutor, "validateAndSanitizePrompt").mockReturnValueOnce({ valid: true });
		spyOn(claudeExecutor, "executeClaude")
			.mockResolvedValueOnce({ success: false, retryable: true, error: "stale" })
			.mockResolvedValueOnce({ success: false, error: "still bad" });

		const handled = await bot.handle({ ...baseMessage, text: "run retry" });
		expect(handled).toBe(true);
		expect(calls.at(-1)?.text).toContain("still bad");
		expect((claudeExecutor.executeClaude as unknown as ReturnType<typeof mock>).mock.calls.length).toBe(2);
	});

	test("/schedulers renders empty user task list", async () => {
		await bot.handle({ ...baseMessage, text: "/schedulers" });
		expect(calls.at(-1)?.text).toContain("No user-created scheduled tasks found");
		expect(calls.at(-1)?.options).toEqual({ parse_mode: "Markdown" });
	});

	test("/schedulers renders user tasks and truncates long prompt", async () => {
		persistence.getAllTasks.mockResolvedValueOnce([
			{
				id: "task-1",
				instance_name: "cc-bridge",
				chat_id: "123",
				prompt: "x".repeat(120),
				schedule_type: "recurring",
				schedule_value: "1h",
				next_run: "2026-01-01 00:00:00",
				status: "active",
			},
		]);

		await bot.handle({ ...baseMessage, text: "/schedulers" });
		expect(calls.at(-1)?.text).toContain("task-1");
		expect(calls.at(-1)?.text).toContain("...");
	});

	test("/schedulers handles persistence error", async () => {
		persistence.getAllTasks.mockRejectedValueOnce(new Error("db down"));
		await bot.handle({ ...baseMessage, text: "/schedulers" });
		expect(calls.at(-1)?.text).toContain("Failed to list scheduled tasks");
	});

	test("/scheduler_add handles usage and success branches", async () => {
		await bot.handle({ ...baseMessage, text: "/scheduler_add bad format" });
		expect(calls.at(-1)?.text).toContain("Usage: /scheduler_add");

		await bot.handle({ ...baseMessage, text: "/scheduler_add cc-bridge recurring 15m run report" });
		expect(persistence.saveTask).toHaveBeenCalled();
		expect(calls.at(-1)?.text).toContain("Scheduled task created");

		await bot.handle({ ...baseMessage, text: "/scheduler_add cc-bridge cron 0 9 * * 1-5" });
		expect(calls.at(-1)?.text).toContain("Usage: /scheduler_add");
	});

	test("/scheduler_add handles save failures", async () => {
		persistence.saveTask.mockRejectedValueOnce(new Error("write failed"));
		await bot.handle({ ...baseMessage, text: "/scheduler_add cc-bridge recurring 1h ping" });
		expect(calls.at(-1)?.text).toContain("Failed to create scheduled task");
	});

	test("/scheduler_del handles usage, success, and failures", async () => {
		await bot.handle({ ...baseMessage, text: "/scheduler_del task-1" });
		expect(persistence.deleteTask).toHaveBeenCalledWith("task-1");
		expect(calls.at(-1)?.text).toContain("Scheduled task deleted");

		persistence.deleteTask.mockRejectedValueOnce(new Error("missing"));
		await bot.handle({ ...baseMessage, text: "/scheduler_del task-2" });
		expect(calls.at(-1)?.text).toContain("Failed to delete scheduled task");
	});

	test("/clear sends cleared and no-session outcomes", async () => {
		(bot as unknown as { tmuxManager: { clearSession: ReturnType<typeof mock> } }).tmuxManager = {
			clearSession: mock(async () => true),
		};
		await bot.handle({ ...baseMessage, text: "/clear" });
		expect(calls.at(-1)?.text).toContain("Cleared session context");

		(bot as unknown as { tmuxManager: { clearSession: ReturnType<typeof mock> } }).tmuxManager = {
			clearSession: mock(async () => false),
		};
		await bot.handle({ ...baseMessage, text: "/clear" });
		expect(calls.at(-1)?.text).toContain("No active session to clear");
	});

	test("/clear handles tmux manager failure", async () => {
		(bot as unknown as { tmuxManager: { clearSession: ReturnType<typeof mock> } }).tmuxManager = {
			clearSession: mock(async () => {
				throw new Error("tmux error");
			}),
		};
		await bot.handle({ ...baseMessage, text: "/clear" });
		expect(calls.at(-1)?.text).toContain("Failed to clear session");
	});

	test("handleListAgents covers empty, success and error branches", async () => {
		spyOn(discoveryCache, "getCache").mockResolvedValueOnce({
			agents: [],
			commands: [],
			skills: [],
			lastUpdated: Date.now(),
		});
		await bot.handleListAgents(baseMessage);
		expect(calls.at(-1)?.text).toContain("No agents found");

		spyOn(discoveryCache, "getCache").mockResolvedValueOnce({
			agents: [
				{ plugin: "core", name: "agent1", description: "d".repeat(150), tools: ["a", "b", "c", "d"] },
			],
			commands: [],
			skills: [],
			lastUpdated: Date.now(),
		});
		await bot.handleListAgents(baseMessage);
		expect(calls.at(-1)?.text).toContain("Available Claude Code Agents");

		spyOn(discoveryCache, "getCache").mockRejectedValueOnce(new Error("cache fail"));
		await bot.handleListAgents(baseMessage);
		expect(calls.at(-1)?.text).toContain("Failed to list agents");
	});

	test("handleListCommands splits long output and handles errors", async () => {
		spyOn(discoveryCache, "getCache").mockResolvedValueOnce({
			agents: [],
			commands: [
				{ plugin: "core", name: "cmd", argumentHint: "<x>", description: "line\n".repeat(2500) },
			],
			skills: [],
			lastUpdated: Date.now(),
		});
		await bot.handleListCommands(baseMessage);
		expect(calls.length).toBeGreaterThanOrEqual(1);

		spyOn(discoveryCache, "getCache").mockRejectedValueOnce(new Error("boom"));
		await bot.handleListCommands(baseMessage);
		expect(calls.at(-1)?.text).toContain("Failed to list commands");
	});

	test("handleListSkills splits long output and handles errors", async () => {
		spyOn(discoveryCache, "getCache").mockResolvedValueOnce({
			agents: [],
			commands: [],
			skills: [{ plugin: "core", name: "skill1", description: "desc\n".repeat(2500) }],
			lastUpdated: Date.now(),
		});
		await bot.handleListSkills(baseMessage);
		expect(calls.length).toBeGreaterThanOrEqual(1);

		spyOn(discoveryCache, "getCache").mockRejectedValueOnce(new Error("boom"));
		await bot.handleListSkills(baseMessage);
		expect(calls.at(-1)?.text).toContain("Failed to list skills");
	});

	test("workspace list/current/switch/create/delete cover success and error branches", async () => {
		const now = Date.now();
		const sessions: MockPoolSession[] = [
			{
				sessionName: "claude-cc-bridge",
				workspace: "cc-bridge",
				status: "active",
				activeRequests: 0,
				totalRequests: 3,
				createdAt: now - 60_000,
				lastActivityAt: now - 10_000,
			},
		];
		const pool = mockPool({
			listSessions: mock(() => sessions),
			getStats: mock(() => ({ totalSessions: 1, maxSessions: 50 })),
			getSession: mock((workspace: string) => sessions.find((s) => s.workspace === workspace)),
		});
		(bot as unknown as { sessionPools: Map<string, MockPool> }).sessionPools.set(defaultInstance.containerId, pool);

		await bot.handleWorkspaceList(baseMessage, defaultInstance);
		expect(calls.at(-1)?.text).toContain("Active Workspaces");

		await bot.handleWorkspaceCurrent(baseMessage, defaultInstance);
		expect(calls.at(-1)?.text).toContain("Current Workspace");

		await bot.handleWorkspaceSwitch(baseMessage, defaultInstance, "invalid workspace");
		expect(calls.at(-1)?.text).toContain("Invalid workspace name");

		await bot.handleWorkspaceSwitch(baseMessage, defaultInstance, "ws2");
		expect(persistence.setWorkspace).toHaveBeenCalledWith("123", "ws2");
		expect(calls.at(-1)?.text).toContain("Switched to workspace");

		pool.getOrCreateSession.mockRejectedValueOnce(new Error("Session limit reached"));
		await bot.handleWorkspaceSwitch(baseMessage, defaultInstance, "ws3");
		expect(calls.at(-1)?.text).toContain("Maximum session limit reached");

		pool.getOrCreateSession.mockRejectedValueOnce(new Error("other fail"));
		await bot.handleWorkspaceCreate(baseMessage, defaultInstance, "ws4");
		expect(calls.at(-1)?.text).toContain("Failed to create workspace");

		await bot.handleWorkspaceCreate(baseMessage, defaultInstance, "ws5");
		expect(calls.at(-1)?.text).toContain("Workspace session created");

		pool.getSession.mockReturnValueOnce(undefined);
		await bot.handleWorkspaceDelete(baseMessage, defaultInstance, "missing");
		expect(calls.at(-1)?.text).toContain("not found");

		pool.getSession.mockReturnValueOnce({ ...sessions[0], activeRequests: 2 });
		await bot.handleWorkspaceDelete(baseMessage, defaultInstance, "cc-bridge");
		expect(calls.at(-1)?.text).toContain("active request");

		pool.getSession.mockReturnValueOnce({ ...sessions[0], activeRequests: 0 });
		await bot.handleWorkspaceDelete(baseMessage, defaultInstance, "cc-bridge");
		expect(pool.deleteSession).toHaveBeenCalledWith("cc-bridge");
		expect(calls.at(-1)?.text).toContain("Workspace deleted");
	});

	test("workspace handlers return fallback errors when pool operations throw", async () => {
		const brokenPool = mockPool();
		brokenPool.listSessions.mockImplementationOnce(() => {
			throw new Error("list fail");
		});
		(bot as unknown as { sessionPools: Map<string, MockPool> }).sessionPools.set(defaultInstance.containerId, brokenPool);
		await bot.handleWorkspaceList(baseMessage, defaultInstance);
		expect(calls.at(-1)?.text).toContain("Failed to list workspaces");
	});
});
