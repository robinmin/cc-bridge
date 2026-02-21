import fastifyCors from "@fastify/cors";
import { fastifyRateLimit } from "@fastify/rate-limit";
import { randomUUIDv7 } from "bun";
import type { InjectOptions } from "fastify";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import fastify from "fastify";
import { z } from "zod";
import type { RequestTrackerContract, SessionPoolContract, TmuxManagerContract } from "@/packages/agent-runtime";
import { createErrorResponse, getStatusCode } from "@/packages/errors";
import { logger } from "@/packages/logger";

/**
 * HTTP Server configuration
 */
export interface HttpServerConfig {
	port: number;
	host: string;
	apiKey: string;
	enableAuth: boolean;
	rateLimitMax: number;
	rateLimitWindow: string;
}

/**
 * HTTP Server for Agent container
 * Provides REST API for executing commands, managing sessions, and health checks
 */
export class AgentHttpServer {
	private app: FastifyInstance;
	private config: HttpServerConfig;
	private sessionPool: SessionPoolContract;
	private requestTracker: RequestTrackerContract;
	private tmuxManager: TmuxManagerContract;
	private started = false;

	constructor(
		config: HttpServerConfig,
		sessionPool: SessionPoolContract,
		requestTracker: RequestTrackerContract,
		tmuxManager: TmuxManagerContract,
	) {
		this.config = config;
		this.sessionPool = sessionPool;
		this.requestTracker = requestTracker;
		this.tmuxManager = tmuxManager;

		const fastifyOptions: FastifyServerOptions = {
			logger: false,
			requestIdHeader: "x-request-id",
			genReqId: () => randomUUIDv7(),
		};

		this.app = fastify(fastifyOptions);

		// Register middleware in order: CORS -> Rate Limiting -> Auth -> Routes
		this.registerMiddleware();
		this.registerRateLimiting();

		// Use after() to ensure rate limiting is loaded before registering routes
		this.app.after((err) => {
			if (err) {
				logger.error({ err }, "Failed to load rate limiting plugin");
			}
			this.registerRoutes();
		});

		logger.info({ port: config.port, host: config.host }, "AgentHttpServer created");
	}

	/**
	 * Start HTTP server
	 */
	async start(): Promise<void> {
		if (this.started) {
			logger.warn("AgentHttpServer already started");
			return;
		}

		try {
			await this.app.listen({
				port: this.config.port,
				host: this.config.host,
			});

			this.started = true;
			logger.info(
				{
					port: this.config.port,
					host: this.config.host,
					auth: this.config.enableAuth,
				},
				"Agent HTTP server started",
			);
		} catch (err) {
			logger.error({ err }, "Failed to start HTTP server");
			throw err;
		}
	}

	/**
	 * Stop HTTP server
	 */
	async stop(): Promise<void> {
		if (!this.started) {
			return;
		}

		try {
			await this.app.close();
			this.started = false;
			logger.info("Agent HTTP server stopped");
		} catch (err) {
			logger.error({ err }, "Failed to stop HTTP server");
			throw err;
		}
	}

	/**
	 * Check if server is running
	 */
	isRunning(): boolean {
		return this.started;
	}

	/**
	 * Get server port (for testing)
	 * When server is running with port 0, returns the actual bound port
	 */
	getPort(): number {
		if (this.started && this.app.server) {
			const address = this.app.server.address();
			return typeof address === "string" ? 0 : (address?.port ?? this.config.port);
		}
		return this.config.port;
	}

	async inject(options: InjectOptions): Promise<Awaited<ReturnType<FastifyInstance["inject"]>>> {
		await this.app.ready();
		return this.app.inject(options);
	}

	/**
	 * Register middleware
	 */
	private registerMiddleware(): void {
		// CORS
		this.app.register(fastifyCors, {
			origin: true,
		});

		// Authentication middleware
		if (this.config.enableAuth) {
			this.app.addHook("preHandler", async (request, reply) => {
				const apiKey = request.headers["x-api-key"];

				if (!apiKey || apiKey !== this.config.apiKey) {
					reply.code(401).send({ error: "Unauthorized" });
					return;
				}
			});
		}

		// Error handler
		this.app.setErrorHandler((error, request, reply) => {
			if (reply.sent || reply.raw.headersSent) {
				logger.debug(
					{ requestId: request.id, replySent: reply.sent, headersSent: reply.raw.headersSent },
					"Skipping error handler because response was already started",
				);
				return;
			}

			logger.error({ err: error, requestId: request.id }, "HTTP request error");

			const statusCode = getStatusCode(error);
			const response = createErrorResponse(error, request.id);

			reply.code(statusCode).send(response);
			return;
		});
	}

	/**
	 * Register rate limiting plugin
	 * This must be registered before routes are defined
	 */
	private registerRateLimiting(): void {
		this.app.register(fastifyRateLimit, {
			global: true,
			max: this.config.rateLimitMax,
			timeWindow: this.config.rateLimitWindow,
			redis: undefined, // Use in-memory store
			cache: 10000,
			allowList: [],
			continueExceeding: false,
			skipOnError: false,
			addHeaders: {
				"x-ratelimit-limit": true,
				"x-ratelimit-remaining": true,
				"x-ratelimit-reset": true,
			},
			// Use a simple key generator that always returns a valid string
			keyGenerator: (request) => {
				const apiKey = request.headers["x-api-key"] as string | undefined;
				const ip = request.ip || "unknown";
				// Always return a valid string for consistent rate limiting
				return apiKey || ip;
			},
			onExceeding: (req) => {
				logger.warn({ ip: req.ip, path: req.url }, "Rate limit exceeded");
			},
			onExceeded: (req) => {
				logger.error({ ip: req.ip, path: req.url }, "Rate limit exceeded - request blocked");
			},
		});
	}

	/**
	 * Register API routes
	 */
	private registerRoutes(): void {
		const ExecuteRequestSchema = z.object({
			workspace: z.string().min(1),
			command: z.string().min(1),
			chatId: z.union([z.string(), z.number()]).optional(),
			timeoutMs: z.number().int().positive().optional(),
		});
		const CreateSessionSchema = z.object({
			workspace: z.string().min(1),
		});

		// POST /execute - Execute command
		this.app.post("/execute", async (request, reply) => {
			const parsed = ExecuteRequestSchema.safeParse(request.body);
			if (!parsed.success) {
				reply.code(400).send({
					error: "Missing required fields: workspace, command",
				});
				return;
			}
			const { workspace, command, chatId, timeoutMs } = parsed.data;

			try {
				// Generate requestId
				const requestId = randomUUIDv7();

				// Create request state
				await this.requestTracker.createRequest({
					requestId,
					chatId: chatId || "http-api",
					workspace,
					prompt: command,
				});

				// Update to queued state
				await this.requestTracker.updateState(requestId, {
					state: "queued",
					queuedAt: Date.now(),
				});

				// Get or create session
				const session = await this.sessionPool.getOrCreateSession(workspace);

				// Track request start
				this.sessionPool.trackRequestStart(workspace);

				// Execute command asynchronously
				this.executeCommand(
					requestId,
					workspace,
					String(chatId || "http-api"),
					command,
					session.containerId,
					session.sessionName,
					timeoutMs,
				)
					.then(async (result) => {
						await this.requestTracker.updateState(requestId, {
							state: result.success ? "completed" : "failed",
							completedAt: Date.now(),
							exitCode: result.exitCode,
							output: result.output,
							error: result.error,
						});
						this.sessionPool.trackRequestComplete(workspace);
					})
					.catch(async (err) => {
						logger.error({ err, requestId }, "Command execution failed");
						await this.requestTracker.updateState(requestId, {
							state: "failed",
							completedAt: Date.now(),
							error: String(err),
						});
						this.sessionPool.trackRequestComplete(workspace);
					});

				reply.code(202).send({
					requestId,
					workspace,
					status: "queued",
					message: "Command queued for execution",
				});
				return;
			} catch (err) {
				logger.error({ err }, "Execute endpoint failed");
				reply.code(500).send({
					error: "Internal server error",
					message: err instanceof Error ? err.message : String(err),
				});
				return;
			}
		});

		// GET /health - Health check
		this.app.get("/health", async (_request, reply) => {
			try {
				const health = await this.getHealthStatus();
				const statusCode = health.status === "healthy" ? 200 : 503;

				reply.code(statusCode).send(health);
				return;
			} catch (err) {
				logger.error({ err }, "Health check failed");
				reply.code(500).send({
					status: "unhealthy",
					error: err instanceof Error ? err.message : String(err),
				});
				return;
			}
		});

		// GET /sessions - List sessions
		this.app.get("/sessions", async (_request, reply) => {
			try {
				const sessions = this.sessionPool.listSessions();

				const sessionsData = sessions.map((s) => ({
					workspace: s.workspace,
					sessionName: s.sessionName,
					status: s.status,
					createdAt: s.createdAt,
					lastActivityAt: s.lastActivityAt,
					activeRequests: s.activeRequests,
					totalRequests: s.totalRequests,
					age: Date.now() - s.createdAt,
				}));

				reply.send({
					sessions: sessionsData,
					total: sessionsData.length,
				});
				return;
			} catch (err) {
				logger.error({ err }, "List sessions failed");
				reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
				return;
			}
		});

		// POST /session/create - Create session
		this.app.post("/session/create", async (request, reply) => {
			const parsed = CreateSessionSchema.safeParse(request.body);
			if (!parsed.success) {
				reply.code(400).send({ error: "Missing workspace" });
				return;
			}
			const { workspace } = parsed.data;

			try {
				const session = await this.sessionPool.getOrCreateSession(workspace);

				reply.code(201).send({
					workspace: session.workspace,
					sessionName: session.sessionName,
					status: session.status,
					createdAt: session.createdAt,
				});
				return;
			} catch (err) {
				logger.error({ err, workspace }, "Create session failed");
				reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
				return;
			}
		});

		// DELETE /session/:workspace - Delete session
		this.app.delete<{
			Params: { workspace: string };
			Querystring: { force?: string };
		}>("/session/:workspace", async (request, reply) => {
			const { workspace } = request.params;
			const { force } = request.query;

			try {
				const session = this.sessionPool.getSession(workspace);

				if (!session) {
					reply.code(404).send({
						error: `Session not found: ${workspace}`,
					});
					return;
				}

				// Check for active requests
				if (session.activeRequests > 0 && force !== "true") {
					reply.code(409).send({
						error: `Session has ${session.activeRequests} active requests`,
						message: "Use ?force=true to terminate anyway",
					});
					return;
				}

				await this.sessionPool.deleteSession(workspace);

				reply.send({
					workspace,
					status: "deleted",
				});
				return;
			} catch (err) {
				logger.error({ err, workspace }, "Delete session failed");
				reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
				return;
			}
		});

		// GET /status/:requestId - Query request status
		this.app.get<{ Params: { requestId: string } }>("/status/:requestId", async (request, reply) => {
			const { requestId } = request.params;

			try {
				const requestData = await this.requestTracker.getRequest(requestId);

				if (!requestData) {
					reply.code(404).send({
						error: `Request not found: ${requestId}`,
					});
					return;
				}

				const elapsed = Date.now() - requestData.createdAt;
				const duration = requestData.completedAt ? requestData.completedAt - requestData.createdAt : elapsed;

				reply.send({
					requestId: requestData.requestId,
					workspace: requestData.workspace,
					state: requestData.state,
					createdAt: requestData.createdAt,
					completedAt: requestData.completedAt,
					elapsed,
					duration,
					error: requestData.error,
				});
				return;
			} catch (err) {
				logger.error({ err, requestId }, "Status query failed");
				reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
				return;
			}
		});

		// GET /api-docs - OpenAPI documentation
		this.app.get("/api-docs", async (_request, reply) => {
			reply.send(this.getOpenApiSpec());
			return;
		});
	}

	/**
	 * Execute command in tmux session
	 */
	private async executeCommand(
		requestId: string,
		workspace: string,
		chatId: string,
		command: string,
		containerId: string,
		sessionName: string,
		timeoutMs?: number,
	): Promise<{
		success: boolean;
		exitCode?: number;
		output?: string;
		error?: string;
	}> {
		try {
			// Update to processing state
			await this.requestTracker.updateState(requestId, {
				state: "processing",
				processingStartedAt: Date.now(),
			});

			// Send command to tmux session
			await this.tmuxManager.sendToSession(
				containerId,
				sessionName,
				command,
				{
					requestId,
					chatId,
					workspace,
				},
				timeoutMs,
			);

			return {
				success: true,
			};
		} catch (err) {
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	/**
	 * Get health status
	 */
	private async getHealthStatus(): Promise<{
		status: "healthy" | "degraded" | "unhealthy";
		timestamp: string;
		checks: Record<string, unknown>;
	}> {
		const checks: Record<string, unknown> = {
			tmuxServer: await this.checkTmuxServer(),
			sessions: await this.checkSessions(),
			filesystem: await this.checkFilesystem(),
			gateway: await this.checkGateway(),
		};

		const allHealthy = Object.values(checks).every((c) => (c as { healthy: boolean }).healthy);

		return {
			status: allHealthy ? "healthy" : "degraded",
			timestamp: new Date().toISOString(),
			checks,
		};
	}

	/**
	 * Check tmux server health
	 */
	private async checkTmuxServer(): Promise<{
		healthy: boolean;
		sessionsCount?: number;
		error?: string;
	}> {
		try {
			const sessions = await this.tmuxManager.listAllSessions(this.getTmuxHealthContainerId());
			return {
				healthy: true,
				sessionsCount: sessions.length,
			};
		} catch (err) {
			return {
				healthy: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	/**
	 * Check sessions health
	 */
	private async checkSessions(): Promise<{
		healthy: boolean;
		stats?: unknown;
		error?: string;
	}> {
		try {
			const stats = this.sessionPool.getStats();
			return {
				healthy: true,
				stats,
			};
		} catch (err) {
			return {
				healthy: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	/**
	 * Check filesystem health
	 */
	private async checkFilesystem(): Promise<{
		healthy: boolean;
		error?: string;
	}> {
		try {
			// Simple filesystem check - try to write a test file
			const fs = await import("node:fs/promises");
			const testFile = `/tmp/.health-check-${process.pid}-${Date.now()}-${randomUUIDv7()}`;
			await fs.writeFile(testFile, "ok");
			await fs.unlink(testFile);

			return { healthy: true };
		} catch (err) {
			return {
				healthy: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	/**
	 * Check gateway connectivity
	 */
	private async checkGateway(): Promise<{ healthy: boolean; error?: string }> {
		try {
			const healthUrl = this.getGatewayHealthUrl();

			// Try to reach the gateway health endpoint
			const response = await fetch(healthUrl, {
				method: "GET",
				signal: AbortSignal.timeout(5000),
			}).catch(() => null);

			if (response?.ok) {
				return { healthy: true };
			}

			return {
				healthy: false,
				error: `Gateway health check failed (${healthUrl})`,
			};
		} catch (err) {
			return {
				healthy: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	private getTmuxHealthContainerId(): string {
		return process.env.AGENT_HEALTH_CONTAINER_ID || process.env.AGENT_CONTAINER_ID || "claude-agent";
	}

	private getGatewayHealthUrl(): string {
		if (process.env.GATEWAY_HEALTH_URL) {
			return process.env.GATEWAY_HEALTH_URL;
		}

		const gatewayBaseUrl = process.env.GATEWAY_URL || "http://gateway:8080";
		try {
			return new URL("/health", gatewayBaseUrl).toString();
		} catch {
			return "http://gateway:8080/health";
		}
	}

	/**
	 * Get OpenAPI specification
	 */
	private getOpenApiSpec(): Record<string, unknown> {
		return {
			openapi: "3.0.0",
			info: {
				title: "Claude Agent HTTP API",
				version: "1.0.0",
				description: "HTTP API for Claude Agent container",
			},
			paths: {
				"/execute": {
					post: {
						summary: "Execute command in Claude session",
						requestBody: {
							required: true,
							content: {
								"application/json": {
									schema: {
										type: "object",
									required: ["workspace", "command"],
									properties: {
										workspace: { type: "string" },
										command: { type: "string" },
										chatId: { oneOf: [{ type: "string" }, { type: "number" }] },
										timeoutMs: { type: "number" },
									},
								},
							},
							},
						},
						responses: {
							"202": { description: "Command queued" },
							"400": { description: "Invalid request" },
							"401": { description: "Unauthorized" },
							"500": { description: "Server error" },
						},
					},
				},
				"/health": {
					get: {
						summary: "Health check",
						responses: {
							"200": { description: "Healthy" },
							"503": { description: "Unhealthy or degraded" },
						},
					},
				},
				"/sessions": {
					get: {
						summary: "List all sessions",
						responses: {
							"200": { description: "List of sessions" },
						},
					},
				},
				"/session/create": {
					post: {
						summary: "Create a new session",
						responses: {
							"201": { description: "Session created" },
							"400": { description: "Invalid request" },
						},
					},
				},
				"/session/{workspace}": {
					delete: {
						summary: "Delete a session",
						responses: {
							"200": { description: "Session deleted" },
							"404": { description: "Session not found" },
							"409": { description: "Session has active requests" },
						},
					},
				},
				"/status/{requestId}": {
					get: {
						summary: "Get request status",
						responses: {
							"200": { description: "Request status" },
							"404": { description: "Request not found" },
						},
					},
				},
			},
		};
	}
}
