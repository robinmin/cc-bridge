import { expect, test, describe, spyOn, beforeEach, mock } from "bun:test";
import { AgentBot } from "@/gateway/pipeline/agent-bot";
import { type Message } from "@/gateway/pipeline";
import { type Channel } from "@/gateway/channels";
import { instanceManager } from "@/gateway/instance-manager";
import { IpcClient } from "@/packages/ipc/client";

describe("AgentBot", () => {
    const mockChannel: Channel = {
        name: "test",
        sendMessage: async () => { },
    };

    const spy = spyOn(mockChannel, "sendMessage");

    const mockPersistence = {
        getSession: async () => null,
        setSession: async () => { },
        getHistory: async () => [],
        storeMessage: async () => { }
    };

    beforeEach(() => {
        spy.mockClear();
        // Mock instance manager to return a running instance
        instanceManager.getInstances = () => [
            { name: "test-agent", containerId: "123", status: "running", image: "cc-bridge" }
        ];
    });

    test("should delegate message to agent", async () => {
        const bot = new AgentBot(mockChannel, mockPersistence as any);
        const msg: Message = { channelId: "test", chatId: "123", text: "tell me a joke" };

        // Mock the IpcClient.prototype.sendRequest
        const ipcSpy = spyOn(IpcClient.prototype, "sendRequest").mockResolvedValue({
            id: "test",
            status: 200,
            result: { stdout: "hello from agent" }
        });

        const handled = await bot.handle(msg);

        expect(handled).toBe(true);
        expect(spy).toHaveBeenCalledWith("123", "hello from agent");
        ipcSpy.mockRestore();
    });

    test("should handle no running instances", async () => {
        instanceManager.getInstances = () => [];
        const bot = new AgentBot(mockChannel, mockPersistence as any);
        const msg: Message = { channelId: "test", chatId: "123", text: "hello" };

        const handled = await bot.handle(msg);

        expect(handled).toBe(true);
        expect(spy).toHaveBeenCalledWith("123", expect.stringContaining("No running Claude instance found"));
    });
});
