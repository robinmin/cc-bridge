/**
 * Read File Tool
 *
 * AgentTool that reads file contents from a workspace directory.
 * Validates that the path stays within the workspace boundary
 * (including symlink resolution) and enforces a size limit.
 */

import fs from "node:fs/promises";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@mariozechner/pi-ai";
import { resolveWorkspacePath } from "./utils";

const MAX_FILE_SIZE = 100 * 1024; // 100KB

const parameters = Type.Object({
	path: Type.String({ description: "File path relative to workspace directory" }),
});

type ReadFileParams = Static<typeof parameters>;

/**
 * Create a read-file AgentTool bound to a workspace directory.
 */
export function createReadFileTool(workspaceDir: string): AgentTool<typeof parameters> {
	return {
		name: "read_file",
		label: "Read File",
		description:
			"Read the contents of a file from the workspace directory. " +
			"The path must be relative to the workspace root. " +
			"Maximum file size is 100KB.",
		parameters,
		execute: async (
			_toolCallId: string,
			params: ReadFileParams,
			signal?: AbortSignal,
		): Promise<AgentToolResult<undefined>> => {
			// Check abort before starting
			if (signal?.aborted) {
				throw new Error("Read file operation was aborted");
			}

			const absolutePath = await resolveWorkspacePath(workspaceDir, params.path);

			// HIGH-3 fix: Read file first into a buffer, then check size.
			// This eliminates the TOCTOU race between stat() and readFile().
			let buffer: Buffer;
			try {
				buffer = await fs.readFile(absolutePath);
			} catch (err: unknown) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code === "EISDIR") {
					return {
						content: [
							{
								type: "text",
								text: `Error: "${params.path}" is not a regular file.`,
							},
						],
						details: undefined,
					};
				}
				throw err;
			}

			if (buffer.length > MAX_FILE_SIZE) {
				return {
					content: [
						{
							type: "text",
							text: `Error: File "${params.path}" is ${buffer.length} bytes, which exceeds the ${MAX_FILE_SIZE} byte limit.`,
						},
					],
					details: undefined,
				};
			}

			const content = buffer.toString("utf-8");

			return {
				content: [{ type: "text", text: content }],
				details: undefined,
			};
		},
	};
}
