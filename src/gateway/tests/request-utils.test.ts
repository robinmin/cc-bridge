import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { getOutputFormat, prefersJson } from "@/gateway/utils/request-utils";

describe("request-utils", () => {
	describe("prefersJson", () => {
		test("should return true when Accept header contains json", async () => {
			const app = new Hono();
			app.get("/test", (c) => {
				return c.json({ prefersJson: prefersJson(c) });
			});

			const req = new Request("http://localhost/test", {
				headers: { Accept: "application/json" },
			});
			const res = await app.request(req);
			const data = await res.json();

			expect(data.prefersJson).toBe(true);
		});

		test("should return true when Accept header contains JSON (uppercase)", async () => {
			const app = new Hono();
			app.get("/test", (c) => {
				return c.json({ prefersJson: prefersJson(c) });
			});

			const req = new Request("http://localhost/test", {
				headers: { Accept: "application/JSON" },
			});
			const res = await app.request(req);
			const data = await res.json();

			expect(data.prefersJson).toBe(true);
		});

		test("should return false when Accept header does not contain json", async () => {
			const app = new Hono();
			app.get("/test", (c) => {
				return c.json({ prefersJson: prefersJson(c) });
			});

			const req = new Request("http://localhost/test", {
				headers: { Accept: "text/html" },
			});
			const res = await app.request(req);
			const data = await res.json();

			expect(data.prefersJson).toBe(false);
		});

		test("should return false when Accept header is missing", async () => {
			const app = new Hono();
			app.get("/test", (c) => {
				return c.json({ prefersJson: prefersJson(c) });
			});

			const req = new Request("http://localhost/test");
			const res = await app.request(req);
			const data = await res.json();

			expect(data.prefersJson).toBe(false);
		});

		test("should handle multiple Accept values", async () => {
			const app = new Hono();
			app.get("/test", (c) => {
				return c.json({ prefersJson: prefersJson(c) });
			});

			const req = new Request("http://localhost/test", {
				headers: { Accept: "text/html, application/json, */*" },
			});
			const res = await app.request(req);
			const data = await res.json();

			expect(data.prefersJson).toBe(true);
		});
	});

	describe("getOutputFormat", () => {
		test("should return telegram when format query param is telegram", async () => {
			const app = new Hono();
			app.get("/test", (c) => {
				return c.json({ format: getOutputFormat(c) });
			});

			const req = new Request("http://localhost/test?format=telegram");
			const res = await app.request(req);
			const data = await res.json();

			expect(data.format).toBe("telegram");
		});

		test("should return terminal when format query param is missing", async () => {
			const app = new Hono();
			app.get("/test", (c) => {
				return c.json({ format: getOutputFormat(c) });
			});

			const req = new Request("http://localhost/test");
			const res = await app.request(req);
			const data = await res.json();

			expect(data.format).toBe("terminal");
		});

		test("should return terminal when format query param is invalid", async () => {
			const app = new Hono();
			app.get("/test", (c) => {
				return c.json({ format: getOutputFormat(c) });
			});

			const req = new Request("http://localhost/test?format=invalid");
			const res = await app.request(req);
			const data = await res.json();

			expect(data.format).toBe("terminal");
		});

		test("should return terminal when format query param is terminal", async () => {
			const app = new Hono();
			app.get("/test", (c) => {
				return c.json({ format: getOutputFormat(c) });
			});

			const req = new Request("http://localhost/test?format=terminal");
			const res = await app.request(req);
			const data = await res.json();

			expect(data.format).toBe("terminal");
		});
	});
});
