import { describe, expect, test } from "bun:test";
import {
	CallbackErrorResponseSchema,
	CallbackHealthResponseSchema,
	CallbackRequestSchema,
	CallbackSuccessResponseSchema,
	ResponseFileSchema,
} from "@/gateway/schemas/callback";

describe("callback schemas", () => {
	test("validates callback request with string and number chatId", () => {
		expect(
			CallbackRequestSchema.parse({
				requestId: "req_123",
				chatId: "12345",
				workspace: "cc-bridge",
			}).chatId,
		).toBe("12345");

		expect(
			CallbackRequestSchema.parse({
				requestId: "req_456",
				chatId: 12345,
				workspace: "cc_bridge",
			}).chatId,
		).toBe(12345);
	});

	test("rejects invalid callback request values", () => {
		expect(() =>
			CallbackRequestSchema.parse({
				requestId: "bad space",
				chatId: "123",
				workspace: "cc-bridge",
			}),
		).toThrow();

		expect(() =>
			CallbackRequestSchema.parse({
				requestId: "ok_id",
				chatId: 0,
				workspace: "cc-bridge",
			}),
		).toThrow();

		expect(() =>
			CallbackRequestSchema.parse({
				requestId: "ok_id",
				chatId: "   ",
				workspace: "cc-bridge",
			}),
		).toThrow();
	});

	test("validates response and callback response schemas", () => {
		const response = ResponseFileSchema.parse({
			requestId: "req_1",
			chatId: "123",
			workspace: "cc-bridge",
			timestamp: "2026-02-22T10:00:00.000Z",
			output: "done",
			exitCode: 0,
			callback: {
				success: true,
				attempts: 1,
				retryTimestamps: ["2026-02-22T10:00:00.000Z"],
			},
		});
		expect(response.requestId).toBe("req_1");

		expect(
			CallbackSuccessResponseSchema.parse({
				success: true,
				duplicate: false,
			}).success,
		).toBe(true);

		expect(
			CallbackErrorResponseSchema.parse({
				error: "rate_limited",
				retryAfter: 2,
				details: ["workspace_limit"],
			}).error,
		).toBe("rate_limited");

		expect(
			CallbackHealthResponseSchema.parse({
				status: "healthy",
				services: {
					idempotency: { size: 1, maxSize: 1000, hitRate: 0.5 },
					rateLimit: { workspaces: 1, ips: 2 },
				},
			}).status,
		).toBe("healthy");
	});
});
