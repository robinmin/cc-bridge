import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import { Hono } from "hono";
import {
	CircuitBreakerIpcClient,
	DockerExecIpcClient,
	HostIpcClient,
	IpcClient,
	IpcFactory,
	RemoteIpcClient,
	TcpIpcClient,
	UnixSocketIpcClient,
} from "@/packages/ipc";
import { configToBackend } from "@/packages/ipc/backends";
import { detectLogFormat, detectServiceName } from "@/packages/logger";
import { parseFetchResponseBody, parseRawResponseBody, toIpcErrorPayload } from "@/packages/ipc/response-utils";
import type { IIpcClient, IpcRequest, IpcResponse } from "@/packages/ipc/types";

type MockNetSocket = EventEmitter & {
	write: (...args: unknown[]) => void;
	destroy: () => void;
};

type StdioAdapterInternals = {
	handleLine: (line: string) => Promise<void>;
};

class MockClient implements IIpcClient {
	public available = true;
	public throws = false;
	public response: IpcResponse = { id: "r1", status: 200, result: { ok: true } };

	getMethod(): string {
		return "mock";
	}

	isAvailable(): boolean {
		return this.available;
	}

	async sendRequest(request: IpcRequest): Promise<IpcResponse> {
		if (this.throws) {
			throw new Error("mock-failure");
		}
		return { ...this.response, id: request.id };
	}
}

function makeStream(text: string): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(text));
			controller.close();
		},
	});
}

function clearIpcEnv() {
	delete process.env.AGENT_TCP_PORT;
	delete process.env.AGENT_PORT;
	delete process.env.AGENT_SOCKET;
	delete process.env.AGENT_HOST;
	delete process.env.AGENT_TCP_HOST;
	delete process.env.AGENT_REMOTE_URL;
	delete process.env.AGENT_REMOTE_API_KEY;
	delete process.env.AGENT_MODE;
}

describe("IPC package bridge coverage", () => {
	beforeEach(() => {
		clearIpcEnv();
	});

	afterEach(() => {
		clearIpcEnv();
	});

	test("covers response utility parsing branches", async () => {
		expect(await parseFetchResponseBody(new Response(null, { status: 204 }))).toEqual({});
		expect(await parseFetchResponseBody(new Response("", { status: 200 }))).toEqual({});
		expect(
			await parseFetchResponseBody(
				new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }),
			),
		).toEqual({ ok: true });
		expect(
			await parseFetchResponseBody(
				new Response("not-json", { status: 200, headers: { "content-type": "application/json" } }),
			),
		).toEqual({ message: "not-json" });
		expect(await parseFetchResponseBody(new Response('{"x":1}', { status: 200 }))).toEqual({ x: 1 });
		expect(await parseFetchResponseBody(new Response("plain-text", { status: 200 }))).toEqual({ message: "plain-text" });

		expect(parseRawResponseBody("")).toEqual({});
		expect(parseRawResponseBody('{"v":1}')).toEqual({ v: 1 });
		expect(parseRawResponseBody("oops")).toEqual({ message: "oops" });

		expect(toIpcErrorPayload({ message: "bad" }, 500)).toEqual({ message: "bad" });
		expect(toIpcErrorPayload("boom", 400)).toEqual({ message: "boom" });
		expect(toIpcErrorPayload({ notMessage: true }, 503)).toEqual({ message: "HTTP 503" });
	});

	test("covers backend conversion branches", () => {
		expect(configToBackend({ containerId: "cid", instanceName: "ws" })).toEqual({
			type: "container",
			containerId: "cid",
			instanceName: "ws",
		});

		process.env.AGENT_TCP_PORT = "7777";
		process.env.AGENT_HOST = "127.0.0.1";
		expect(configToBackend({})).toEqual({ type: "host", port: 7777, host: "127.0.0.1", socketPath: undefined });

		clearIpcEnv();
		process.env.AGENT_SOCKET = "/tmp/agent.sock";
		expect(configToBackend({})).toEqual({
			type: "host",
			socketPath: "/tmp/agent.sock",
			port: undefined,
			host: undefined,
		});

		clearIpcEnv();
		process.env.AGENT_REMOTE_URL = "https://agent.example.com";
		process.env.AGENT_REMOTE_API_KEY = "k";
		expect(configToBackend({})).toEqual({ type: "remote", url: "https://agent.example.com", apiKey: "k" });

		clearIpcEnv();
		expect(configToBackend({})).toEqual({ type: "host", port: 3001, host: "localhost" });
	});

	test("covers circuit breaker open/half-open/recovery branches", async () => {
		const mock = new MockClient();
		const cb = new CircuitBreakerIpcClient(mock);

		mock.throws = true;
		for (let i = 0; i < 5; i++) {
			const r = await cb.sendRequest({ id: `f-${i}`, method: "GET", path: "/" });
			expect(r.status).toBe(500);
		}
		expect(cb.getCircuitState().state).toBe("open");

		const blocked = await cb.sendRequest({ id: "blocked", method: "GET", path: "/" });
		expect(blocked.status).toBe(503);

		const nowSpy = spyOn(Date, "now");
		nowSpy.mockReturnValue(cb.getCircuitState().lastFailureTime + 61000);
		mock.throws = false;
		const halfOpenPass = await cb.sendRequest({ id: "half-open", method: "GET", path: "/" });
		expect(halfOpenPass.status).toBe(200);
		expect(cb.getCircuitState().state).toBe("closed");

		nowSpy.mockReturnValue(cb.getCircuitState().lastFailureTime + 121000);
		mock.throws = true;
		for (let i = 0; i < 5; i++) {
			await cb.sendRequest({ id: `g-${i}`, method: "GET", path: "/" });
		}
		expect(cb.getCircuitState().state).toBe("open");
		cb.resetCircuitBreaker();
		expect(cb.getCircuitState().state).toBe("closed");
		nowSpy.mockRestore();
	});

	test("covers tcp and remote IPC clients", async () => {
		const originalFetch = globalThis.fetch;
		const requests: Request[] = [];
		globalThis.fetch = (async (request: Request) => {
			requests.push(request);
			if (request.url.includes("error")) {
				return new Response("nope", { status: 502 });
			}
			return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
		}) as typeof fetch;

		process.env.AGENT_TCP_HOST = "127.0.0.1";
		process.env.AGENT_TCP_PORT = "3009";
		const tcp = new TcpIpcClient();
		expect(tcp.getMethod()).toBe("tcp");
		expect(tcp.isAvailable()).toBe(true);
		expect(await tcp.sendRequest({ id: "1", method: "POST", path: "/ok", body: { x: 1 } })).toEqual({
			id: "1",
			status: 200,
			result: { ok: true },
			error: undefined,
		});
		const tcpErr = await tcp.sendRequest({ id: "2", method: "GET", path: "/error" });
		expect(tcpErr.status).toBe(502);
		expect(tcpErr.error).toEqual({ message: "nope" });

		const remote = new RemoteIpcClient({ type: "remote", url: "https://agent.example", apiKey: "abc" });
		expect(remote.getMethod()).toBe("remote");
		expect(remote.isAvailable()).toBe(true);
		await remote.sendRequest({ id: "3", method: "GET", path: "/ok" });
		expect(requests[2].headers.get("authorization")).toBe("Bearer abc");

		globalThis.fetch = (async () => {
			throw new Error("network");
		}) as typeof fetch;
		await expect(tcp.sendRequest({ id: "x", method: "GET", path: "/ok" })).rejects.toThrow("network");
		await expect(remote.sendRequest({ id: "y", method: "GET", path: "/ok" })).rejects.toThrow("network");

		globalThis.fetch = originalFetch;
	});

	test("covers unix and host unix path errors and success", async () => {
		const existsSpy = spyOn(fs, "existsSync");
		existsSpy.mockImplementation((p) => String(p).includes("agent.sock"));
		const unix = new UnixSocketIpcClient({ instanceName: "ws1" });
		expect(unix.getMethod()).toBe("unix");
		expect(unix.isAvailable()).toBe(true);

		const emitter = new EventEmitter() as MockNetSocket;
		emitter.write = () => {};
		emitter.destroy = () => {};
		const connSpy = spyOn(net, "createConnection").mockImplementation(() => {
			queueMicrotask(() => {
				emitter.emit("connect");
				emitter.emit("data", Buffer.from("HTTP/1.1 200 OK\r\n\r\n{\"ok\":true}"));
				emitter.emit("end");
			});
			return emitter;
		});
		const unixResp = await unix.sendRequest({ id: "u1", method: "POST", path: "/run", body: { a: 1 } });
		expect(unixResp.status).toBe(200);
		expect(unixResp.result).toEqual({ ok: true });

		const unixNoPath = new UnixSocketIpcClient();
		await expect(unixNoPath.sendRequest({ id: "u2", method: "GET", path: "/" })).rejects.toThrow(
			"Unix socket path not configured",
		);

		const hostUnix = new HostIpcClient({ type: "host", socketPath: "/tmp/agent.sock" });
		expect(hostUnix.isAvailable()).toBe(true);
		const hostUnixResp = await hostUnix.sendRequest({ id: "h1", method: "GET", path: "/" });
		expect(hostUnixResp.status).toBe(200);

		connSpy.mockRestore();
		existsSpy.mockRestore();
	});

	test("covers host tcp and docker exec clients", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => new Response('{"ok":true}', { status: 200 })) as typeof fetch;

		const hostTcp = new HostIpcClient({ type: "host", host: "localhost", port: 3900 });
		expect(hostTcp.getMethod()).toBe("host");
		expect(hostTcp.isAvailable()).toBe(true);
		const hostResp = await hostTcp.sendRequest({ id: "h2", method: "GET", path: "/status" });
		expect(hostResp.status).toBe(200);

		const existsSpy = spyOn(fs, "existsSync").mockReturnValue(false);
		const hostUnixMissing = new HostIpcClient({ type: "host", socketPath: "/tmp/missing.sock" });
		await expect(hostUnixMissing.sendRequest({ id: "h3", method: "GET", path: "/" })).rejects.toThrow(
			"Unix socket not found",
		);
		existsSpy.mockRestore();

		const spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => {
			return {
				stdin: {
					write: () => {},
					flush: () => {},
					end: () => {},
				},
				stdout: makeStream('log line\n{"id":"req-1","status":200,"result":{"ok":true}}\n'),
				stderr: makeStream(""),
				exited: Promise.resolve(0),
				kill: () => {},
			} as unknown as ReturnType<typeof Bun.spawn>;
		});

		const docker = new DockerExecIpcClient({ containerId: "c1" });
		expect(docker.getMethod()).toBe("docker-exec");
		expect(docker.isAvailable()).toBe(true);
		const dockerResp = await docker.sendRequest({ id: "req-1", method: "GET", path: "/" });
		expect(dockerResp.status).toBe(200);

		spawnSpy.mockImplementation(() => {
			return {
				stdin: {
					write: () => {},
					flush: () => {},
					end: () => {},
				},
				stdout: makeStream(""),
				stderr: makeStream("boom"),
				exited: Promise.resolve(1),
				kill: () => {},
			} as unknown as ReturnType<typeof Bun.spawn>;
		});
		await expect(docker.sendRequest({ id: "req-2", method: "GET", path: "/" })).rejects.toThrow("boom");
		expect(() => new DockerExecIpcClient({})).toThrow("requires containerId");

		spawnSpy.mockRestore();
		globalThis.fetch = originalFetch;
	});

	test("covers IPC factory and legacy client paths", async () => {
		const autoHost = IpcFactory.create("auto", {});
		expect(autoHost.getMethod()).toBe("host");

		const tcpWrapped = IpcFactory.create("tcp", {});
		expect(tcpWrapped.getMethod()).toBe("tcp");
		const unixWrapped = IpcFactory.create("unix", {});
		expect(unixWrapped.getMethod()).toBe("unix");
		const dockerWrapped = IpcFactory.create("docker-exec", { containerId: "c1" });
		expect(dockerWrapped.getMethod()).toBe("docker-exec");
		const unknownWrapped = IpcFactory.create(
			"oops" as unknown as Parameters<typeof IpcFactory.create>[0],
			{ containerId: "c1" },
		);
		expect(unknownWrapped.getMethod()).toBe("docker-exec");

		process.env.AGENT_REMOTE_URL = "https://remote";
		const remoteWrapped = IpcFactory.create("remote", {});
		expect(remoteWrapped.getMethod()).toBe("remote");

		clearIpcEnv();
		process.env.AGENT_SOCKET = "/tmp/agent.sock";
		const fromBackend = IpcFactory.createFromBackend({ type: "container", containerId: "c1" });
		expect(["unix", "tcp", "docker-exec"]).toContain(fromBackend.getMethod());

		const fallback = IpcFactory.createWithFallback(["tcp", "unix"], {});
		expect(fallback.getMethod()).toBe("fallback");
		expect(fallback.isAvailable()).toBe(true);

		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => new Response('{"ok":true}', { status: 200 })) as typeof fetch;
		const ok = await fallback.sendRequest({ id: "fb1", method: "GET", path: "/" });
		expect(ok.status).toBe(200);
		globalThis.fetch = originalFetch;

		clearIpcEnv();
		process.env.AGENT_SOCKET = "/tmp/agent.sock";
		expect(() => IpcFactory.create("remote", {})).toThrow("remote-compatible");
		clearIpcEnv();
		process.env.AGENT_REMOTE_URL = "https://remote";
		expect(() => IpcFactory.create("host", {})).toThrow("host-compatible");
		clearIpcEnv();

		const tcpAvailSpy = spyOn(TcpIpcClient.prototype, "isAvailable").mockReturnValue(false);
		const unixAvailSpy = spyOn(UnixSocketIpcClient.prototype, "isAvailable").mockReturnValue(true);
		const autoContainerUnix = IpcFactory.create("auto", { containerId: "c2" });
		expect(autoContainerUnix.getMethod()).toBe("unix");
		unixAvailSpy.mockReturnValue(false);
		const autoContainerDocker = IpcFactory.create("auto", { containerId: "c2" });
		expect(autoContainerDocker.getMethod()).toBe("docker-exec");
		unixAvailSpy.mockRestore();
		tcpAvailSpy.mockRestore();

		const createSpy = spyOn(IpcFactory, "create").mockImplementation(() => {
			return {
				getMethod: () => "mock",
				isAvailable: () => false,
				sendRequest: async () => ({ id: "x", status: 500, error: { message: "x" } }),
			};
		});
		const fallbackFail = IpcFactory.createWithFallback(["tcp", "unix"], {});
		const failResp = await fallbackFail.sendRequest({ id: "fb-fail", method: "GET", path: "/" });
		expect(failResp).toEqual({ id: "fb-fail", status: 503, error: { message: "All IPC methods failed" } });
		createSpy.mockRestore();

		const legacy = new IpcClient("container-1", "ws");
		const factoryCreateSpy = spyOn(IpcFactory, "create").mockImplementation(() => {
			return {
				getMethod: () => "mock",
				isAvailable: () => true,
				sendRequest: async (request) => ({ id: request.id, status: 200, result: { ok: true } }),
			};
		});
		const legacyResp = await legacy.sendRequest({ id: "legacy", method: "GET", path: "/" });
		expect(legacyResp.status).toBe(200);
		expect(IpcClient.getCircuitState()).toEqual({ failures: 0, lastFailureTime: 0, state: "closed" });
		IpcClient.resetCircuitBreaker();
		factoryCreateSpy.mockRestore();
	});

	test("covers stdio adapter line handling without start()", async () => {
		const app = new Hono();
		app.post("/echo", async (c) => c.json({ ok: true }));
		app.get("/fail", async (c) => c.text("no-json", 500));

		const outputs: string[] = [];
		const { StdioIpcAdapter } = await import("@/packages/ipc/stdio-adapter");
		const adapter = new StdioIpcAdapter(app, makeStream(""), (msg) => outputs.push(msg));

		await (adapter as unknown as StdioAdapterInternals).handleLine(
			JSON.stringify({ id: "a1", method: "POST", path: "/echo", body: { x: 1 } }),
		);
		const ok = JSON.parse(outputs[0]);
		expect(ok.id).toBe("a1");
		expect(ok.status).toBe(200);
		expect(ok.result).toEqual({ ok: true });

		await (adapter as unknown as StdioAdapterInternals).handleLine(
			JSON.stringify({ id: "a2", method: "GET", path: "/fail" }),
		);
		const failed = JSON.parse(outputs[1]);
		expect(failed.id).toBe("a2");
		expect(failed.status).toBe(500);
		expect(failed.error).toEqual({});

		await (adapter as unknown as StdioAdapterInternals).handleLine("not-json");
		const malformed = JSON.parse(outputs[2]);
		expect(malformed.id).toBe("error");
		expect(malformed.status).toBe(500);
	});

	test("covers stdio adapter start loop with success and stream error", async () => {
		const app = new Hono();
		app.post("/echo", async (c) => c.json({ ok: true }));

		const outputs: string[] = [];
		const { StdioIpcAdapter } = await import("@/packages/ipc/stdio-adapter");

		const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);
		const errorSpy = spyOn(console, "error").mockImplementation(() => {});

		const successStream = makeStream(`${JSON.stringify({ id: "s1", method: "POST", path: "/echo", body: {} })}\n`);
		const adapter = new StdioIpcAdapter(app, successStream, (msg) => outputs.push(msg));
		await adapter.start();
		expect(outputs.length).toBe(1);
		expect(exitSpy).toHaveBeenCalledWith(0);

		const errorStream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.error(new Error("stream-fail"));
			},
		});
		const adapterWithError = new StdioIpcAdapter(app, errorStream, () => {});
		await adapterWithError.start();
		expect(errorSpy).toHaveBeenCalled();
		expect(exitSpy).toHaveBeenCalledWith(1);

		errorSpy.mockRestore();
		exitSpy.mockRestore();
	});

	test("covers remaining logger service-name branches", () => {
		const oldMain = process.argv[1];
		delete process.env.SERVICE_NAME;

		process.argv[1] = "/tmp/agent/main.ts";
		expect(detectServiceName()).toBe("agent");
		process.argv[1] = "/tmp/other/main.ts";
		expect(detectServiceName()).toBe("unknown");

		process.argv[1] = oldMain;
	});

	test("covers logger format catch/default branch", () => {
		delete process.env.LOG_FORMAT;
		const existsSpy = spyOn(fs, "existsSync").mockReturnValue(true);
		const readSpy = spyOn(fs, "readFileSync").mockImplementation(() => {
			throw new Error("read-failed");
		});
		expect(detectLogFormat()).toBe("json");
		readSpy.mockRestore();
		existsSpy.mockRestore();
	});

	test("covers abort/error branches for tcp/remote/host/unix clients", async () => {
		const originalFetch = globalThis.fetch;

		globalThis.fetch = (async (_request: Request, opts?: { signal?: AbortSignal }) => {
			return await new Promise<Response>((_resolve, reject) => {
				opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			});
		}) as typeof fetch;

		process.env.AGENT_TCP_PORT = "3999";
		const tcp = new TcpIpcClient();
		await expect(tcp.sendRequest({ id: "t-timeout", method: "GET", path: "/" }, 1)).rejects.toThrow("aborted");

		const remote = new RemoteIpcClient({ type: "remote", url: "https://remote" });
		await expect(remote.sendRequest({ id: "r-timeout", method: "GET", path: "/" }, 1)).rejects.toThrow("aborted");

		const host = new HostIpcClient({ type: "host", host: "localhost", port: 3999 });
		await expect(host.sendRequest({ id: "h-timeout", method: "GET", path: "/" }, 1)).rejects.toThrow("aborted");

		const existsSpy = spyOn(fs, "existsSync").mockReturnValue(true);
		const connSpy = spyOn(net, "createConnection").mockImplementation(() => {
			const emitter = new EventEmitter() as MockNetSocket;
			emitter.write = () => {};
			emitter.destroy = () => {};
			queueMicrotask(() => {
				emitter.emit("error", new Error("socket-error"));
			});
			return emitter;
		});
		const unix = new UnixSocketIpcClient({ instanceName: "ws-timeout" });
		await expect(unix.sendRequest({ id: "u-timeout", method: "GET", path: "/" })).rejects.toThrow("socket-error");
		const hostUnix = new HostIpcClient({ type: "host", socketPath: "/tmp/agent.sock" });
		await expect(hostUnix.sendRequest({ id: "hu-timeout", method: "GET", path: "/" })).rejects.toThrow("socket-error");

		connSpy.mockRestore();
		existsSpy.mockRestore();
		globalThis.fetch = originalFetch;
	});

	test("covers docker timeout cleanup path", async () => {
		let killed = false;
		let resolved = false;
		const spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => {
			let resolveExit: (code: number) => void = () => {};
			const exited = new Promise<number>((resolve) => {
				resolveExit = resolve;
			});
			return {
				stdin: {
					write: () => {},
					flush: () => {},
					end: () => {},
				},
				stdout: makeStream(""),
				stderr: makeStream(""),
				exited,
				kill: () => {
					killed = true;
					if (!resolved) {
						resolved = true;
						resolveExit(0);
					}
				},
			} as unknown as ReturnType<typeof Bun.spawn>;
		});

		const docker = new DockerExecIpcClient({ containerId: "c-timeout" });
		await expect(docker.sendRequest({ id: "req-timeout", method: "GET", path: "/" }, 1)).rejects.toThrow();
		expect(killed).toBe(true);
		spawnSpy.mockRestore();
	});

	test("covers stdio default output function path", async () => {
		const app = new Hono();
		app.get("/ok", (c) => c.json({ ok: true }));

		const writeSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
		const adapter = new (await import("@/packages/ipc/stdio-adapter")).StdioIpcAdapter(app, makeStream(""));
		await (adapter as unknown as StdioAdapterInternals).handleLine(
			JSON.stringify({ id: "d1", method: "GET", path: "/ok" }),
		);
		expect(writeSpy).toHaveBeenCalled();
		writeSpy.mockRestore();
	});

	test("covers remaining IPC factory branch variants", () => {
		const originalAgentSocket = process.env.AGENT_SOCKET;
		const originalAgentMode = process.env.AGENT_MODE;
		const originalAgentTcpPort = process.env.AGENT_TCP_PORT;
		const originalAgentRemoteUrl = process.env.AGENT_REMOTE_URL;
		const originalAgentRemoteApiKey = process.env.AGENT_REMOTE_API_KEY;

		delete process.env.AGENT_REMOTE_URL;
		delete process.env.AGENT_REMOTE_API_KEY;
		process.env.AGENT_MODE = "tcp";
		process.env.AGENT_TCP_PORT = "3001";
		let fromContainer = IpcFactory.createFromBackend({ type: "container", containerId: "c1", instanceName: "w1" });
		expect(fromContainer.getMethod()).toBe("tcp");

		delete process.env.AGENT_MODE;
		delete process.env.AGENT_TCP_PORT;
		process.env.AGENT_SOCKET = "/tmp/agent.sock";
		fromContainer = IpcFactory.createFromBackend({ type: "container", containerId: "c1", instanceName: "w1" });
		expect(fromContainer.getMethod()).toBe("unix");

		delete process.env.AGENT_SOCKET;
		const fromHost = IpcFactory.createFromBackend({ type: "host", host: "localhost", port: 3001 });
		expect(fromHost.getMethod()).toBe("host");

		process.env.AGENT_REMOTE_URL = "https://remote.example";
		process.env.AGENT_REMOTE_API_KEY = "k";
		const fromRemote = IpcFactory.createFromBackend({ type: "remote", url: "https://remote.example", apiKey: "k" });
		expect(fromRemote.getMethod()).toBe("remote");

		if (originalAgentMode === undefined) delete process.env.AGENT_MODE;
		else process.env.AGENT_MODE = originalAgentMode;
		if (originalAgentTcpPort === undefined) delete process.env.AGENT_TCP_PORT;
		else process.env.AGENT_TCP_PORT = originalAgentTcpPort;
		if (originalAgentSocket === undefined) delete process.env.AGENT_SOCKET;
		else process.env.AGENT_SOCKET = originalAgentSocket;
		if (originalAgentRemoteUrl === undefined) delete process.env.AGENT_REMOTE_URL;
		else process.env.AGENT_REMOTE_URL = originalAgentRemoteUrl;
		if (originalAgentRemoteApiKey === undefined) delete process.env.AGENT_REMOTE_API_KEY;
		else process.env.AGENT_REMOTE_API_KEY = originalAgentRemoteApiKey;
	});

	test("covers IPC factory host/auto/catch branches", async () => {
		const originalEnv = {
			AGENT_REMOTE_URL: process.env.AGENT_REMOTE_URL,
			AGENT_REMOTE_API_KEY: process.env.AGENT_REMOTE_API_KEY,
			AGENT_TCP_PORT: process.env.AGENT_TCP_PORT,
			AGENT_HOST: process.env.AGENT_HOST,
			AGENT_MODE: process.env.AGENT_MODE,
		};

		// Host create success branch
		delete process.env.AGENT_REMOTE_URL;
		delete process.env.AGENT_REMOTE_API_KEY;
		delete process.env.AGENT_MODE;
		process.env.AGENT_TCP_PORT = "3001";
		process.env.AGENT_HOST = "127.0.0.1";
		const hostClient = IpcFactory.create("host", {});
		expect(hostClient.getMethod()).toBe("host");

		// Auto remote branch
		delete process.env.AGENT_TCP_PORT;
		delete process.env.AGENT_HOST;
		process.env.AGENT_REMOTE_URL = "https://remote.example";
		process.env.AGENT_REMOTE_API_KEY = "r-key";
		const autoRemote = IpcFactory.create("auto", {});
		expect(autoRemote.getMethod()).toBe("remote");

		// Auto TCP branch
		delete process.env.AGENT_REMOTE_URL;
		delete process.env.AGENT_REMOTE_API_KEY;
		const tcpAvailSpy = spyOn(TcpIpcClient.prototype, "isAvailable").mockReturnValue(true);
		const autoTcp = IpcFactory.create("auto", { containerId: "c-auto" });
		expect(autoTcp.getMethod()).toBe("tcp");
		tcpAvailSpy.mockRestore();

		// Fallback catch branch
		const createSpy = spyOn(IpcFactory, "create")
			.mockImplementationOnce(
				() =>
					({
						getMethod: () => "m1",
						isAvailable: () => true,
						sendRequest: async () => {
							throw new Error("m1-fail");
						},
					}) as IIpcClient,
			)
			.mockImplementationOnce(
				() =>
					({
						getMethod: () => "m2",
						isAvailable: () => true,
						sendRequest: async (request) => ({ id: request.id, status: 200, result: { ok: true } }),
					}) as IIpcClient,
			);

		const fallback = IpcFactory.createWithFallback(["tcp", "unix"], {});
		const response = await fallback.sendRequest({ id: "fb-catch", method: "GET", path: "/" });
		expect(response.status).toBe(200);
		createSpy.mockRestore();

		if (originalEnv.AGENT_REMOTE_URL === undefined) delete process.env.AGENT_REMOTE_URL;
		else process.env.AGENT_REMOTE_URL = originalEnv.AGENT_REMOTE_URL;
		if (originalEnv.AGENT_REMOTE_API_KEY === undefined) delete process.env.AGENT_REMOTE_API_KEY;
		else process.env.AGENT_REMOTE_API_KEY = originalEnv.AGENT_REMOTE_API_KEY;
		if (originalEnv.AGENT_TCP_PORT === undefined) delete process.env.AGENT_TCP_PORT;
		else process.env.AGENT_TCP_PORT = originalEnv.AGENT_TCP_PORT;
		if (originalEnv.AGENT_HOST === undefined) delete process.env.AGENT_HOST;
		else process.env.AGENT_HOST = originalEnv.AGENT_HOST;
		if (originalEnv.AGENT_MODE === undefined) delete process.env.AGENT_MODE;
		else process.env.AGENT_MODE = originalEnv.AGENT_MODE;
	});
});
