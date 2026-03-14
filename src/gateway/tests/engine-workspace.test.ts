import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	BOOTSTRAP_FILES,
	discoverSkills,
	loadWorkspaceBootstrap,
	SKILL_DIRS,
	USER_SKILLS_DIR,
	WorkspaceWatcher,
} from "@/gateway/engine/workspace";

describe("workspace", () => {
	let testWorkspace: string;

	beforeEach(async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.homedir(), ".cc-bridge-ws-"));
		testWorkspace = await fs.realpath(tmpDir);
	});

	afterEach(async () => {
		if (testWorkspace) {
			try {
				await fs.rm(testWorkspace, { recursive: true, force: true });
			} catch {}
		}
	});

	describe("BOOTSTRAP_FILES", () => {
		test("contains expected bootstrap files", () => {
			expect(BOOTSTRAP_FILES).toContain("AGENTS.md");
			expect(BOOTSTRAP_FILES).toContain("SOUL.md");
			expect(BOOTSTRAP_FILES).toContain("IDENTITY.md");
			expect(BOOTSTRAP_FILES).toContain("USER.md");
			expect(BOOTSTRAP_FILES).toContain("MEMORY.md");
			expect(BOOTSTRAP_FILES).toContain("TOOLS.md");
		});
	});

	describe("SKILL_DIRS", () => {
		test("contains expected skill directories", () => {
			expect(SKILL_DIRS).toContain("skills");
			expect(SKILL_DIRS).toContain(".agents/skills");
		});
	});

	describe("USER_SKILLS_DIR", () => {
		test("is .agents/skills", () => {
			expect(USER_SKILLS_DIR).toBe(".agents/skills");
		});
	});

	describe("loadWorkspaceBootstrap", () => {
		test("returns empty string when no bootstrap files exist", async () => {
			const result = await loadWorkspaceBootstrap(testWorkspace);
			expect(result).toBe("");
		});

		test("loads single bootstrap file", async () => {
			await fs.writeFile(path.join(testWorkspace, "AGENTS.md"), "# Agent Config\nTest content");
			const result = await loadWorkspaceBootstrap(testWorkspace);
			expect(result).toContain("[AGENTS.md]");
			expect(result).toContain("Test content");
		});

		test("loads multiple bootstrap files in order", async () => {
			await fs.writeFile(path.join(testWorkspace, "AGENTS.md"), "Agents content");
			await fs.writeFile(path.join(testWorkspace, "SOUL.md"), "Soul content");
			await fs.writeFile(path.join(testWorkspace, "IDENTITY.md"), "Identity content");
			const result = await loadWorkspaceBootstrap(testWorkspace);
			expect(result.indexOf("[AGENTS.md]")).toBeLessThan(result.indexOf("[SOUL.md]"));
			expect(result.indexOf("[SOUL.md]")).toBeLessThan(result.indexOf("[IDENTITY.md]"));
		});

		test("skips missing bootstrap files gracefully", async () => {
			await fs.writeFile(path.join(testWorkspace, "AGENTS.md"), "Agents content");
			await fs.writeFile(path.join(testWorkspace, "IDENTITY.md"), "Identity content");
			const result = await loadWorkspaceBootstrap(testWorkspace);
			expect(result).toContain("[AGENTS.md]");
			expect(result).not.toContain("[SOUL.md]");
			expect(result).toContain("[IDENTITY.md]");
		});

		test("strips YAML frontmatter", async () => {
			const content = `---
title: Test
---
# Actual content`;
			await fs.writeFile(path.join(testWorkspace, "AGENTS.md"), content);
			const result = await loadWorkspaceBootstrap(testWorkspace);
			expect(result).toContain("Actual content");
			expect(result).not.toContain("title: Test");
		});

		test("skips empty files after stripping frontmatter", async () => {
			await fs.writeFile(path.join(testWorkspace, "AGENTS.md"), "---\n---\n");
			const result = await loadWorkspaceBootstrap(testWorkspace);
			expect(result).not.toContain("[AGENTS.md]");
		});

		test("handles content without frontmatter", async () => {
			await fs.writeFile(path.join(testWorkspace, "AGENTS.md"), "Just plain content");
			const result = await loadWorkspaceBootstrap(testWorkspace);
			expect(result).toContain("Just plain content");
		});

		test("loads skills from workspace skills directory", async () => {
			const skillDir = path.join(testWorkspace, "skills", "my-skill");
			await fs.mkdir(skillDir, { recursive: true });
			await fs.writeFile(path.join(skillDir, "SKILL.md"), "# My Skill\nSkill content");
			const result = await loadWorkspaceBootstrap(testWorkspace);
			expect(result).toContain("[Skill: my-skill]");
			expect(result).toContain("Skill content");
		});

		test("loads skills from .agents/skills directory", async () => {
			const skillDir = path.join(testWorkspace, ".agents", "skills", "another-skill");
			await fs.mkdir(skillDir, { recursive: true });
			await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Another Skill\nContent");
			const result = await loadWorkspaceBootstrap(testWorkspace);
			expect(result).toContain("[Skill: another-skill]");
		});

		test("skills take precedence over bootstrap files", async () => {
			await fs.writeFile(path.join(testWorkspace, "AGENTS.md"), "Bootstrap");
			const skillDir = path.join(testWorkspace, "skills", "test");
			await fs.mkdir(skillDir, { recursive: true });
			await fs.writeFile(path.join(skillDir, "SKILL.md"), "Skill content");
			const result = await loadWorkspaceBootstrap(testWorkspace);
			const agentsIndex = result.indexOf("[AGENTS.md]");
			const skillIndex = result.indexOf("[Skill:");
			expect(skillIndex).toBeGreaterThan(agentsIndex);
		});

		test("skips skills with empty content after stripping", async () => {
			const skillDir = path.join(testWorkspace, "skills", "empty-skill");
			await fs.mkdir(skillDir, { recursive: true });
			await fs.writeFile(path.join(skillDir, "SKILL.md"), "---\n---\n");
			const result = await loadWorkspaceBootstrap(testWorkspace);
			expect(result).not.toContain("[Skill: empty-skill]");
		});
	});

	describe("discoverSkills", () => {
		test("returns empty array when no skill directories exist", async () => {
			const result = await discoverSkills(testWorkspace);
			expect(result).toEqual([]);
		});

		test("finds skills in workspace skills directory", async () => {
			const skillDir = path.join(testWorkspace, "skills", "test-skill");
			await fs.mkdir(skillDir, { recursive: true });
			await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Test");
			const result = await discoverSkills(testWorkspace);
			expect(result.length).toBeGreaterThan(0);
			expect(result[0]).toContain("test-skill/SKILL.md");
		});

		test("finds skills in .agents/skills directory", async () => {
			const skillDir = path.join(testWorkspace, ".agents", "skills", "hidden-skill");
			await fs.mkdir(skillDir, { recursive: true });
			await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Hidden");
			const result = await discoverSkills(testWorkspace);
			expect(result.some((p) => p.includes("hidden-skill"))).toBe(true);
		});

		test("skips directories without SKILL.md", async () => {
			const skillDir = path.join(testWorkspace, "skills", "no-skill-file");
			await fs.mkdir(skillDir, { recursive: true });
			const result = await discoverSkills(testWorkspace);
			expect(result.some((p) => p.includes("no-skill-file"))).toBe(false);
		});

		test("skips non-directory entries", async () => {
			await fs.mkdir(path.join(testWorkspace, "skills"), { recursive: true });
			await fs.writeFile(path.join(testWorkspace, "skills", "not-a-dir.txt"), "not a skill");
			const result = await discoverSkills(testWorkspace);
			expect(result.some((p) => p.includes("not-a-dir.txt"))).toBe(false);
		});

		test("handles multiple skills from both directories", async () => {
			const skillDir1 = path.join(testWorkspace, "skills", "skill1");
			const skillDir2 = path.join(testWorkspace, ".agents", "skills", "skill2");
			await fs.mkdir(skillDir1, { recursive: true });
			await fs.mkdir(skillDir2, { recursive: true });
			await fs.writeFile(path.join(skillDir1, "SKILL.md"), "# Skill1");
			await fs.writeFile(path.join(skillDir2, "SKILL.md"), "# Skill2");
			const result = await discoverSkills(testWorkspace);
			expect(result.length).toBe(2);
		});
	});

	describe("WorkspaceWatcher", () => {
		test("can be constructed with required options", () => {
			const watcher = new WorkspaceWatcher({
				workspaceDir: testWorkspace,
				onReload: () => {},
			});
			expect(watcher).toBeDefined();
		});

		test("can be constructed with custom debounce", () => {
			const watcher = new WorkspaceWatcher({
				workspaceDir: testWorkspace,
				onReload: () => {},
				debounceMs: 1000,
			});
			expect(watcher).toBeDefined();
		});

		test("start handles empty workspace gracefully", async () => {
			const watcher = new WorkspaceWatcher({
				workspaceDir: testWorkspace,
				onReload: () => {},
			});
			await watcher.start();
			watcher.dispose();
		});

		test("start watches existing bootstrap files", async () => {
			await fs.writeFile(path.join(testWorkspace, "AGENTS.md"), "test");
			const reloadFn = () => {};
			const watcher = new WorkspaceWatcher({
				workspaceDir: testWorkspace,
				onReload: reloadFn,
			});
			await watcher.start();
			watcher.dispose();
		});

		test("dispose cleans up watchers", async () => {
			await fs.writeFile(path.join(testWorkspace, "AGENTS.md"), "test");
			const watcher = new WorkspaceWatcher({
				workspaceDir: testWorkspace,
				onReload: () => {},
			});
			await watcher.start();
			watcher.dispose();
			watcher.dispose();
		});

		test("start returns early if disposed", async () => {
			const watcher = new WorkspaceWatcher({
				workspaceDir: testWorkspace,
				onReload: () => {},
			});
			await watcher.start();
			watcher.dispose();
			await watcher.start();
		});

		test("handles non-existent workspace directory", async () => {
			const nonExistent = path.join(os.homedir(), `.nonexistent-${Date.now()}`);
			const watcher = new WorkspaceWatcher({
				workspaceDir: nonExistent,
				onReload: () => {},
			});
			await watcher.start();
			watcher.dispose();
		});

		test("detects file changes and triggers reload callback", async () => {
			const reloadFn = mock(() => {});
			await fs.writeFile(path.join(testWorkspace, "AGENTS.md"), "initial");

			const watcher = new WorkspaceWatcher({
				workspaceDir: testWorkspace,
				onReload: reloadFn,
				debounceMs: 100,
			});
			await watcher.start();

			// Wait a bit then modify the file
			await new Promise((resolve) => setTimeout(resolve, 50));
			await fs.writeFile(path.join(testWorkspace, "AGENTS.md"), "modified");

			// Wait for debounce
			await new Promise((resolve) => setTimeout(resolve, 200));

			watcher.dispose();
		});
	});
});
