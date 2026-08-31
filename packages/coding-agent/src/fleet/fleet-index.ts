/**
 * Durable per-project fleet index: which omp sessions belong to a checkout,
 * where they live (worktree or repo root), and which JSONL file backs each.
 *
 * Backing store is one JSON file per project at
 * `<agent-config-dir>/fleet/<bucket>.json`, where `<bucket>` reuses the
 * canonical session-dir cwd encoding so fleet buckets and session dirs for the
 * same checkout share one name. Every mutation writes through atomically.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { computeDefaultSessionDir } from "../session/session-paths";
import { MemorySessionStorage } from "../session/session-storage";
import { replaceFileAtomically } from "../utils/atomic-file";

/** One fleet session known to the index. */
export interface FleetIndexEntry {
	/** Stable fleet id (caller-supplied). */
	id: string;
	title?: string;
	/** Absolute JSONL path. */
	sessionFile: string;
	/** Session cwd (worktree path or repo root). */
	cwd: string;
	worktree?: { path: string; branch: string };
	/** Model id string. */
	model?: string;
	/** ISO timestamp. */
	createdAt: string;
	/** ISO timestamp. */
	updatedAt: string;
}

interface FleetIndexFile {
	version: 1;
	entries: FleetIndexEntry[];
}

/**
 * Storage stub for {@link computeDefaultSessionDir}: we only borrow its bucket
 * naming, so directory creation must be a no-op.
 */
const bucketStorage = new MemorySessionStorage();

function parseEntry(raw: unknown): FleetIndexEntry | null {
	if (typeof raw !== "object" || raw === null) return null;
	const record = raw as Record<string, unknown>;
	if (
		typeof record.id !== "string" ||
		typeof record.sessionFile !== "string" ||
		typeof record.cwd !== "string" ||
		typeof record.createdAt !== "string" ||
		typeof record.updatedAt !== "string"
	) {
		return null;
	}
	const entry: FleetIndexEntry = {
		id: record.id,
		sessionFile: record.sessionFile,
		cwd: record.cwd,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
	if (typeof record.title === "string") entry.title = record.title;
	if (typeof record.model === "string") entry.model = record.model;
	const worktree = record.worktree;
	if (typeof worktree === "object" && worktree !== null) {
		const wt = worktree as Record<string, unknown>;
		if (typeof wt.path === "string" && typeof wt.branch === "string") {
			entry.worktree = { path: wt.path, branch: wt.branch };
		}
	}
	return entry;
}

/** Durable, atomically persisted index of fleet sessions for one project. */
export class FleetIndex {
	/** Backing JSON file. */
	readonly path: string;

	#entries: Map<string, FleetIndexEntry>;

	constructor(indexPath: string, entries: Map<string, FleetIndexEntry>) {
		this.path = indexPath;
		this.#entries = entries;
	}

	/**
	 * Load the index for `repoRoot`. A missing file starts empty; a corrupt one
	 * starts empty with a warning instead of throwing.
	 */
	static async load(repoRoot: string): Promise<FleetIndex> {
		const fleetRoot = path.join(getAgentDir(), "fleet");
		const indexPath = `${computeDefaultSessionDir(path.resolve(repoRoot), bucketStorage, fleetRoot)}.json`;
		const entries = new Map<string, FleetIndexEntry>();
		let raw: unknown;
		try {
			raw = await Bun.file(indexPath).json();
		} catch (error) {
			if (!isEnoent(error)) {
				logger.warn("Fleet: unreadable fleet index; starting empty", { path: indexPath, error: String(error) });
			}
			return new FleetIndex(indexPath, entries);
		}
		const file = raw as Partial<FleetIndexFile> | null;
		if (typeof file !== "object" || file === null || !Array.isArray(file.entries)) {
			logger.warn("Fleet: malformed fleet index; starting empty", { path: indexPath });
			return new FleetIndex(indexPath, entries);
		}
		for (const rawEntry of file.entries) {
			const entry = parseEntry(rawEntry);
			if (!entry) {
				logger.warn("Fleet: dropping malformed fleet index entry", { path: indexPath });
				continue;
			}
			entries.set(entry.id, entry);
		}
		return new FleetIndex(indexPath, entries);
	}

	/** All entries, `createdAt` descending (id ascending on ties). */
	entries(): FleetIndexEntry[] {
		return [...this.#entries.values()].sort((a, b) =>
			a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : b.createdAt.localeCompare(a.createdAt),
		);
	}

	get(id: string): FleetIndexEntry | undefined {
		return this.#entries.get(id);
	}

	/** Insert or replace the entry with `entry.id`, writing through atomically. */
	async upsert(entry: FleetIndexEntry): Promise<void> {
		this.#entries.set(entry.id, entry);
		await this.#save();
	}

	async remove(id: string): Promise<void> {
		if (this.#entries.delete(id)) await this.#save();
	}

	/** Drop entries whose `sessionFile` no longer exists; returns removed ids. */
	async prune(): Promise<string[]> {
		const removed: string[] = [];
		for (const entry of this.#entries.values()) {
			const exists = await fs.stat(entry.sessionFile).then(
				() => true,
				() => false,
			);
			if (!exists) removed.push(entry.id);
		}
		if (removed.length > 0) {
			for (const id of removed) this.#entries.delete(id);
			await this.#save();
		}
		return removed;
	}

	async #save(): Promise<void> {
		const payload: FleetIndexFile = { version: 1, entries: this.entries() };
		const tempPath = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
		await Bun.write(tempPath, `${JSON.stringify(payload, null, "\t")}\n`);
		try {
			await replaceFileAtomically(tempPath, this.path);
		} catch (error) {
			await fs.rm(tempPath, { force: true }).catch(() => {});
			throw error;
		}
	}
}
