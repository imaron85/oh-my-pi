import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FleetIndex, type FleetIndexEntry } from "@oh-my-pi/pi-coding-agent/fleet/fleet-index";
import { __resetDirsFromEnvForTests, setAgentDir } from "@oh-my-pi/pi-utils";

/**
 * Contract tests for the durable per-project fleet index: persisted round-trip
 * with createdAt-descending order, id-keyed upsert/remove semantics, pruning of
 * dead session files, and corrupt-file tolerance.
 */
describe("fleet index", () => {
	let agentDir: string;
	let repoRoot: string;

	function makeEntry(id: string, createdAt: string, overrides: Partial<FleetIndexEntry> = {}): FleetIndexEntry {
		return {
			id,
			sessionFile: path.join(agentDir, `${id}.jsonl`),
			cwd: repoRoot,
			createdAt,
			updatedAt: createdAt,
			...overrides,
		};
	}

	beforeEach(async () => {
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fleet-agent-"));
		repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fleet-repo-"));
		setAgentDir(agentDir);
	});

	afterEach(async () => {
		__resetDirsFromEnvForTests();
		await fs.rm(agentDir, { recursive: true, force: true });
		await fs.rm(repoRoot, { recursive: true, force: true });
	});

	it("round-trips entries through disk in createdAt-descending order", async () => {
		const index = await FleetIndex.load(repoRoot);
		expect(index.entries()).toEqual([]);
		expect(path.dirname(index.path)).toBe(path.join(agentDir, "fleet"));
		expect(index.path.endsWith(".json")).toBe(true);

		const oldest = makeEntry("older", "2026-01-01T00:00:00.000Z", { title: "Old work" });
		const newest = makeEntry("newer", "2026-03-01T00:00:00.000Z", {
			model: "anthropic/claude-fable-5",
			worktree: { path: "/tmp/wt/s-newer-abc", branch: "omp/session/newer" },
		});
		const middle = makeEntry("middle", "2026-02-01T00:00:00.000Z");
		await index.upsert(oldest);
		await index.upsert(newest);
		await index.upsert(middle);

		expect(index.entries().map(entry => entry.id)).toEqual(["newer", "middle", "older"]);

		const reloaded = await FleetIndex.load(repoRoot);
		expect(reloaded.path).toBe(index.path);
		expect(reloaded.entries()).toEqual([newest, middle, oldest]);
		// Optional fields survive the round-trip intact.
		expect(reloaded.get("newer")?.worktree).toEqual({ path: "/tmp/wt/s-newer-abc", branch: "omp/session/newer" });
		expect(reloaded.get("older")?.title).toBe("Old work");
	});

	it("keys buckets by repo root", async () => {
		const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fleet-repo2-"));
		try {
			const index = await FleetIndex.load(repoRoot);
			const other = await FleetIndex.load(otherRoot);
			expect(other.path).not.toBe(index.path);

			await index.upsert(makeEntry("mine", "2026-01-01T00:00:00.000Z"));
			expect((await FleetIndex.load(otherRoot)).entries()).toEqual([]);
		} finally {
			await fs.rm(otherRoot, { recursive: true, force: true });
		}
	});

	it("upsert with an existing id replaces the entry", async () => {
		const index = await FleetIndex.load(repoRoot);
		await index.upsert(makeEntry("one", "2026-01-01T00:00:00.000Z", { title: "before" }));
		await index.upsert(
			makeEntry("one", "2026-01-01T00:00:00.000Z", { title: "after", updatedAt: "2026-01-02T00:00:00.000Z" }),
		);

		expect(index.get("one")?.title).toBe("after");
		const reloaded = await FleetIndex.load(repoRoot);
		expect(reloaded.entries()).toHaveLength(1);
		expect(reloaded.get("one")?.updatedAt).toBe("2026-01-02T00:00:00.000Z");
	});

	it("remove drops the entry and persists the removal", async () => {
		const index = await FleetIndex.load(repoRoot);
		await index.upsert(makeEntry("gone", "2026-01-01T00:00:00.000Z"));
		await index.remove("gone");
		await index.remove("never-existed");

		expect(index.get("gone")).toBeUndefined();
		expect((await FleetIndex.load(repoRoot)).entries()).toEqual([]);
	});

	it("prune drops entries whose session file is missing and returns their ids", async () => {
		const index = await FleetIndex.load(repoRoot);
		const alive = makeEntry("alive", "2026-01-01T00:00:00.000Z");
		await Bun.write(alive.sessionFile, "{}\n");
		const dead = makeEntry("dead", "2026-02-01T00:00:00.000Z", {
			sessionFile: path.join(agentDir, "does-not-exist.jsonl"),
		});
		await index.upsert(alive);
		await index.upsert(dead);

		expect(await index.prune()).toEqual(["dead"]);
		expect(index.entries().map(entry => entry.id)).toEqual(["alive"]);
		expect((await FleetIndex.load(repoRoot)).entries()).toEqual([alive]);
	});

	it("loads empty from a corrupt index file without throwing", async () => {
		const first = await FleetIndex.load(repoRoot);
		await Bun.write(first.path, "{ not json");

		const recovered = await FleetIndex.load(repoRoot);
		expect(recovered.entries()).toEqual([]);

		// The index stays writable after recovery.
		await recovered.upsert(makeEntry("fresh", "2026-01-01T00:00:00.000Z"));
		expect((await FleetIndex.load(repoRoot)).get("fresh")?.id).toBe("fresh");
	});
});
