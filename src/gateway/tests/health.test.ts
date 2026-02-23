import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import { Hono } from "hono";
import { instanceManager } from "@/gateway/instance-manager";
import { handleHealth } from "@/gateway/routes/health";

function textStream(text: string): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(text));
			controller.close();
		},
	});
}

type HealthJson = {
	status: string;
	env: { PORT: { value: string } };
	connectivity: { telegram: boolean; anthropic: boolean };
	instances: { total: number; running: number };
	webhook: { url: string };
	mailbox_stats: { pending_proactive_messages: number };
	filesystem: { persistence: { status: string } };
	docker: unknown[];
};

describe("Health Route", () => {
	afterEach(() => {
		delete process.env.TELEGRAM_BOT_TOKEN;
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_AUTH_TOKEN;
		delete process.env.ANTHROPIC_BASE_URL;
		delete process.env.CC_BRIDGE_SERVER_URL;
		delete process.env.PORT;
		delete process.env.NODE_ENV;
	});

	test("returns healthy JSON payload with full diagnostics", async () => {
		process.env.TELEGRAM_BOT_TOKEN = "token";
		process.env.ANTHROPIC_API_KEY = "k";
		process.env.PORT = "9090";
		process.env.NODE_ENV = "test";
		process.env.CC_BRIDGE_SERVER_URL = "https://bridge.example";

		const instancesSpy = spyOn(instanceManager, "getInstances").mockReturnValue([
			{ name: "ws-a", status: "running" },
			{ name: "ws-b", status: "stopped" },
		] as never);

		const fetchCalls: string[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: Request | string | URL) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			fetchCalls.push(url);
			if (fetchCalls.length === 1) return new Response("ok", { status: 200 });
			return new Response("ok", { status: 429 });
		}) as typeof fetch;

		const tgStatusSpy = spyOn((await import("@/gateway/channels/telegram")).TelegramChannel.prototype, "getStatus")
			.mockResolvedValue({ result: { url: "https://t.me/hook", pending_update_count: 2 } } as never);

		const spawnSpy = spyOn(Bun, "spawn").mockImplementation((args: string[]) => {
			if (args[0] === "docker") {
				return {
					stdout: textStream("claude-cc-bridge-a\timage:latest\tUp 2 hours\n"),
					stderr: textStream(""),
					exited: Promise.resolve(0),
				} as unknown as ReturnType<typeof Bun.spawn>;
			}
			if (args[0] === "launchctl") {
				return { stderr: textStream(""), exited: Promise.resolve(1) } as unknown as ReturnType<typeof Bun.spawn>;
			}
			return { stderr: textStream(""), exited: Promise.resolve(0) } as unknown as ReturnType<typeof Bun.spawn>;
		});

		const accessSpy = spyOn(fs, "access").mockResolvedValue(undefined as never);
		const readdirSpy = spyOn(fs, "readdir").mockImplementation(async (dir: Parameters<typeof fs.readdir>[0]) => {
			const v = String(dir);
			if (v.endsWith("data/ipc")) return ["ws-a"];
			if (v.endsWith("data/ipc/ws-a/messages")) return ["m1.json", "note.txt"];
			return [];
		});

		const app = new Hono();
		app.get("/health", handleHealth);
		const res = await app.request("/health", { headers: { Accept: "application/json" } });
		expect(res.status).toBe(200);

		const data = (await res.json()) as HealthJson;
		expect(data.status).toBe("ok");
		expect(data.env.PORT.value).toBe("9090");
		expect(data.connectivity.telegram).toBe(true);
		expect(data.connectivity.anthropic).toBe(true);
		expect(data.instances.total).toBe(2);
		expect(data.instances.running).toBe(1);
		expect(data.webhook.url).toBe("https://t.me/hook");
		expect(data.mailbox_stats.pending_proactive_messages).toBe(1);
		expect(data.filesystem.persistence.status).toBe("ok");
		expect(data.docker.length).toBe(1);

		readdirSpy.mockRestore();
		accessSpy.mockRestore();
		spawnSpy.mockRestore();
		tgStatusSpy.mockRestore();
		globalThis.fetch = originalFetch;
		instancesSpy.mockRestore();
	});

	test("returns text report and error status when checks fail", async () => {
		const instancesSpy = spyOn(instanceManager, "getInstances").mockReturnValue([] as never);

		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			throw new Error("offline");
		}) as typeof fetch;

		const spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => {
			throw new Error("spawn-fail");
		});

		const accessSpy = spyOn(fs, "access").mockRejectedValue(new Error("no-access"));
		const readdirSpy = spyOn(fs, "readdir").mockRejectedValue(new Error("no-dir"));

		const app = new Hono();
		app.get("/health", handleHealth);
		const res = await app.request("/health?format=terminal");
		expect(res.status).toBe(200);

		const text = await res.text();
		expect(text.includes("Error") || text.includes("error")).toBe(true);
		expect(text.includes("mailbox") || text.includes("Mailbox")).toBe(true);

		readdirSpy.mockRestore();
		accessSpy.mockRestore();
		spawnSpy.mockRestore();
		globalThis.fetch = originalFetch;
		instancesSpy.mockRestore();
	});
});
