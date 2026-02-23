import path from "node:path";

/**
 * Check if test mode is enabled
 * TEST MODE - INTERNAL USE ONLY
 *
 * This function checks if test mode is enabled for testing purposes.
 * Test mode should NEVER be enabled in production environments.
 *
 * @internal
 * @deprecated Only for automated testing
 */
export function isTestMode(): boolean {
	return process.env.TEST_MODE__INTERNAL_ONLY === "true" && process.env.NODE_ENV === "test";
}

/**
 * Verify test mode is only used in test environment
 */
export function validateTestMode(): void {
	if (process.env.TEST_MODE__INTERNAL_ONLY === "true" && process.env.NODE_ENV !== "test") {
		throw new Error(
			"TEST_MODE__INTERNAL_ONLY can only be enabled in test environment. " +
				"Current environment: " +
				(process.env.NODE_ENV || "unknown"),
		);
	}
}

// Validate test mode on module load
validateTestMode();

/**
 * Validates that a file path is within the allowed workspace directory.
 * Prevents directory traversal attacks.
 *
 * In test mode (TEST_MODE__INTERNAL_ONLY=true), path validation is disabled for testing purposes.
 *
 * @param filePath - The file path to validate
 * @returns The resolved, safe absolute path
 * @throws Error if the path is outside the allowed workspace (unless in test mode)
 */
export function validatePath(filePath: string): string {
	// Skip validation in test mode for testing purposes only
	if (isTestMode()) {
		return path.resolve(filePath);
	}

	// Get the workspace name from environment or use default
	const workspaceName = process.env.WORKSPACE_NAME || "cc-bridge";
	const workspaceRoot = `/workspaces/${workspaceName}`;

	// Resolve the absolute path
	const absolutePath = path.resolve(filePath);

	// Check if the path is within the workspace root
	// Ensure we don't accidentally allow sibling directories with similar prefixes
	// e.g. /workspace/foo should not match /workspace/foobar
	const isExactMatch = absolutePath === workspaceRoot;
	const isChildPath = absolutePath.startsWith(
		workspaceRoot.endsWith(path.sep) ? workspaceRoot : `${workspaceRoot}${path.sep}`,
	);

	if (!isExactMatch && !isChildPath) {
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

/**
 * Export isTestMode for testing purposes
 */
export { isTestMode as TEST_MODE__INTERNAL_ONLY };
