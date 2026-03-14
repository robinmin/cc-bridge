/**
 * Workspace Bootstrap File Loading
 *
 * Loads workspace bootstrap files (AGENTS.md, SOUL.md, IDENTITY.md, USER.md,
 * MEMORY.md, TOOLS.md) from a workspace directory and concatenates them into
 * a system prompt string.
 *
 * Replaces the unused memory system with OpenClaw-style workspace file injection.
 * Files are loaded on agent boot and injected into the system prompt.
 * Missing files are silently skipped.
 */

import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { logger } from "@/packages/logger";

/**
 * Bootstrap file names loaded from workspace directory.
 * Order matters: files are concatenated in this order for the system prompt.
 */
export const BOOTSTRAP_FILES = [
	"AGENTS.md", // Agent configuration, behavior rules
	"SOUL.md", // Personality, communication style
	"IDENTITY.md", // Identity, name, role
	"USER.md", // User context, preferences
	"MEMORY.md", // Long-term memory, facts
	"TOOLS.md", // Tool documentation, usage hints
] as const;

export type BootstrapFileName = (typeof BOOTSTRAP_FILES)[number];

/**
 * Skill directory names to search for SKILL.md files within a workspace.
 * Order matters: earlier directories take precedence.
 */
export const SKILL_DIRS = [
	"skills", // Project-specific skills
	".agents/skills", // Hidden skills folder
] as const;

/**
 * User-global skills directory (relative to home directory).
 */
export const USER_SKILLS_DIR = ".agents/skills";

/**
 * Strip YAML frontmatter from markdown content.
 * Frontmatter is delimited by --- at the start and end.
 */
function stripFrontmatter(content: string): string {
	const trimmed = content.trimStart();
	if (!trimmed.startsWith("---")) {
		return content;
	}

	// Find the closing ---
	const endIndex = trimmed.indexOf("---", 3);
	if (endIndex === -1) {
		return content;
	}

	// Skip past the closing --- and any trailing newline
	const afterFrontmatter = trimmed.slice(endIndex + 3);
	return afterFrontmatter.replace(/^\r?\n/, "");
}

/**
 * Load a single bootstrap file from the workspace directory.
 * Returns null if the file doesn't exist or can't be read.
 */
async function loadBootstrapFile(workspaceDir: string, fileName: string): Promise<string | null> {
	const filePath = path.join(workspaceDir, fileName);
	try {
		const content = await fs.readFile(filePath, "utf-8");
		const stripped = stripFrontmatter(content).trim();
		if (!stripped) {
			return null;
		}
		return stripped;
	} catch (error) {
		// File doesn't exist or can't be read - skip silently
		if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		// Log unexpected errors but don't throw
		logger.warn({ fileName, workspaceDir, error: String(error) }, "Failed to read bootstrap file");
		return null;
	}
}

/**
 * Load a single skill file and strip frontmatter.
 * Returns the content and skill name (derived from directory name).
 */
async function loadSkill(skillPath: string): Promise<{ content: string; name: string } | null> {
	try {
		const content = await fs.readFile(skillPath, "utf-8");
		const stripped = stripFrontmatter(content).trim();
		if (!stripped) {
			return null;
		}
		// Derive skill name from parent directory name
		const skillName = path.basename(path.dirname(skillPath));
		return { content: stripped, name: skillName };
	} catch (error) {
		// File doesn't exist or can't be read - skip silently
		if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		// Log unexpected errors but don't throw
		logger.warn({ skillPath, error: String(error) }, "Failed to read skill file");
		return null;
	}
}

/**
 * Discover all SKILL.md files in skill directories.
 * Searches workspace-local directories first, then user-global directory.
 * Returns absolute paths to discovered skill files.
 */
export async function discoverSkills(workspaceDir: string): Promise<string[]> {
	const skillPaths: string[] = [];

	// Search workspace-local skill directories
	for (const skillDir of SKILL_DIRS) {
		const fullSkillDir = path.join(workspaceDir, skillDir);
		try {
			const entries = await fs.readdir(fullSkillDir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isDirectory()) {
					const skillFile = path.join(fullSkillDir, entry.name, "SKILL.md");
					try {
						await fs.access(skillFile);
						skillPaths.push(skillFile);
					} catch {
						// SKILL.md doesn't exist in this directory - skip
					}
				}
			}
		} catch {
			// Directory doesn't exist or can't be read - skip silently
		}
	}

	// Search user-global skills directory
	const userSkillDir = path.join(os.homedir(), USER_SKILLS_DIR);
	try {
		const entries = await fs.readdir(userSkillDir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isDirectory()) {
				const skillFile = path.join(userSkillDir, entry.name, "SKILL.md");
				try {
					await fs.access(skillFile);
					skillPaths.push(skillFile);
				} catch {
					// SKILL.md doesn't exist in this directory - skip
				}
			}
		}
	} catch {
		// User-global skills directory doesn't exist - skip silently
	}

	return skillPaths;
}

/**
 * Load all workspace bootstrap files and concatenate into a system prompt string.
 *
 * Files are loaded in BOOTSTRAP_FILES order. Missing files are silently skipped.
 * Each file's content is wrapped with a header comment showing the source file name.
 *
 * @param workspaceDir - Absolute path to the workspace directory containing bootstrap files
 * @returns Concatenated system prompt string, or empty string if no files found
 */
export async function loadWorkspaceBootstrap(workspaceDir: string): Promise<string> {
	const sections: string[] = [];

	for (const fileName of BOOTSTRAP_FILES) {
		const content = await loadBootstrapFile(workspaceDir, fileName);
		if (content) {
			sections.push(`[${fileName}]\n${content}`);
		}
	}

	// Load skills after bootstrap files
	const skillPaths = await discoverSkills(workspaceDir);
	let skillsLoaded = 0;
	for (const skillPath of skillPaths) {
		const skill = await loadSkill(skillPath);
		if (skill) {
			sections.push(`[Skill: ${skill.name}]\n${skill.content}`);
			skillsLoaded++;
		}
	}

	if (sections.length === 0) {
		logger.debug({ workspaceDir }, "No workspace bootstrap files found");
		return "";
	}

	const result = sections.join("\n\n");
	logger.debug(
		{ workspaceDir, fileCount: sections.length - skillsLoaded, skillsLoaded, promptLength: result.length },
		"Loaded workspace bootstrap files and skills",
	);

	return result;
}

// =============================================================================
// WorkspaceWatcher
// =============================================================================

/**
 * Watches workspace bootstrap files for changes and triggers reload callbacks.
 * Uses Node.js fs.watch with debouncing to avoid rapid reloads during saves.
 */
export class WorkspaceWatcher {
	private watchers: Map<string, fsSync.FSWatcher> = new Map();
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly debounceMs: number;
	private readonly workspaceDir: string;
	private readonly onReload: (newPrompt: string) => void;
	private disposed = false;

	constructor(options: {
		workspaceDir: string;
		onReload: (newPrompt: string) => void;
		debounceMs?: number;
	}) {
		this.workspaceDir = options.workspaceDir;
		this.onReload = options.onReload;
		this.debounceMs = options.debounceMs ?? 500;
	}

	/** Start watching bootstrap files. Call once after construction. */
	async start(): Promise<void> {
		if (this.disposed) return;

		for (const fileName of BOOTSTRAP_FILES) {
			const filePath = path.join(this.workspaceDir, fileName);
			try {
				// Check if file exists before watching
				await fs.access(filePath);
				const watcher = fsSync.watch(filePath, { persistent: false }, (eventType) => {
					if (eventType === "change" || eventType === "rename") {
						this.scheduleReload(fileName);
					}
				});
				this.watchers.set(fileName, watcher);
			} catch {
				// File doesn't exist - watch the directory for new file creation instead
			}
		}

		// Also watch the directory itself for new bootstrap files being created
		try {
			const dirWatcher = fsSync.watch(this.workspaceDir, { persistent: false }, (_eventType, filename) => {
				if (filename && BOOTSTRAP_FILES.includes(filename as BootstrapFileName)) {
					this.scheduleReload(filename);
					// Start watching the new file if we weren't already
					this.watchFile(filename);
				}
			});
			this.watchers.set("__dir__", dirWatcher);
		} catch {
			// Directory doesn't exist or can't be watched
			logger.debug({ workspaceDir: this.workspaceDir }, "Cannot watch workspace directory");
		}

		logger.debug({ workspaceDir: this.workspaceDir, watchedFiles: this.watchers.size }, "WorkspaceWatcher started");
	}

	private watchFile(fileName: string): void {
		if (this.watchers.has(fileName)) return;
		const filePath = path.join(this.workspaceDir, fileName);
		try {
			const watcher = fsSync.watch(filePath, { persistent: false }, (eventType) => {
				if (eventType === "change" || eventType === "rename") {
					this.scheduleReload(fileName);
				}
			});
			this.watchers.set(fileName, watcher);
		} catch {
			// File might not exist yet
		}
	}

	private scheduleReload(fileName: string): void {
		if (this.disposed) return;

		logger.debug({ fileName, workspaceDir: this.workspaceDir }, "Bootstrap file change detected");

		// Debounce: multiple rapid changes (e.g., editor save) trigger only one reload
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		this.debounceTimer = setTimeout(async () => {
			await this.reload();
		}, this.debounceMs);
	}

	private async reload(): Promise<void> {
		if (this.disposed) return;
		try {
			const newPrompt = await loadWorkspaceBootstrap(this.workspaceDir);
			this.onReload(newPrompt);
			logger.info(
				{ workspaceDir: this.workspaceDir, promptLength: newPrompt.length },
				"Workspace bootstrap files reloaded",
			);
		} catch (error) {
			logger.error({ workspaceDir: this.workspaceDir, error }, "Failed to reload workspace files");
		}
	}

	/** Stop all watchers and clean up */
	dispose(): void {
		this.disposed = true;
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		for (const [_name, watcher] of this.watchers) {
			watcher.close();
		}
		this.watchers.clear();
		logger.debug({ workspaceDir: this.workspaceDir }, "WorkspaceWatcher disposed");
	}
}
