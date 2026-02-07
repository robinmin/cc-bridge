import path from "node:path";

/**
 * Validates that a file path is within the allowed workspace directory.
 * Prevents directory traversal attacks.
 *
 * In test mode (TEST_MODE=true), path validation is disabled for testing purposes.
 *
 * @param filePath - The file path to validate
 * @returns The resolved, safe absolute path
 * @throws Error if the path is outside the allowed workspace (unless in test mode)
 */
export function validatePath(filePath: string): string {
	// Skip validation in test mode for testing purposes
	if (process.env.TEST_MODE === "true") {
		return path.resolve(filePath);
	}

	// Get the workspace name from environment or use default
	const workspaceName = process.env.WORKSPACE_NAME || "cc-bridge";
	const workspaceRoot = `/workspaces/${workspaceName}`;

	// Resolve the absolute path
	const absolutePath = path.resolve(filePath);

	// Check if the path is within the workspace root
	if (!absolutePath.startsWith(workspaceRoot)) {
		throw new Error(
			`Path validation failed: "${filePath}" is outside the allowed workspace directory "${workspaceRoot}"`,
		);
	}

	return absolutePath;
}

/**
 * Validates that a directory path is within the allowed workspace directory.
 * This is a wrapper around validatePath for clarity in directory operations.
 *
 * @param dirPath - The directory path to validate
 * @returns The resolved, safe absolute path
 * @throws Error if the path is outside the allowed workspace (unless in test mode)
 */
export function validateDirPath(dirPath: string): string {
	return validatePath(dirPath);
}
