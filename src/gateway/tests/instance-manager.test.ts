import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { InstanceManager } from "@/gateway/instance-manager";

describe("InstanceManager", () => {
	let manager: InstanceManager;

	beforeEach(() => {
		manager = new InstanceManager();
	});

	test("should refresh instances from docker ps", async () => {
		const mockOutput = JSON.stringify({
			ID: "container123",
			Names: "claude-test",
			Status: "Up 2 hours",
			Labels: "cc-bridge.workspace=claude", // Use 'claude' as expected if it's default
			Image: "cc-bridge",
		});

		// Mock Bun.spawn for docker ps
		const spawnSpy = spyOn(Bun, "spawn").mockReturnValue({
			stdout: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(`${mockOutput}\n`));
					controller.close();
				},
			}),
		} as unknown as {
			stdout: ReadableStream;
			stderr: ReadableStream;
			exited: Promise<number>;
		});

		const instances = await manager.refresh();
		expect(instances.length).toBe(1);
		expect(instances[0].name).toBe("claude");
		expect(instances[0].status).toBe("running");
		spawnSpy.mockRestore();
	});
});
