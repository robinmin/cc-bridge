import { type Context } from "hono";

/**
 * Utility to check if the client prefers a JSON response.
 * Returns true if the 'Accept' header contains 'json'.
 */
export function prefersJson(c: Context): boolean {
    const accept = c.req.header("Accept");
    if (!accept) return false;
    return accept.toLowerCase().includes("json");
}

/**
 * Get the requested output format from query params.
 */
export function getOutputFormat(c: Context): "telegram" | "terminal" {
    const format = c.req.query("format");
    return format === "telegram" ? "telegram" : "terminal";
}
