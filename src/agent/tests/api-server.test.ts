import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AgentHttpServer } from "@/agent/api/server";
import type {
	RequestTrackerContract,
	RequestTrackerState,
	SessionMetadataContract,
	SessionPoolContract,
	TmuxManagerContract,
} from "@/packages/agent-runtime";

class MockSessionPoolService implements SessionPoolContract {
	public sessions: Map<string, SessionMetadataContract> = new Map();
	private started = false;

	async start(): Promise<void> {
		this.started = true;
	}

	async stop(): Promise<void> {
		this.started = false;
	}

	async getOrCreateSession(workspace: string): Promise<SessionMetadataContract> {
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

	getSession(workspace: string): SessionMetadataContract | undefined {
		return this.sessions.get(workspace);
	}

	async deleteSession(workspace: string): Promise<void> {
		this.sessions.delete(workspace);
	}

	listSessions(): SessionMetadataContract[] {
		return Array.from(this.sessions.values());
	}

	getStats() {
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
		if (session && session.activeRequests > 0) session.activeRequests--;
	}
}

class MockTmuxManager implements TmuxManagerContract {
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async listAllSessions(): Promise<string[]> {
		return [];
	}
	async sendToSession(): Promise<void> {}
}

class MockRequestTracker implements RequestTrackerContract {
	private states = new Map<string, RequestTrackerState>();

	async start(): Promise<void> {}
	async stop(): Promise<void> {}

	async createRequest(input: { requestId: string; chatId: string; workspace: string; prompt: string }): Promise<void> {
		this.states.set(input.requestId, {
			requestId: input.requestId,
			workspace: input.workspace,
			state: "created",
			createdAt: Date.now(),
		});
	}

	async updateState(
		requestId: string,
		updates: Partial<{
			state: string;
			queuedAt: number;
			processingStartedAt: number;
			completedAt: number;
			exitCode: number;
			output: string;
			error: string;
		}>,
	): Promise<void> {
		const current = this.states.get(requestId);
		if (!current) return;
		this.states.set(requestId, { ...current, ...updates });
	}

	async getRequest(requestId: string): Promise<RequestTrackerState | null> {
		return this.states.get(requestId) || null;
	}
}

describe("AgentHttpServer", () => {
	let server: AgentHttpServer;
	let sessionPool: MockSessionPoolService;
	let requestTracker: MockRequestTracker;
	let config: {
		port: number;
		host: string;
		apiKey: string;
		enableAuth: boolean;
		rateLimitMax: number;
		rateLimitWindow: string;
	};

	const injectJson = async (
		target: AgentHttpServer,
		input: {
			method: string;
			url: string;
			apiKey?: string;
			payload?: unknown;
			headers?: Record<string, string>;
		},
	) => {
		const headers: Record<string, string> = {
			...(input.headers || {}),
		};
		if (input.apiKey) headers["x-api-key"] = input.apiKey;
		if (input.payload !== undefined && !headers["content-type"]) {
			headers["content-type"] = "application/json";
		}
		return target.inject({
			method: input.method,
			url: input.url,
			headers,
			payload: input.payload !== undefined ? JSON.stringify(input.payload) : undefined,
		});
	};

	beforeEach(async () => {
		const tmuxManager = new MockTmuxManager();
		sessionPool = new MockSessionPoolService();
		requestTracker = new MockRequestTracker();

		await requestTracker.start();
		await sessionPool.start();

		config = {
			port: 0,
			host: "127.0.0.1",
			apiKey: "test-api-key",
			enableAuth: true,
			rateLimitMax: 100,
			rateLimitWindow: "1 minute",
		};

		server = new AgentHttpServer(config, sessionPool, requestTracker, tmuxManager);
	});

	afterEach(async () => {
		await server.stop();
		await sessionPool.stop();
		await requestTracker.stop();
	});

	describe("Server Lifecycle", () => {
		test.serial("should handle request via injection without binding network port", async () => {
			const response = await injectJson(server, {
				method: "GET",
				url: "/health",
				apiKey: "test-api-key",
			});
			expect([200, 503]).toContain(response.statusCode);
		});

		test.serial("stop should be safe before start", async () => {
			await expect(server.stop()).resolves.toBeUndefined();
		});
	});

	describe("Authentication", () => {
		test.serial("should reject request without API key when auth enabled", async () => {
			const response = await injectJson(server, { method: "GET", url: "/health" });
			expect(response.statusCode).toBe(401);
		});

		test.serial("should reject request with invalid API key", async () => {
			const response = await injectJson(server, {
				method: "GET",
				url: "/health",
				apiKey: "wrong-key",
			});
			expect(response.statusCode).toBe(401);
		});

		test.serial("should accept request with valid API key", async () => {
			const response = await injectJson(server, {
				method: "GET",
				url: "/health",
				apiKey: "test-api-key",
			});
			expect([200, 503]).toContain(response.statusCode);
		});
	});

	describe("POST /execute", () => {
		test.serial("should reject request without workspace", async () => {
			const response = await injectJson(server, {
				method: "POST",
				url: "/execute",
				apiKey: "test-api-key",
				payload: { command: "echo test" },
			});
			expect(response.statusCode).toBe(400);
			expect(response.json().error).toContain("Missing required fields");
		});

		test.serial("should reject request without command", async () => {
			const response = await injectJson(server, {
				method: "POST",
				url: "/execute",
				apiKey: "test-api-key",
				payload: { workspace: "test" },
			});
			expect(response.statusCode).toBe(400);
		});

		test.serial("should queue command and return requestId", async () => {
			const response = await injectJson(server, {
				method: "POST",
				url: "/execute",
				apiKey: "test-api-key",
				payload: { workspace: "test-workspace", command: "echo 'hello'" },
			});
			expect(response.statusCode).toBe(202);
			const data = response.json();
			expect(data.requestId).toBeDefined();
			expect(data.workspace).toBe("test-workspace");
			expect(data.status).toBe("queued");
		});
	});

	describe("GET /health", () => {
		test.serial("should return health status", async () => {
			const response = await injectJson(server, {
				method: "GET",
				url: "/health",
				apiKey: "test-api-key",
			});
			const data = response.json();
			expect(data.status).toBeDefined();
			expect(["healthy", "degraded", "unhealthy"]).toContain(data.status);
			expect(data.timestamp).toBeDefined();
			expect(data.checks).toBeDefined();
		});
	});

	describe("GET /sessions", () => {
		test.serial("should return empty sessions list initially", async () => {
			const response = await injectJson(server, {
				method: "GET",
				url: "/sessions",
				apiKey: "test-api-key",
			});
			expect(response.statusCode).toBe(200);
			const data = response.json();
			expect(data.sessions).toEqual([]);
			expect(data.total).toBe(0);
		});

		test.serial("should return sessions after creating one", async () => {
			await sessionPool.getOrCreateSession("test-workspace");
			const response = await injectJson(server, {
				method: "GET",
				url: "/sessions",
				apiKey: "test-api-key",
			});
			expect(response.statusCode).toBe(200);
			const data = response.json();
			expect(data.sessions).toHaveLength(1);
			expect(data.sessions[0].workspace).toBe("test-workspace");
			expect(data.total).toBe(1);
		});
	});

	describe("POST /session/create", () => {
		test.serial("should create new session", async () => {
			const response = await injectJson(server, {
				method: "POST",
				url: "/session/create",
				apiKey: "test-api-key",
				payload: { workspace: "new-workspace" },
			});
			expect(response.statusCode).toBe(201);
			const data = response.json();
			expect(data.workspace).toBe("new-workspace");
			expect(data.sessionName).toBeDefined();
			expect(data.status).toBeDefined();
			expect(data.createdAt).toBeDefined();
		});

		test.serial("should reject request without workspace", async () => {
			const response = await injectJson(server, {
				method: "POST",
				url: "/session/create",
				apiKey: "test-api-key",
				payload: {},
			});
			expect(response.statusCode).toBe(400);
		});

		test.serial("should be idempotent - return existing session", async () => {
			const response1 = await injectJson(server, {
				method: "POST",
				url: "/session/create",
				apiKey: "test-api-key",
				payload: { workspace: "same-workspace" },
			});
			const response2 = await injectJson(server, {
				method: "POST",
				url: "/session/create",
				apiKey: "test-api-key",
				payload: { workspace: "same-workspace" },
			});
			expect(response1.json().sessionName).toBe(response2.json().sessionName);
		});
	});

	describe("DELETE /session/:workspace", () => {
		test.serial("should delete existing session", async () => {
			await sessionPool.getOrCreateSession("delete-test");
			const response = await injectJson(server, {
				method: "DELETE",
				url: "/session/delete-test",
				apiKey: "test-api-key",
			});
			expect(response.statusCode).toBe(200);
			const data = response.json();
			expect(data.workspace).toBe("delete-test");
			expect(data.status).toBe("deleted");
		});

		test.serial("should return 404 for non-existent session", async () => {
			const response = await injectJson(server, {
				method: "DELETE",
				url: "/session/non-existent",
				apiKey: "test-api-key",
			});
			expect(response.statusCode).toBe(404);
		});

		test.serial("should return 409 when session has active requests", async () => {
			const workspace = "active-requests-test";
			await sessionPool.getOrCreateSession(workspace);
			sessionPool.trackRequestStart(workspace);
			const response = await injectJson(server, {
				method: "DELETE",
				url: `/session/${workspace}`,
				apiKey: "test-api-key",
			});
			expect(response.statusCode).toBe(409);
			sessionPool.trackRequestComplete(workspace);
		});

		test.serial("should force delete session with active requests", async () => {
			const workspace = "force-delete-test";
			await sessionPool.getOrCreateSession(workspace);
			sessionPool.trackRequestStart(workspace);
			const response = await injectJson(server, {
				method: "DELETE",
				url: `/session/${workspace}?force=true`,
				apiKey: "test-api-key",
			});
			expect(response.statusCode).toBe(200);
		});
	});

	describe("GET /status/:requestId", () => {
		test.serial("should return request status", async () => {
			const requestId = "test-status-request";
			await requestTracker.createRequest({
				requestId,
				chatId: "test",
				workspace: "test",
				prompt: "echo test",
			});
			const response = await injectJson(server, {
				method: "GET",
				url: `/status/${requestId}`,
				apiKey: "test-api-key",
			});
			expect(response.statusCode).toBe(200);
			const data = response.json();
			expect(data.requestId).toBe(requestId);
			expect(data.state).toBeDefined();
			expect(data.elapsed).toBeGreaterThanOrEqual(0);
		});

		test.serial("should return 404 for non-existent request", async () => {
			const response = await injectJson(server, {
				method: "GET",
				url: "/status/non-existent",
				apiKey: "test-api-key",
			});
			expect(response.statusCode).toBe(404);
		});
	});

	describe("GET /api-docs", () => {
		test.serial("should return OpenAPI specification", async () => {
			const response = await injectJson(server, {
				method: "GET",
				url: "/api-docs",
				apiKey: "test-api-key",
			});
			expect(response.statusCode).toBe(200);
			const data = response.json();
			expect(data.openapi).toBe("3.0.0");
			expect(data.info).toBeDefined();
			expect(data.paths).toBeDefined();
		});
	});

	describe("Rate Limiting", () => {
		test.serial("should enforce rate limit", async () => {
			const limitedServer = new AgentHttpServer(
				{
					...config,
					rateLimitMax: 3,
					rateLimitWindow: "10 seconds",
				},
				sessionPool,
				requestTracker,
				new MockTmuxManager(),
			);

			const responses: number[] = [];
			for (let i = 0; i < 5; i++) {
				const res = await injectJson(limitedServer, {
					method: "GET",
					url: "/sessions",
					apiKey: "test-api-key",
				});
				responses.push(res.statusCode);
			}

			const rateLimitedCount = responses.filter((s) => s === 429).length;
			expect(rateLimitedCount).toBeGreaterThanOrEqual(1);
			await limitedServer.stop();
		});
	});

	describe("CORS", () => {
		test.serial("should handle CORS preflight", async () => {
			const response = await injectJson(server, {
				method: "OPTIONS",
				url: "/health",
				headers: {
					origin: "http://example.com",
					"access-control-request-method": "GET",
				},
			});
			expect(response.headers["access-control-allow-origin"]).toBeDefined();
		});
	});

	describe("No Authentication Mode", () => {
		test.serial("should allow requests without API key when auth disabled", async () => {
			const noAuthServer = new AgentHttpServer(
				{
					...config,
					enableAuth: false,
				},
				sessionPool,
				requestTracker,
				new MockTmuxManager(),
			);

			const response = await injectJson(noAuthServer, {
				method: "GET",
				url: "/health",
			});
			expect([200, 503]).toContain(response.statusCode);
			await noAuthServer.stop();
		});
	});
});
