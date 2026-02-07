import { describe, expect, test } from "bun:test";
import { Header, Section, StatusIcon } from "@/gateway/output/common";

describe("common output components", () => {
	describe("StatusIcon", () => {
		test("should return checkmark for ok status in telegram format", () => {
			expect(StatusIcon({ status: "ok", format: "telegram" })).toBe("✅");
		});

		test("should return checkmark for true status in telegram format", () => {
			expect(StatusIcon({ status: true, format: "telegram" })).toBe("✅");
		});

		test("should return checkmark for running status in telegram format", () => {
			expect(StatusIcon({ status: "running", format: "telegram" })).toBe("✅");
		});

		test("should return X mark for error status in telegram format", () => {
			expect(StatusIcon({ status: "error", format: "telegram" })).toBe("❌");
		});

		test("should return warning for warn status in telegram format", () => {
			expect(StatusIcon({ status: "warn", format: "telegram" })).toBe("⚠️");
		});

		test("should return question mark for undefined status in telegram format", () => {
			expect(StatusIcon({ status: undefined, format: "telegram" })).toBe("❔");
		});

		test("should return checkmark for ok status in terminal format", () => {
			const result = StatusIcon({ status: "ok", format: "terminal" });
			expect(result).toContain("✓");
		});

		test("should return X mark for error status in terminal format", () => {
			const result = StatusIcon({ status: "error", format: "terminal" });
			expect(result).toContain("✗");
		});
	});

	describe("Section", () => {
		test("should format section for telegram", () => {
			const result = Section({
				title: "Test Section",
				format: "telegram",
				emoji: "🧪",
				children: "Test content",
			});
			expect(result).toContain("**Test Section**");
			expect(result).toContain("Test content");
			expect(result).toContain("🧪");
		});

		test("should format section for terminal", () => {
			const result = Section({
				title: "Test Section",
				format: "terminal",
				children: "Test content",
			});
			expect(result).toContain("Test Section");
			expect(result).toContain("Test content");
		});

		test("should handle array children", () => {
			const result = Section({
				title: "Test",
				format: "telegram",
				children: ["Line 1", "Line 2", "Line 3"],
			});
			expect(result).toContain("Line 1\nLine 2\nLine 3");
		});
	});

	describe("Header", () => {
		test("should format header for telegram", () => {
			const result = Header({
				title: "Test Report",
				format: "telegram",
				subtitle: "Test subtitle",
			});
			expect(result).toContain("**TEST REPORT**");
			expect(result).toContain("Test subtitle");
		});

		test("should format header for telegram without subtitle", () => {
			const result = Header({
				title: "Test Report",
				format: "telegram",
			});
			expect(result).toContain("**TEST REPORT**");
			expect(result).not.toContain("━━━━━━━━━━━━━━━━━━━\n");
		});

		test("should format header for terminal", () => {
			const result = Header({
				title: "Test Report",
				format: "terminal",
				subtitle: "Test subtitle",
			});
			expect(result).toContain("Test Report");
			expect(result).toContain("Test subtitle");
		});

		test("should format header for terminal without subtitle", () => {
			const result = Header({
				title: "Test Report",
				format: "terminal",
			});
			expect(result).toContain("Test Report");
		});
	});
});
