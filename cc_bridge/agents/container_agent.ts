import { spawn } from "bun";

// Configure logging
const LOG_LEVEL = process.env.AGENT_LOG_LEVEL || "INFO";
const DEBUG = LOG_LEVEL === "DEBUG";

function log(msg: string) {
    process.stderr.write(`[container_agent] ${msg}\n`);
}

function debug(msg: string) {
    if (DEBUG) process.stderr.write(`[container_agent:debug] ${msg}\n`);
}

log("Starting Bun container agent...");

// Arguments for Claude
// We permit dangerous permission skipping as requested by user config
const claudeArgs = [
    "claude",
    "--dangerously-skip-permissions",
    // Force interactive mode behavior if needed, generally default is fine
];

// Spawn Claude process
// we use ptys to trick Claude into thinking it has a terminal if needed, 
// but for simple plumbing pipes might be enough. 
// However, Claude CLI often detects TTY. 
// Let's try simple pipes first.
const proc = spawn(claudeArgs, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
});

log(`Claude process started (PID: ${proc.pid})`);

// Pipe Agent stdin -> Claude stdin
// We read line by line from our stdin and write to Claude
async function handleInput() {
    const reader = console.stream();
    for await (const chunk of reader) {
        debug(`Writing ${chunk.length} bytes to Claude stdin`);
        if (proc.stdin) {
            proc.stdin.write(chunk);
            proc.stdin.flush();
        }
    }
}

// Pipe Claude stdout -> Agent stdout
async function handleOutput() {
    if (!proc.stdout) return;
    const reader = proc.stdout.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        debug(`Received ${value.length} bytes from Claude stdout`);
        // Pass directly to our stdout
        process.stdout.write(value);
    }
}

// Pipe Claude stderr -> Agent stderr (logs)
async function handleStderr() {
    if (!proc.stderr) return;
    const reader = proc.stderr.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const errText = new TextDecoder().decode(value);
        // Prefix Claude logs so we know source
        process.stderr.write(`[claude] ${errText}`);
    }
}

// Start piping
handleInput().catch(e => log(`Input error: ${e}`));
handleOutput().catch(e => log(`Output error: ${e}`));
handleStderr().catch(e => log(`Stderr error: ${e}`));

// Handle exit
const exitCode = await proc.exited;
log(`Claude process exited with code ${exitCode}`);
process.exit(exitCode);
