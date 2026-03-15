/**
 * OpenTelemetry Service for EmbeddedAgent
 *
 * Provides OpenTelemetry integration with:
 * - Traces: spans for agent runs, tool executions, LLM calls
 * - Metrics: token usage, cost, duration, turn counts
 * - Logs: optional structured logging via OTLP
 *
 * Inspired by openclaw's diagnostics-otel extension.
 */

import { type Meter, metrics, type Span, type Tracer, trace } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ParentBasedSampler, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { AgentUsageSnapshot } from "./observability";

const DEFAULT_SERVICE_NAME = "cc-bridge-agent";

/**
 * OTEL configuration for the agent
 */
export interface AgentOtelConfig {
	/** Enable OTEL (default: false) */
	enabled?: boolean;
	/** OTLP endpoint (e.g., http://localhost:4318) */
	endpoint?: string;
	/** Protocol (default: http/protobuf) */
	protocol?: "http/protobuf";
	/** Service name (default: cc-bridge-agent) */
	serviceName?: string;
	/** Sample rate 0-1 (default: 1.0) */
	sampleRate?: number;
	/** Enable traces (default: true) */
	traces?: boolean;
	/** Enable metrics (default: true) */
	metrics?: boolean;
	/** Flush interval in ms (default: 60000) */
	flushIntervalMs?: number;
	/** Additional headers for OTLP exporter */
	headers?: Record<string, string>;
}

/**
 * OTEL service instance
 */
export interface AgentOtelService {
	/** Get a tracer for the agent */
	getTracer(name?: string): Tracer;
	/** Get the meter for metrics */
	getMeter(name?: string): Meter;
	/** Start a new span for an agent run */
	startRunSpan(attributes: Record<string, string | number>): Span;
	/** Record token usage metrics */
	recordUsage(usage: AgentUsageSnapshot, attributes: Record<string, string | number>): void;
	/** Record agent run duration */
	recordRunDuration(durationMs: number, attributes: Record<string, string | number>): void;
	/** Shutdown the service */
	shutdown(): Promise<void>;
}

/**
 * Normalize OTEL endpoint URL
 */
function normalizeEndpoint(endpoint?: string): string | undefined {
	const trimmed = endpoint?.trim();
	return trimmed ? trimmed.replace(/\/+$/, "") : undefined;
}

/**
 * Resolve OTLP URL from endpoint and path
 */
function resolveOtelUrl(endpoint: string | undefined, path: string): string | undefined {
	if (!endpoint) {
		return undefined;
	}
	const withoutQuery = endpoint.split(/[?#]/, 1)[0] ?? endpoint;
	if (/\/v1\/(?:traces|metrics|logs)$/i.test(withoutQuery)) {
		return endpoint;
	}
	return `${endpoint}/${path}`;
}

/**
 * Validate and resolve sample rate
 */
function resolveSampleRate(value: number | undefined): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return undefined;
	}
	if (value < 0 || value > 1) {
		return undefined;
	}
	return value;
}

/**
 * Create an OTEL service for the agent
 */
export function createAgentOtelService(config: AgentOtelConfig): AgentOtelService | null {
	if (!config.enabled) {
		return null;
	}

	const protocol = config.protocol ?? "http/protobuf";
	if (protocol !== "http/protobuf") {
		console.warn(`[agent-otel] unsupported protocol ${protocol}`);
		return null;
	}

	const endpoint = normalizeEndpoint(config.endpoint);
	const headers = config.headers;
	const serviceName = config.serviceName?.trim() || DEFAULT_SERVICE_NAME;
	const sampleRate = resolveSampleRate(config.sampleRate);
	const flushIntervalMs = config.flushIntervalMs ?? 60000;

	const tracesEnabled = config.traces !== false;
	const metricsEnabled = config.metrics !== false;

	if (!tracesEnabled && !metricsEnabled) {
		return null;
	}

	// Create resource
	const resource = resourceFromAttributes({
		[ATTR_SERVICE_NAME]: serviceName,
	});

	// Create exporters
	const traceUrl = resolveOtelUrl(endpoint, "v1/traces");
	const metricUrl = resolveOtelUrl(endpoint, "v1/metrics");

	const traceExporter = tracesEnabled
		? new OTLPTraceExporter({
				...(traceUrl ? { url: traceUrl } : {}),
				...(headers ? { headers } : {}),
			})
		: undefined;

	const metricExporter = metricsEnabled
		? new OTLPMetricExporter({
				...(metricUrl ? { url: metricUrl } : {}),
				...(headers ? { headers } : {}),
			})
		: undefined;

	const metricReader = metricExporter
		? new PeriodicExportingMetricReader({
				exporter: metricExporter,
				exportIntervalMillis: Math.max(1000, flushIntervalMs),
			})
		: undefined;

	// Create SDK
	let sdk: NodeSDK | null = null;
	if (tracesEnabled || metricsEnabled) {
		sdk = new NodeSDK({
			resource,
			...(traceExporter ? { traceExporter } : {}),
			...(metricReader ? { metricReader } : {}),
			...(sampleRate !== undefined
				? {
						sampler: new ParentBasedSampler({
							root: new TraceIdRatioBasedSampler(sampleRate),
						}),
					}
				: {}),
		});

		try {
			sdk.start();
		} catch (err) {
			console.error(`[agent-otel] failed to start SDK: ${err}`);
			throw err;
		}
	}

	// Create meter and tracer
	const meter = metrics.getMeter(serviceName);
	const tracer = trace.getTracer(serviceName);

	// Create metrics
	const tokensCounter = meter.createCounter("cc_bridge.agent.tokens", {
		unit: "1",
		description: "Token usage by type",
	});

	const costCounter = meter.createCounter("cc_bridge.agent.cost_usd", {
		unit: "1",
		description: "Estimated model cost (USD)",
	});

	const durationHistogram = meter.createHistogram("cc_bridge.agent.run.duration_ms", {
		unit: "ms",
		description: "Agent run duration",
	});

	const _turnCountHistogram = meter.createHistogram("cc_bridge.agent.run.turns", {
		unit: "1",
		description: "Number of turns per run",
	});

	const _toolCallCounter = meter.createCounter("cc_bridge.agent.tool_calls", {
		unit: "1",
		description: "Tool calls executed",
	});

	const _runCounter = meter.createCounter("cc_bridge.agent.runs", {
		unit: "1",
		description: "Agent runs by outcome",
	});

	return {
		getTracer(name?: string): Tracer {
			return trace.getTracer(name ?? serviceName);
		},

		getMeter(name?: string): Meter {
			return metrics.getMeter(name ?? serviceName);
		},

		startRunSpan(attributes: Record<string, string | number>): Span {
			return tracer.startSpan("cc_bridge.agent.prompt", {
				attributes,
			});
		},

		recordUsage(usage: AgentUsageSnapshot, attributes: Record<string, string | number>): void {
			const attrs = { ...attributes };

			if (usage.input > 0) {
				tokensCounter.add(usage.input, { ...attrs, token_type: "input" });
			}
			if (usage.output > 0) {
				tokensCounter.add(usage.output, { ...attrs, token_type: "output" });
			}
			if (usage.cacheRead > 0) {
				tokensCounter.add(usage.cacheRead, { ...attrs, token_type: "cache_read" });
			}
			if (usage.cacheWrite > 0) {
				tokensCounter.add(usage.cacheWrite, { ...attrs, token_type: "cache_write" });
			}

			if (usage.cost.total > 0) {
				costCounter.add(usage.cost.total, attrs);
			}
		},

		recordRunDuration(durationMs: number, attributes: Record<string, string | number>): void {
			durationHistogram.record(durationMs, attributes);
		},

		async shutdown(): Promise<void> {
			if (sdk) {
				await sdk.shutdown().catch(() => undefined);
				sdk = null;
			}
		},
	};
}

/**
 * Create a default OTEL config from environment variables
 */
export function createOtelConfigFromEnv(): AgentOtelConfig {
	return {
		enabled: process.env.OTEL_ENABLED === "true",
		endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
		protocol: (process.env.OTEL_EXPORTER_OTLP_PROTOCOL as "http/protobuf") || "http/protobuf",
		serviceName: process.env.OTEL_SERVICE_NAME,
		sampleRate: process.env.OTEL_SAMPLE_RATE ? parseFloat(process.env.OTEL_SAMPLE_RATE) : undefined,
		traces: process.env.OTEL_TRACES_ENABLED !== "false",
		metrics: process.env.OTEL_METRICS_ENABLED !== "false",
		flushIntervalMs: process.env.OTEL_FLUSH_INTERVAL_MS ? parseInt(process.env.OTEL_FLUSH_INTERVAL_MS, 10) : undefined,
	};
}
