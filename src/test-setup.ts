/**
 * Test setup file for all cc-bridge tests
 * This ensures environment variables are set before any modules are imported
 */

// Set test mode environment variables
process.env.NODE_ENV = "test";
process.env.TEST_MODE__INTERNAL_ONLY = "true";

// Ensure we're in the src directory for path resolution
const currentPath = import.meta.path;
if (currentPath && !currentPath.includes("src/")) {
	throw new Error("Tests must be run from the src directory");
}

// Export nothing - this file is for side effects only
export {};
