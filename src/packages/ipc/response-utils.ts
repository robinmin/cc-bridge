import type { IpcResponse } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function parseFetchResponseBody(response: Response): Promise<unknown> {
	if (response.status === 204 || response.status === 205) return {};

	const text = await response.text();
	if (!text.trim()) return {};

	const contentType = response.headers.get("content-type") || "";
	if (contentType.includes("application/json")) {
		try {
			return JSON.parse(text);
		} catch {
			return { message: text };
		}
	}

	try {
		return JSON.parse(text);
	} catch {
		return { message: text };
	}
}

export function parseRawResponseBody(text: string): unknown {
	if (!text.trim()) return {};
	try {
		return JSON.parse(text);
	} catch {
		return { message: text };
	}
}

export function toIpcErrorPayload(body: unknown, status: number): IpcResponse["error"] {
	if (isRecord(body) && typeof body.message === "string" && body.message.trim()) {
		return { message: body.message };
	}
	if (typeof body === "string" && body.trim()) {
		return { message: body };
	}
	return { message: `HTTP ${status}` };
}
