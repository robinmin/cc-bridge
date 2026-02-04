import { expect, test, describe, spyOn } from "bun:test";
import { IpcClient } from "@/packages/ipc/client";

describe("IpcClient", () => {
    test("should send request and parse response", async () => {
        const client = new IpcClient("container123");
        const request = { id: "req1", method: "GET", path: "/health" };

        const mockResponse = JSON.stringify({ id: "req1", status: 200, result: { status: "ok" } });

        // Mock Bun.spawn
        const spawnSpy = spyOn(Bun, "spawn").mockReturnValue({
            stdin: {
                write: () => { },
                flush: () => { },
                end: () => { }
            },
            stdout: new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode("other logs\n" + mockResponse + "\n"));
                    controller.close();
                }
            }),
            stderr: new ReadableStream({
                start(controller) {
                    controller.close();
                }
            }),
            exited: Promise.resolve(0)
        } as any);

        const response = await client.sendRequest(request);
        expect(response.id).toBe("req1");
        expect(response.status).toBe(200);
        expect((response.result as any).status).toBe("ok");
        spawnSpy.mockRestore();
    });
});
