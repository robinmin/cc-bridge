import { z } from "zod";

// --- Command Execution ---
export const ExecuteCommandSchema = z.object({
    command: z.string(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    timeout: z.number().optional().default(30000), // Default 30s
});

export type ExecuteCommandRequest = z.infer<typeof ExecuteCommandSchema>;

export interface ExecuteCommandResponse {
    stdout: string;
    stderr: string;
    exitCode: number;
}

// --- File Operations ---
export const ReadFileSchema = z.object({
    path: z.string(),
    encoding: z.enum(["utf-8", "base64"]).optional().default("utf-8"),
});

export type ReadFileRequest = z.infer<typeof ReadFileSchema>;

export interface ReadFileResponse {
    content: string;
    exists: boolean;
}

export const WriteFileSchema = z.object({
    path: z.string(),
    content: z.string(),
    encoding: z.enum(["utf-8", "base64"]).optional().default("utf-8"),
    mode: z.number().optional(), // File permissions
});

export type WriteFileRequest = z.infer<typeof WriteFileSchema>;

export interface WriteFileResponse {
    success: boolean;
    bytesWritten: number;
}

// --- List Directory ---
export const ListDirSchema = z.object({
    path: z.string(),
});

export type ListDirRequest = z.infer<typeof ListDirSchema>;

export interface FileEntry {
    name: string;
    isDirectory: boolean;
    size: number;
    updatedAt: string; // ISO date
}

export interface ListDirResponse {
    entries: FileEntry[];
}

// --- JSON-RPC / IPC Envelope ---
export interface IpcRequest {
    id: string;
    method: string; // e.g., "GET /execute" or just "/execute"
    params?: unknown;
    path?: string;
    body?: unknown;
}

export interface IpcResponse {
    id: string;
    status: number;
    result?: unknown;
    error?: {
        message: string;
        code?: number;
    };
}
