import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	bindSessionWorktree,
	createSessionWorktree,
	listSessionWorktrees,
	readSessionWorktreeMarker,
	SESSION_WORKTREE_MARKER,
} from "@oh-my-pi/pi-coding-agent/fleet/worktree";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { $ } from "bun";

/**
 * Contract tests for fleet session worktrees: a `createSessionWorktree` call
 * must yield a usable branch checkout with a durable marker, collisions must
 * disambiguate dir and branch in lockstep, and `listSessionWorktrees` must see
 * exactly the marked dirs under the managed base.
 */
describe("fleet session worktrees", () => {
	let repo: string;
	let base: string;
	let savedWorktreeEnv: string | undefined;
	let savedGitGlobal: string | undefined;
	let savedGitSystem: string | undefined;
	const tempDirs: string[] = [];

	async function initRepo(prefix: string): Promise<string> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
		tempDirs.push(dir);
		await $`git init --initial-branch=main && git config user.email tester@example.com && git config user.name Tester`
			.cwd(dir)
			.quiet();
		await Bun.write(path.join(dir, "README.md"), "# fixture\n");
		await $`git add -A && git commit -m baseline`.cwd(dir).quiet();
		return dir;
	}

	beforeAll(async () => {
		// Keep user gitconfig (signing, hooks, templates) out of fixture repos.
		savedGitGlobal = process.env.GIT_CONFIG_GLOBAL;
		savedGitSystem = process.env.GIT_CONFIG_SYSTEM;
		process.env.GIT_CONFIG_GLOBAL = "/dev/null";
		process.env.GIT_CONFIG_SYSTEM = "/dev/null";
		repo = await initRepo("omp-fleet-wt-repo-");
	});

	afterAll(async () => {
		if (savedGitGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
		else process.env.GIT_CONFIG_GLOBAL = savedGitGlobal;
		if (savedGitSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
		else process.env.GIT_CONFIG_SYSTEM = savedGitSystem;
		for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true });
	});

	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fleet-wt-base-"));
		savedWorktreeEnv = process.env.OMP_WORKTREE_DIR;
		process.env.OMP_WORKTREE_DIR = base;
	});

	afterEach(async () => {
		if (savedWorktreeEnv === undefined) delete process.env.OMP_WORKTREE_DIR;
		else process.env.OMP_WORKTREE_DIR = savedWorktreeEnv;
		await fs.rm(base, { recursive: true, force: true });
	});

	it("creates a usable branch checkout with a readable marker", async () => {
		const info = await createSessionWorktree({ repoRoot: repo, name: "fix auth!" });

		// Name is sanitized to [A-Za-z0-9_-]; branch and dir derive from it.
		expect(info.name).toBe("fixauth");
		expect(info.branch).toBe("omp/session/fixauth");
		expect(info.repoRoot).toBe(repo);
		expect(path.dirname(info.path)).toBe(base);
		expect(path.basename(info.path).startsWith("s-fixauth-")).toBe(true);

		// The branch exists in the repo and the worktree is a real (non-detached)
		// checkout of it, populated from HEAD.
		expect(await vcs.requireGit(repo).refExists("refs/heads/omp/session/fixauth")).toBe(true);
		expect(await vcs.requireGit(info.path).currentBranch()).toBe("omp/session/fixauth");
		expect(await Bun.file(path.join(info.path, "README.md")).text()).toBe("# fixture\n");

		const marker = await readSessionWorktreeMarker(info.path);
		expect(marker).toEqual(info);
		expect(marker?.sessionFile).toBeUndefined();
	});

	it("disambiguates dir and branch with a shared suffix on collision", async () => {
		const first = await createSessionWorktree({ repoRoot: repo, name: "dup" });
		const second = await createSessionWorktree({ repoRoot: repo, name: "dup" });

		expect(second.path).not.toBe(first.path);
		expect(second.path).toBe(`${first.path}-2`);
		expect(second.branch).toBe("omp/session/dup-2");
		expect(await vcs.requireGit(repo).refExists("refs/heads/omp/session/dup-2")).toBe(true);
		expect((await readSessionWorktreeMarker(second.path))?.branch).toBe("omp/session/dup-2");
	});

	it("skips a slot whose branch already exists even when the dir is free", async () => {
		await vcs.requireGit(repo).createBranch("omp/session/pre", "HEAD", false);
		const info = await createSessionWorktree({ repoRoot: repo, name: "pre" });
		// Dir and branch must carry the same suffix, so the free dir slot is
		// skipped along with the taken branch.
		expect(info.branch).toBe("omp/session/pre-2");
		expect(info.path.endsWith("-2")).toBe(true);
	});

	it("rejects names with no representable characters", async () => {
		await expect(createSessionWorktree({ repoRoot: repo, name: "!!!" })).rejects.toThrow(/no \[A-Za-z0-9_-\]/);
	});

	it("binds a session file and round-trips it through the marker", async () => {
		const info = await createSessionWorktree({ repoRoot: repo, name: "bindme" });
		const sessionFile = path.join(base, "session.jsonl");
		await bindSessionWorktree(info.path, sessionFile);

		const marker = await readSessionWorktreeMarker(info.path);
		expect(marker?.sessionFile).toBe(sessionFile);
		// Binding preserves the original identity fields.
		expect(marker?.branch).toBe(info.branch);
		expect(marker?.createdAt).toBe(info.createdAt);
	});

	it("refuses to bind a dir without a marker", async () => {
		const plain = path.join(base, "not-a-session");
		await fs.mkdir(plain, { recursive: true });
		await expect(bindSessionWorktree(plain, "/tmp/whatever.jsonl")).rejects.toThrow(/no session worktree marker/);
	});

	it("lists only marked dirs and filters by repo root", async () => {
		const a = await createSessionWorktree({ repoRoot: repo, name: "lista" });
		const b = await createSessionWorktree({ repoRoot: repo, name: "listb" });
		const otherRepo = await initRepo("omp-fleet-wt-other-");
		const c = await createSessionWorktree({ repoRoot: otherRepo, name: "listc" });

		// Noise the scanner must skip: an unmarked dir and a malformed marker.
		await fs.mkdir(path.join(base, "unmarked"), { recursive: true });
		const malformed = path.join(base, "malformed");
		await fs.mkdir(malformed, { recursive: true });
		await Bun.write(path.join(malformed, SESSION_WORKTREE_MARKER), "{ not json");

		const all = await listSessionWorktrees();
		expect(all.map(info => info.path).sort()).toEqual([a.path, b.path, c.path].sort());

		const filtered = await listSessionWorktrees(repo);
		expect(filtered.map(info => info.path).sort()).toEqual([a.path, b.path].sort());
	});
});
