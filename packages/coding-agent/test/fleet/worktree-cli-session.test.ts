import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearWorktrees, listWorktrees, type WorktreeEntry } from "@oh-my-pi/pi-coding-agent/cli/worktree-cli";
import { createSessionWorktree } from "@oh-my-pi/pi-coding-agent/fleet/worktree";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { $ } from "bun";

interface ClearJson {
	removed?: number;
	failed?: number;
	skipped?: { path: string; reason: string }[];
	results?: { path: string; ok: boolean; error?: string }[];
	kept?: number;
}

/**
 * `omp worktree` contract for fleet session worktrees: the scanner reports them
 * as kind `session` with marker metadata, default `clear` never touches them,
 * and `--all` removes them only via `git worktree remove` — refusing dirty
 * checkouts with a per-entry warning instead of failing the run.
 */
describe("worktree CLI session worktrees", () => {
	let repo: string;
	let base: string;
	let savedWorktreeEnv: string | undefined;
	let savedGitGlobal: string | undefined;
	let savedGitSystem: string | undefined;
	let logLines: string[];

	beforeAll(async () => {
		savedGitGlobal = process.env.GIT_CONFIG_GLOBAL;
		savedGitSystem = process.env.GIT_CONFIG_SYSTEM;
		process.env.GIT_CONFIG_GLOBAL = "/dev/null";
		process.env.GIT_CONFIG_SYSTEM = "/dev/null";
		repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fleet-cli-repo-"));
		await $`git init --initial-branch=main && git config user.email tester@example.com && git config user.name Tester`
			.cwd(repo)
			.quiet();
		await Bun.write(path.join(repo, "README.md"), "# fixture\n");
		await $`git add -A && git commit -m baseline`.cwd(repo).quiet();
	});

	afterAll(async () => {
		if (savedGitGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
		else process.env.GIT_CONFIG_GLOBAL = savedGitGlobal;
		if (savedGitSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
		else process.env.GIT_CONFIG_SYSTEM = savedGitSystem;
		await fs.rm(repo, { recursive: true, force: true });
	});

	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fleet-cli-base-"));
		savedWorktreeEnv = process.env.OMP_WORKTREE_DIR;
		process.env.OMP_WORKTREE_DIR = base;
		logLines = [];
		vi.spyOn(console, "log").mockImplementation((line: unknown) => {
			logLines.push(String(line));
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		process.exitCode = undefined;
		if (savedWorktreeEnv === undefined) delete process.env.OMP_WORKTREE_DIR;
		else process.env.OMP_WORKTREE_DIR = savedWorktreeEnv;
		await fs.rm(base, { recursive: true, force: true });
	});

	it("scanner reports session worktrees with marker name and branch", async () => {
		const info = await createSessionWorktree({ repoRoot: repo, name: "scanme" });

		await listWorktrees({ json: true });
		const entries = JSON.parse(logLines.join("\n")) as WorktreeEntry[];
		expect(entries).toHaveLength(1);
		expect(entries[0]).toEqual({
			path: info.path,
			kind: "session",
			parentRepo: repo,
			branch: "omp/session/scanme",
			name: "scanme",
		});
	});

	it("default clear skips session worktrees entirely", async () => {
		const info = await createSessionWorktree({ repoRoot: repo, name: "keepme" });

		await clearWorktrees({ all: false, dryRun: false, json: true });
		const output = JSON.parse(logLines.join("\n")) as ClearJson;
		expect(output.removed).toBe(0);
		expect(
			await fs.stat(info.path).then(
				() => true,
				() => false,
			),
		).toBe(true);
		expect(process.exitCode).toBeUndefined();
	});

	it("--all refuses dirty session worktrees with a per-entry warning", async () => {
		const info = await createSessionWorktree({ repoRoot: repo, name: "dirtyme" });
		await Bun.write(path.join(info.path, "wip.txt"), "uncommitted\n");

		await clearWorktrees({ all: true, dryRun: false, json: true });
		const output = JSON.parse(logLines.join("\n")) as ClearJson;
		expect(output.skipped).toEqual([{ path: info.path, reason: expect.stringContaining("uncommitted") }]);
		expect(output.failed).toBe(0);
		expect(
			await fs.stat(info.path).then(
				() => true,
				() => false,
			),
		).toBe(true);
		// A protective refusal is a warning, not a failed run.
		expect(process.exitCode).toBeUndefined();
	});

	it("--all removes clean session worktrees via git worktree removal", async () => {
		const info = await createSessionWorktree({ repoRoot: repo, name: "cleanme" });

		await clearWorktrees({ all: true, dryRun: false, json: true });
		const output = JSON.parse(logLines.join("\n")) as ClearJson;
		expect(output.removed).toBe(1);
		expect(output.skipped).toEqual([]);
		expect(
			await fs.stat(info.path).then(
				() => true,
				() => false,
			),
		).toBe(false);

		// Removed through git, so the parent repo no longer tracks the worktree —
		// while the persistent session branch survives.
		const worktrees = await vcs.requireGit(repo).worktrees();
		expect(worktrees.some(entry => entry.path === info.path)).toBe(false);
		expect(await vcs.requireGit(repo).refExists("refs/heads/omp/session/cleanme")).toBe(true);
	});
});
