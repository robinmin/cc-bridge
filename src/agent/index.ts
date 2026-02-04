import { StdioIpcAdapter } from "@/packages/ipc";
import { app } from "@/agent/app";

// IPC Startup
const adapter = new StdioIpcAdapter(app);

// Prevent listening if running as test/module, check main
if (import.meta.main) {
	// We explicitly avoid "export default app" here to prevent Bun 
	// from automatically starting a web server on port 3000.
	// The StdioIpcAdapter will exit the process once stdin is closed.
	adapter.start();
}
