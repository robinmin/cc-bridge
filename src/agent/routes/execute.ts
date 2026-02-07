import fs from "node:fs";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { StatusCode } from "hono/utils/http-statusCodes";
import { AGENT_CONSTANTS } from "@/agent/consts";
import { ExecuteCommandSchema } from "@/agent/types";

const app = new Hono();

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
		console.info(
			`Executing command: ${cmdList.join(" ")} in ${workingDir || "current directory"}`,
		);
		const proc = Bun.spawn(cmdList, {
			cwd: workingDir,
			stdout: "pipe",
			stderr: "pipe",
		});

		// 1. Timeout Handling
		let timedOut = false;
		const timeoutId = setTimeout(() => {
			timedOut = true;
			proc.kill();
		}, timeout);

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

		const [stdout, stderr] = await Promise.all([
			readStream(proc.stdout),
			readStream(proc.stderr),
		]);

		clearTimeout(timeoutId);

		// If timed out, exitCode might be null or signal based,
		// but we want to report the timeout clearly.
		const exitCode = await proc.exited;

		return c.json({
			stdout,
			stderr,
			exitCode: timedOut
				? AGENT_CONSTANTS.EXECUTION.TIMEOUT_EXIT_CODE
				: exitCode,
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
