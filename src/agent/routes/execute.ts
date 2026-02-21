import fs from "node:fs";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { StatusCode } from "hono/utils/http-statusCodes";
import { AGENT_CONSTANTS } from "@/agent/consts";
import { ExecuteCommandSchema } from "@/agent/types";

const app = new Hono();

function applyLlmProviderEnv(env: Record<string, string>): Record<string, string> {
	const provider = (process.env.LLM_PROVIDER || "anthropic").toLowerCase();
	const next = { ...env };
	const setIfDefined = (key: "ANTHROPIC_BASE_URL" | "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN", value?: string) => {
		if (value && value.trim().length > 0) {
			next[key] = value;
		}
	};

	switch (provider) {
		case "anthropic": {
			setIfDefined("ANTHROPIC_BASE_URL", process.env.LLM_ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL);
			setIfDefined("ANTHROPIC_API_KEY", process.env.LLM_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY);
			setIfDefined("ANTHROPIC_AUTH_TOKEN", process.env.LLM_ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN);
			break;
		}
		case "openrouter": {
			setIfDefined("ANTHROPIC_BASE_URL", process.env.LLM_OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1");
			setIfDefined("ANTHROPIC_API_KEY", process.env.LLM_OPENROUTER_API_KEY);
			break;
		}
		case "proxy": {
			setIfDefined("ANTHROPIC_BASE_URL", process.env.LLM_PROXY_BASE_URL);
			setIfDefined("ANTHROPIC_API_KEY", process.env.LLM_PROXY_API_KEY);
			setIfDefined("ANTHROPIC_AUTH_TOKEN", process.env.LLM_PROXY_AUTH_TOKEN);
			break;
		}
		case "zai": {
			setIfDefined("ANTHROPIC_BASE_URL", process.env.LLM_ZAI_BASE_URL);
			setIfDefined("ANTHROPIC_API_KEY", process.env.LLM_ZAI_API_KEY);
			setIfDefined("ANTHROPIC_AUTH_TOKEN", process.env.LLM_ZAI_AUTH_TOKEN);
			break;
		}
		case "minimax": {
			setIfDefined("ANTHROPIC_BASE_URL", process.env.LLM_MINIMAX_BASE_URL);
			setIfDefined("ANTHROPIC_API_KEY", process.env.LLM_MINIMAX_API_KEY);
			setIfDefined("ANTHROPIC_AUTH_TOKEN", process.env.LLM_MINIMAX_AUTH_TOKEN);
			break;
		}
		default: {
			// Safe fallback
			setIfDefined("ANTHROPIC_BASE_URL", process.env.LLM_ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL);
			setIfDefined("ANTHROPIC_API_KEY", process.env.LLM_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY);
			setIfDefined("ANTHROPIC_AUTH_TOKEN", process.env.LLM_ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN);
			break;
		}
	}

	return next;
}

app.post("/", zValidator("json", ExecuteCommandSchema), async (c) => {
	const { command, args, cwd, timeout } = c.req.valid("json");

	try {
		const cmdList = [command, ...(args || [])];
		// Determine working directory - use cwd if provided and exists, otherwise use default or current
		let workingDir = cwd || "/workspaces/cc-bridge"; // Default workspace
		if (workingDir && !fs.existsSync(workingDir)) {
			// If specified workspace doesn't exist, fall back to current directory
			workingDir = undefined;
		}
		console.info(`Executing command: ${cmdList.join(" ")} in ${workingDir || "current directory"}`);

		// Prefer ANTHROPIC_API_KEY when provided; otherwise use ANTHROPIC_AUTH_TOKEN
		const childEnv = applyLlmProviderEnv({ ...process.env } as Record<string, string>);

		const proc = Bun.spawn(cmdList, {
			cwd: workingDir,
			stdout: "pipe",
			stderr: "pipe",
			env: childEnv,
		});

		// 1. Timeout Handling
		let timedOut = false;
		const timeoutId = setTimeout(() => {
			timedOut = true;
			proc.kill();
		}, timeout);
		const abortSignal = c.req.raw.signal;
		const onAbort = () => {
			proc.kill();
		};
		abortSignal.addEventListener("abort", onAbort, { once: true });

		// 2. Output Limiting (Prevent OOM)
		const MAX_OUTPUT_SIZE = AGENT_CONSTANTS.EXECUTION.MAX_OUTPUT_SIZE_BYTES;

		const readStream = async (stream: ReadableStream<Uint8Array>) => {
			const reader = stream.getReader();
			const decoder = new TextDecoder();
			let result = "";
			let totalBytes = 0;

			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					const chunkLen = value.length;
					if (totalBytes + chunkLen > MAX_OUTPUT_SIZE) {
						const remaining = MAX_OUTPUT_SIZE - totalBytes;
						result += decoder.decode(value.slice(0, remaining));
						result += "\n[Output Truncated]";
						// Kill process closely after truncation to stop wasting resources
						proc.kill();
						break;
					}

					result += decoder.decode(value, { stream: true });
					totalBytes += chunkLen;
				}
			} finally {
				reader.cancel();
			}
			return result;
		};

		const [stdout, stderr] = await Promise.all([readStream(proc.stdout), readStream(proc.stderr)]);

		clearTimeout(timeoutId);
		abortSignal.removeEventListener("abort", onAbort);

		// If timed out, exitCode might be null or signal based,
		// but we want to report the timeout clearly.
		const exitCode = await proc.exited;

		return c.json({
			stdout,
			stderr,
			exitCode: timedOut ? AGENT_CONSTANTS.EXECUTION.TIMEOUT_EXIT_CODE : exitCode,
		});
	} catch (error) {
		return c.json(
			{
				error: error instanceof Error ? error.message : String(error),
				exitCode: AGENT_CONSTANTS.EXECUTION.ERROR_EXIT_CODE,
				stdout: "",
				stderr: "",
			},
			AGENT_CONSTANTS.HTTP.INTERNAL_SERVER_ERROR as StatusCode,
		);
	}
});

export default app;
