import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import { InstanceManager } from "@/gateway/instance-manager";
import { GATEWAY_CONSTANTS } from "@/gateway/consts";

describe("InstanceManager", () => {
	let manager: InstanceManager;

	beforeEach(() => {
		manager = new InstanceManager();
	});

	afterEach(() => {
		delete process.env.DOCKER_BIN;
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

	test("should stop retrying discovery when docker cli is missing", async () => {
		const spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => {
			throw Object.assign(new Error("docker not found"), { code: "ENOENT", path: "docker", errno: -2 });
		});

		const first = await manager.refresh();
		const second = await manager.refresh();

		expect(first).toEqual([]);
		expect(second).toEqual([]);
		expect(spawnSpy).toHaveBeenCalledTimes(1);
		spawnSpy.mockRestore();
	});

	test("should report parse metrics when docker output contains invalid lines", async () => {
		process.env.DOCKER_BIN = "/bin/docker";
		const existsSpy = spyOn(fs, "existsSync").mockImplementation((p) => String(p) === "/bin/docker");
		const spawnSpy = spyOn(Bun, "spawn").mockReturnValue({
			stdout: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("not-json\n"));
					controller.close();
				},
			}),
			exited: Promise.resolve(0),
		} as unknown as {
			stdout: ReadableStream;
			stderr: ReadableStream;
			exited: Promise<number>;
		});

		await manager.refresh();
		const metrics = manager.getMetrics();
		expect(metrics.parseErrorCount).toBeGreaterThan(0);
		expect(metrics.errorRate).toBeGreaterThan(0);

		existsSpy.mockRestore();
		spawnSpy.mockRestore();
	});

	test("should list workspace folders and handle errors", async () => {
		const root = GATEWAY_CONSTANTS.CONFIG.WORKSPACE_ROOT;
		const existsSpy = spyOn(fs, "existsSync")
			.mockImplementationOnce((p) => String(p) === root)
			.mockImplementationOnce(() => true);
		const readdirSpy = spyOn(fs.promises, "readdir")
			.mockResolvedValueOnce(
				[
					{ name: "alpha", isDirectory: () => true },
					{ name: ".hidden", isDirectory: () => true },
					{ name: "not-dir", isDirectory: () => false },
				] as unknown as Awaited<ReturnType<typeof fs.promises.readdir>>,
			)
			.mockRejectedValueOnce(new Error("readdir failed"));

		const folders = await manager.getWorkspaceFolders();
		expect(folders).toEqual(["alpha"]);
		expect(await manager.getWorkspaceFolders()).toEqual([]);

		existsSpy.mockRestore();
		readdirSpy.mockRestore();
	});

	test("should expose discovered instances via getters", async () => {
		process.env.DOCKER_BIN = "/bin/docker";
		const existsSpy = spyOn(fs, "existsSync").mockImplementation((p) => String(p) === "/bin/docker");
		const spawnSpy = spyOn(Bun, "spawn").mockReturnValue({
			stdout: new ReadableStream({
				start(controller) {
					controller.enqueue(
						new TextEncoder().encode(
							`${JSON.stringify({
								ID: "id-1",
								Names: "ws-1",
								Status: "Up 1 minute",
								Labels: `${GATEWAY_CONSTANTS.INSTANCES.LABEL}=ws-1`,
								Image: "img",
							})}\n`,
						),
					);
					controller.close();
				},
			}),
			exited: Promise.resolve(0),
		} as unknown as {
			stdout: ReadableStream;
			stderr: ReadableStream;
			exited: Promise<number>;
		});

		await manager.refresh();
		expect(manager.getInstances()).toHaveLength(1);
		expect(manager.getInstance("ws-1")?.containerId).toBe("id-1");

		existsSpy.mockRestore();
		spawnSpy.mockRestore();
	});
});
