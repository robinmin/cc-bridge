import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { AgentHttpServer } from "@/agent/api/server";
import { RequestTracker } from "@/gateway/services/RequestTracker";
import type { SessionMetadata, SessionPoolService } from "@/gateway/services/SessionPoolService";
import type { TmuxManager } from "@/gateway/services/tmux-manager";

// Mock SessionPoolService - implements required methods
class MockSessionPoolService implements Partial<SessionPoolService> {
	public sessions: Map<string, SessionMetadata> = new Map();
	private started = false;

	async start(): Promise<void> {
		this.started = true;
	}

	async stop(): Promise<void> {
		this.started = false;
	}

	isRunning(): boolean {
		return this.started;
	}

	async getOrCreateSession(workspace: string): Promise<SessionMetadata> {
		let session = this.sessions.get(workspace);
		if (!session) {
			session = {
				workspace,
				sessionName: `claude-${workspace}`,
				containerId: "test-container",
				status: "active",
				createdAt: Date.now(),
				lastActivityAt: Date.now(),
				activeRequests: 0,
				totalRequests: 0,
			};
			this.sessions.set(workspace, session);
		}
		return session;
	}

	getSession(workspace: string): SessionMetadata | undefined {
		return this.sessions.get(workspace);
	}

	async deleteSession(workspace: string): Promise<void> {
		this.sessions.delete(workspace);
	}

	listSessions(): SessionMetadata[] {
		return Array.from(this.sessions.values());
	}

	getStats(): {
		totalSessions: number;
		activeSessions: number;
		idleSessions: number;
		terminatingSessions: number;
		destroyed: boolean;
		started: boolean;
	} {
		return {
			totalSessions: this.sessions.size,
			activeSessions: this.sessions.size,
			idleSessions: 0,
			terminatingSessions: 0,
			destroyed: false,
			started: this.started,
		};
	}

	trackRequestStart(workspace: string): void {
		const session = this.sessions.get(workspace);
		if (session) {
			session.activeRequests++;
			session.totalRequests++;
		}
	}

	trackRequestComplete(workspace: string): void {
		const session = this.sessions.get(workspace);
		if (session && session.activeRequests > 0) {
			session.activeRequests--;
		}
	}

	// Additional required methods
	async cleanup(): Promise<void> {
		// No-op for mock
	}

	isDestroyed(): boolean {
		return !this.started;
	}

	async switchWorkspace(_currentWorkspace: string, _targetWorkspace: string): Promise<SessionMetadata> {
		throw new Error("switchWorkspace not implemented in mock");
	}
}

// Mock TmuxManager - implements required methods
class MockTmuxManager implements Partial<TmuxManager> {
	private started = false;

	async start(): Promise<void> {
		this.started = true;
	}

	async stop(): Promise<void> {
		this.started = false;
	}

	isRunning(): boolean {
		return this.started;
	}

	async listAllSessions(): Promise<string[]> {
		return [];
	}

	// Additional required methods - no-op implementations
	async getOrCreateSession(): Promise<string> {
		return "mock-session";
	}

	async sendToSession(): Promise<{
		success: boolean;
		exitCode?: number;
		output?: string;
		error?: string;
	}> {
		return { success: true };
	}

	async sessionExists(): Promise<boolean> {
		return false;
	}

	async listSessions(): Promise<string[]> {
		return [];
	}

	async killSession(): Promise<void> {
		// No-op
	}

	async cleanupIdleSessions(): Promise<number> {
		return 0;
	}

	getSessionInfo(): undefined {
		return undefined;
	}

	getAllSessions(): never[] {
		return [];
	}

	async createWorkspaceSession(): Promise<void> {
		// No-op
	}

	async killWorkspaceSession(): Promise<void> {
		// No-op
	}

	async syncSessions(): Promise<void> {
		// No-op
	}
}

describe("AgentHttpServer", () => {
	let server: AgentHttpServer;
	let sessionPool: MockSessionPoolService;
	let requestTracker: RequestTracker;
	let testStateDir: string;
	let config: {
		port: number;
		host: string;
		apiKey: string;
		enableAuth: boolean;
		rateLimitMax: number;
		rateLimitWindow: string;
	};

	beforeEach(async () => {
		testStateDir = `/tmp/test-api-server-state-${Date.now()}`;
		await mkdir(testStateDir, { recursive: true });

		// Initialize services
		const tmuxManager = new MockTmuxManager();
		sessionPool = new MockSessionPoolService();

		requestTracker = new RequestTracker({
			stateBaseDir: testStateDir,
		});

		await requestTracker.start();
		await sessionPool.start();

		config = {
			port: 0, // Use random port for testing
			host: "127.0.0.1",
			apiKey: "test-api-key",
			enableAuth: true,
			rateLimitMax: 100,
			rateLimitWindow: "1 minute",
		};

		server = new AgentHttpServer(config, sessionPool as SessionPoolService, requestTracker, tmuxManager as TmuxManager);
	});

	afterEach(async () => {
		if (server) {
			await server.stop();
		}
		await sessionPool.stop();
		await requestTracker.stop();
		await rm(testStateDir, { recursive: true, force: true });
	});

	describe("Server Lifecycle", () => {
		test("should start and stop server", async () => {
			await server.start();

			expect(server.isRunning()).toBe(true);

			await server.stop();

			expect(server.isRunning()).toBe(false);
		});

		test("should handle starting already started server", async () => {
			await server.start();
			await server.start(); // Should not throw

			expect(server.isRunning()).toBe(true);
		});
	});

	describe("Authentication", () => {
		test("should reject request without API key when auth enabled", async () => {
			await server.start();

			const response = await fetch(`http://127.0.0.1:${server.getPort()}/health`);

			expect(response.status).toBe(401);
		});

		test("should reject request with invalid API key", async () => {
			await server.start();

			const response = await fetch(`http://127.0.0.1:${server.getPort()}/health`, {
				headers: {
					"X-API-Key": "wrong-key",
				},
			});

			expect(response.status).toBe(401);
		});

		test("should accept request with valid API key", async () => {
			await server.start();

			const response = await fetch(`http://127.0.0.1:${server.getPort()}/health`, {
				headers: {
					"X-API-Key": "test-api-key",
				},
			});

			// May return 200 or 503 depending on health status
			expect([200, 503]).toContain(response.status);
		});
	});

	describe("POST /execute", () => {
		test("should reject request without workspace", async () => {
			await server.start();

			const response = await fetch(`http://127.0.0.1:${server.getPort()}/execute`, {
				method: "POST",
				headers: {
					"X-API-Key": "test-api-key",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ command: "echo test" }),
			});

			expect(response.status).toBe(400);

			const data = await response.json();
			expect(data.error).toContain("Missing required fields");
		});

		test("should reject request without command", async () => {
			await server.start();

			const response = await fetch(`http://127.0.0.1:${server.getPort()}/execute`, {
				method: "POST",
				headers: {
					"X-API-Key": "test-api-key",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ workspace: "test" }),
			});

			expect(response.status).toBe(400);
		});

		test("should queue command and return requestId", async () => {
			await server.start();

			const response = await fetch(`http://127.0.0.1:${server.getPort()}/execute`, {
				method: "POST",
				headers: {
					"X-API-Key": "test-api-key",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					workspace: "test-workspace",
					command: "echo 'hello'",
				}),
			});

			expect(response.status).toBe(202);

			const data = await response.json();
			expect(data.requestId).toBeDefined();
			expect(data.workspace).toBe("test-workspace");
			expect(data.status).toBe("queued");
		});
	});

	describe("GET /health", () => {
		test("should return health status", async () => {
			await server.start();

			const response = await fetch(`http://127.0.0.1:${server.getPort()}/health`, {
				headers: {
					"X-API-Key": "test-api-key",
				},
			});

			const data = await response.json();

			expect(data.status).toBeDefined();
			expect(["healthy", "degraded", "unhealthy"]).toContain(data.status);
			expect(data.timestamp).toBeDefined();
			expect(data.checks).toBeDefined();
		});
	});

	describe("GET /sessions", () => {
		test("should return empty sessions list initially", async () => {
			await server.start();

			const response = await fetch(`http://127.0.0.1:${server.getPort()}/sessions`, {
				headers: {
					"X-API-Key": "test-api-key",
				},
			});

			expect(response.status).toBe(200);

			const data = await response.json();
			expect(data.sessions).toEqual([]);
			expect(data.total).toBe(0);
		});

		test("should return sessions after creating one", async () => {
			await server.start();

			// Create a session via the session pool
			await sessionPool.getOrCreateSession("test-workspace");

			const response = await fetch(`http://127.0.0.1:${server.getPort()}/sessions`, {
				headers: {
					"X-API-Key": "test-api-key",
				},
			});

			expect(response.status).toBe(200);

			const data = await response.json();
			expect(data.sessions).toHaveLength(1);
			expect(data.sessions[0].workspace).toBe("test-workspace");
			expect(data.total).toBe(1);
		});
	});

	describe("POST /session/create", () => {
		test("should create new session", async () => {
			await server.start();

			const response = await fetch(`http://127.0.0.1:${server.getPort()}/session/create`, {
				method: "POST",
				headers: {
					"X-API-Key": "test-api-key",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ workspace: "new-workspace" }),
			});

			expect(response.status).toBe(201);

			const data = await response.json();
			expect(data.workspace).toBe("new-workspace");
			expect(data.sessionName).toBeDefined();
			expect(data.status).toBeDefined();
			expect(data.createdAt).toBeDefined();
		});

		test("should reject request without workspace", async () => {
			await server.start();

			const response = await fetch(`http://127.0.0.1:${server.getPort()}/session/create`, {
				method: "POST",
				headers: {
					"X-API-Key": "test-api-key",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({}),
			});

			expect(response.status).toBe(400);
		});

		test("should be idempotent - return existing session", async () => {
			await server.start();

			// Create session first time
			const response1 = await fetch(`http://127.0.0.1:${server.getPort()}/session/create`, {
				method: "POST",
				headers: {
					"X-API-Key": "test-api-key",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ workspace: "same-workspace" }),
			});

			// Create session second time
			const response2 = await fetch(`http://127.0.0.1:${server.getPort()}/session/create`, {
				method: "POST",
				headers: {
					"X-API-Key": "test-api-key",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ workspace: "same-workspace" }),
			});

			const data1 = await response1.json();
			const data2 = await response2.json();

			expect(data1.sessionName).toBe(data2.sessionName);
		});
	});

	describe("DELETE /session/:workspace", () => {
		test("should delete existing session", async () => {
			await server.start();

			// Create a session first
			await sessionPool.getOrCreateSession("delete-test");

			const response = await fetch(`http://127.0.0.1:${server.getPort()}/session/delete-test`, {
				method: "DELETE",
				headers: {
					"X-API-Key": "test-api-key",
				},
			});

			expect(response.status).toBe(200);

			const data = await response.json();
			expect(data.workspace).toBe("delete-test");
			expect(data.status).toBe("deleted");
		});

		test("should return 404 for non-existent session", async () => {
			await server.start();

			const response = await fetch(`http://127.0.0.1:${server.getPort()}/session/non-existent`, {
				method: "DELETE",
				headers: {
					"X-API-Key": "test-api-key",
				},
			});

			expect(response.status).toBe(404);
		});

		test("should return 409 when session has active requests", async () => {
			await server.start();

			const workspace = "active-requests-test";
			await sessionPool.getOrCreateSession(workspace);
			sessionPool.trackRequestStart(workspace);

			const response = await fetch(`http://127.0.0.1:${server.getPort()}/session/${workspace}`, {
				method: "DELETE",
				headers: {
					"X-API-Key": "test-api-key",
				},
			});

			expect(response.status).toBe(409);

			// Clean up
			sessionPool.trackRequestComplete(workspace);
		});

		test("should force delete session with active requests", async () => {
			await server.start();

			const workspace = "force-delete-test";
			await sessionPool.getOrCreateSession(workspace);
			sessionPool.trackRequestStart(workspace);

			const response = await fetch(`http://127.0.0.1:${server.getPort()}/session/${workspace}?force=true`, {
				method: "DELETE",
				headers: {
					"X-API-Key": "test-api-key",
				},
			});

			expect(response.status).toBe(200);
		});
	});

	describe("GET /status/:requestId", () => {
		test("should return request status", async () => {
			await server.start();

			// Create a request
			const requestId = "test-status-request";
			await requestTracker.createRequest({
				requestId,
				chatId: "test",
				workspace: "test",
				prompt: "echo test",
			});

			const response = await fetch(`http://127.0.0.1:${server.getPort()}/status/${requestId}`, {
				headers: {
					"X-API-Key": "test-api-key",
				},
			});

			expect(response.status).toBe(200);

			const data = await response.json();
			expect(data.requestId).toBe(requestId);
			expect(data.state).toBeDefined();
			expect(data.elapsed).toBeGreaterThanOrEqual(0);
		});

		test("should return 404 for non-existent request", async () => {
			await server.start();

			const response = await fetch(`http://127.0.0.1:${server.getPort()}/status/non-existent`, {
				headers: {
					"X-API-Key": "test-api-key",
				},
			});

			expect(response.status).toBe(404);
		});
	});

	describe("GET /api-docs", () => {
		test("should return OpenAPI specification", async () => {
			await server.start();

			const response = await fetch(`http://127.0.0.1:${server.getPort()}/api-docs`, {
				headers: {
					"X-API-Key": "test-api-key",
				},
			});

			expect(response.status).toBe(200);

			const data = await response.json();
			expect(data.openapi).toBe("3.0.0");
			expect(data.info).toBeDefined();
			expect(data.paths).toBeDefined();
		});
	});

	describe("Rate Limiting", () => {
		test("should enforce rate limit", async () => {
			// Create server with low rate limit for testing
			const limitedServer = new AgentHttpServer(
				{
					...config,
					rateLimitMax: 3, // Even lower limit
					rateLimitWindow: "10 seconds", // Longer window
				},
				sessionPool as SessionPoolService,
				requestTracker,
				new MockTmuxManager() as TmuxManager,
			);

			await limitedServer.start();
			const port = limitedServer.getPort();

			// First, verify a single request works
			const singleResponse = await fetch(`http://127.0.0.1:${port}/sessions`, {
				headers: {
					"X-API-Key": "test-api-key",
				},
			});
			console.log("Single request status:", singleResponse.status);
			expect(singleResponse.status).toBe(200);

			// Now send 5 requests sequentially (should trigger rate limit)
			const responses: Array<{
				status: number;
				headers: Record<string, string>;
			}> = [];
			for (let i = 0; i < 5; i++) {
				const response = await fetch(`http://127.0.0.1:${port}/sessions`, {
					headers: {
						"X-API-Key": "test-api-key",
					},
				});
				const headers: Record<string, string> = {};
				response.headers.forEach((value, key) => {
					headers[key] = value;
				});
				responses.push({ status: response.status, headers });
				// Small delay between requests
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			console.log("Sequential responses:");
			responses.forEach((r, i) => {
				console.log(
					`  Request ${i + 1}: status=${r.status}, rateLimit=${r.headers["x-ratelimit-limit"]}, remaining=${r.headers["x-ratelimit-remaining"]}, reset=${r.headers["x-ratelimit-reset"]}`,
				);
			});
			const rateLimitedCount = responses.filter((r) => r.status === 429).length;

			await limitedServer.stop();

			// With max 3, at least the 4th and 5th requests should be rate limited
			expect(rateLimitedCount).toBeGreaterThanOrEqual(1);
		});
	});

	describe("CORS", () => {
		test("should handle CORS preflight", async () => {
			await server.start();

			const response = await fetch(`http://127.0.0.1:${server.getPort()}/health`, {
				method: "OPTIONS",
				headers: {
					Origin: "http://example.com",
					"Access-Control-Request-Method": "GET",
				},
			});

			// Should have CORS headers
			expect(response.headers.get("access-control-allow-origin")).not.toBeNull();
		});
	});

	describe("No Authentication Mode", () => {
		test("should allow requests without API key when auth disabled", async () => {
			const noAuthServer = new AgentHttpServer(
				{
					...config,
					enableAuth: false,
				},
				sessionPool as SessionPoolService,
				requestTracker,
				new MockTmuxManager() as TmuxManager,
			);

			await noAuthServer.start();
			const port = noAuthServer.getPort();

			const response = await fetch(`http://127.0.0.1:${port}/health`);

			// Should not require auth
			expect([200, 503]).toContain(response.status);

			await noAuthServer.stop();
		});
	});
});
