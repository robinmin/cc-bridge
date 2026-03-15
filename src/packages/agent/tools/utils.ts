/**
 * Shared utilities for workspace-sandboxed tools.
 */

import fs from "node:fs/promises";
import path from "node:path";

/**
 * Resolve and validate a file path within the workspace.
 * Returns the absolute path or throws if path escapes the workspace.
 *
 * Uses fs.realpath() after resolution to detect symlink escapes,
 * then re-validates the real path is still within the workspace.
 */
export async function resolveWorkspacePath(workspaceDir: string, relativePath: string): Promise<string> {
	const resolved = path.resolve(workspaceDir, relativePath);
	const normalizedWorkspace = path.resolve(workspaceDir);

	if (!resolved.startsWith(normalizedWorkspace + path.sep) && resolved !== normalizedWorkspace) {
		throw new Error(`Path "${relativePath}" resolves outside of workspace directory. Path traversal is not allowed.`);
	}

	// Resolve symlinks to detect symlink escapes (the target may exist or not)
	let realPath: string;
	try {
		realPath = await fs.realpath(resolved);
	} catch {
		// File doesn't exist yet (e.g. write-file creating new files).
		// Validate the parent directory instead.
		const parentDir = path.dirname(resolved);
		try {
			const realParent = await fs.realpath(parentDir);
			if (!realParent.startsWith(normalizedWorkspace + path.sep) && realParent !== normalizedWorkspace) {
				throw new Error(
					`Path "${relativePath}" resolves outside of workspace directory via symlink. Path traversal is not allowed.`,
				);
			}
		} catch {
			// Parent doesn't exist — will be created by caller (mkdir -p).
			// Check if the workspace directory itself exists and is accessible
			try {
				await fs.access(workspaceDir);
			} catch {
				throw new Error(`Workspace directory "${workspaceDir}" does not exist or is not accessible`);
			}
			// The initial path.resolve check above is sufficient for the resolved path.
			// Parent will be created by caller (mkdir -p).
		}
		return resolved;
	}

	if (!realPath.startsWith(normalizedWorkspace + path.sep) && realPath !== normalizedWorkspace) {
		throw new Error(
			`Path "${relativePath}" resolves outside of workspace directory via symlink. Path traversal is not allowed.`,
		);
	}

	return realPath;
}
