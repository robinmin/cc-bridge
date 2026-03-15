/**
 * Write File Tool
 *
 * AgentTool that writes or creates files in a workspace directory.
 * Validates that the path stays within the workspace boundary
 * (including symlink resolution), enforces a write size limit,
 * and creates parent directories as needed.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@mariozechner/pi-ai";
import { resolveWorkspacePath } from "./utils";

const MAX_WRITE_SIZE = 1024 * 1024; // 1MB

const parameters = Type.Object({
	path: Type.String({ description: "File path relative to workspace directory" }),
	content: Type.String({ description: "Content to write to the file" }),
});

type WriteFileParams = Static<typeof parameters>;

/**
 * Create a write-file AgentTool bound to a workspace directory.
 */
export function createWriteFileTool(workspaceDir: string): AgentTool<typeof parameters> {
	return {
		name: "write_file",
		label: "Write File",
		description:
			"Write content to a file in the workspace directory. " +
			"Creates the file if it doesn't exist, overwrites if it does. " +
			"Parent directories are created automatically. " +
			"The path must be relative to the workspace root. " +
			"Maximum write size is 1MB.",
		parameters,
		execute: async (
			_toolCallId: string,
			params: WriteFileParams,
			signal?: AbortSignal,
		): Promise<AgentToolResult<undefined>> => {
			if (signal?.aborted) {
				throw new Error("Write file operation was aborted");
			}

			// Enforce write size limit
			if (params.content.length > MAX_WRITE_SIZE) {
				return {
					content: [
						{
							type: "text",
							text: `Error: Content is ${params.content.length} bytes, which exceeds the ${MAX_WRITE_SIZE} byte (1MB) write limit.`,
						},
					],
					details: undefined,
				};
			}

			const absolutePath = await resolveWorkspacePath(workspaceDir, params.path);

			// Get parent directory for creating parent dirs and writing file
			const parentDir = path.dirname(absolutePath);

			// Create parent directories if needed (mkdir -p)
			await fs.mkdir(parentDir, { recursive: true });

			await fs.writeFile(absolutePath, params.content, "utf-8");

			return {
				content: [
					{
						type: "text",
						text: `Successfully wrote ${params.content.length} bytes to "${params.path}".`,
					},
				],
				details: undefined,
			};
		},
	};
}
