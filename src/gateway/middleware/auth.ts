import type { Context, Next } from "hono";

/**
 * Simple API key authentication middleware.
 * Checks for the API key in the X-API-Key header or the api_key query parameter.
 *
 * @param c - Hono context
 * @param next - Next middleware function
 * @returns Response with 401 if authentication fails, otherwise calls next()
 */
export const authMiddleware = async (c: Context, next: Next) => {
	// Get the expected API key from environment
	const expectedApiKey = process.env.HEALTH_API_KEY;

	// If no API key is configured, skip authentication (for development)
	if (!expectedApiKey) {
		return next();
	}

	// Check for API key in header (X-API-Key) or query parameter (api_key)
	const headerKey = c.req.header("X-API-Key");
	const queryKey = c.req.query("api_key");
	const providedKey = headerKey || queryKey;

	if (providedKey === expectedApiKey) {
		return next();
	}

	// Return 401 Unauthorized
	return c.json({ error: "Unauthorized" }, 401);
};
