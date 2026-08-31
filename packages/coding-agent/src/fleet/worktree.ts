/**
 * Persistent per-session git worktrees for the fleet overview.
 *
 * Each fleet session gets a real branch checkout under the managed worktree
 * base (`~/.omp/wt/` by default): branch `omp/session/<name>` created from the
 * primary repo's current HEAD, plus a {@link SESSION_WORKTREE_MARKER} JSON file
 * inside the worktree root identifying it. Unlike task-isolation sandboxes,
 * these worktrees are persistent — there is deliberately no cleanup API here;
 * lifecycle is manual via `omp worktree`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getWorktreeDir, getWorktreesDir, isEnoent, isEnotdir, logger } from "@oh-my-pi/pi-utils";
import { replaceFileAtomically } from "../utils/atomic-file";

/** Marker file written into a session worktree root identifying it. */
export const SESSION_WORKTREE_MARKER = ".omp-session-worktree.json";

const SESSION_BRANCH_PREFIX = "omp/session/";
const SESSION_DIR_PREFIX = "s-";
/** Matches `hashPath`'s digest width for managed-dir segments. */
const SESSION_DIR_DIGEST_CHARS = 7;
/** Disambiguation cap, mirrors `WORKTREE_PATH_MAX_SUFFIX` in tools/gh-pr-checkout. */
const MAX_COLLISION_SUFFIX = 100;

/** Recorded identity of a session worktree, persisted as its marker file. */
export interface SessionWorktreeInfo {
	/** Absolute worktree dir. */
	path: string;
	/** Checked-out branch, e.g. `omp/session/fix-auth`. */
	branch: string;
	/** Sanitized display name. */
	name: string;
	/** Primary repo root the worktree belongs to. */
	repoRoot: string;
	/** ISO creation timestamp. */
	createdAt: string;
	/** Bound omp session JSONL path, once known. */
	sessionFile?: string;
}

/**
 * Same sanitation policy as `sanitizeAgentId` in ../task/structured-subagent.ts
 * (not exported there): keep `[A-Za-z0-9_-]`, cap at 48 chars.
 */
function sanitizeSessionName(value: string): string {
	return value.replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 48);
}

async function writeMarker(dir: string, info: SessionWorktreeInfo): Promise<void> {
	const target = path.join(dir, SESSION_WORKTREE_MARKER);
	const tempPath = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
	await Bun.write(tempPath, `${JSON.stringify(info, null, "\t")}\n`);
	try {
		await replaceFileAtomically(tempPath, target);
	} catch (error) {
		await fs.rm(tempPath, { force: true }).catch(() => {});
		throw error;
	}
}

type MarkerReadResult =
	| { status: "ok"; info: SessionWorktreeInfo }
	| { status: "missing" }
	| { status: "invalid"; reason: string };

function parseMarker(raw: unknown, dir: string): SessionWorktreeInfo | null {
	if (typeof raw !== "object" || raw === null) return null;
	const record = raw as Record<string, unknown>;
	const { branch, name, repoRoot, createdAt, sessionFile } = record;
	if (
		typeof branch !== "string" ||
		typeof name !== "string" ||
		typeof repoRoot !== "string" ||
		typeof createdAt !== "string"
	) {
		return null;
	}
	// `path` is normalized to the dir the marker was read from, so a relocated
	// managed base never yields stale absolute paths.
	const info: SessionWorktreeInfo = { path: dir, branch, name, repoRoot, createdAt };
	if (typeof sessionFile === "string") info.sessionFile = sessionFile;
	return info;
}

async function readMarker(dir: string): Promise<MarkerReadResult> {
	let raw: unknown;
	try {
		raw = await Bun.file(path.join(dir, SESSION_WORKTREE_MARKER)).json();
	} catch (error) {
		if (isEnoent(error) || isEnotdir(error)) return { status: "missing" };
		return { status: "invalid", reason: error instanceof Error ? error.message : String(error) };
	}
	const info = parseMarker(raw, dir);
	return info ? { status: "ok", info } : { status: "invalid", reason: "missing required fields" };
}

/**
 * Create a persistent session worktree for `repoRoot`: a branch
 * `omp/session/<name>` off the current HEAD, checked out under the managed
 * worktree base with a marker file inside. Dir and branch collisions are
 * disambiguated with a shared `-2`, `-3`, … suffix.
 */
export async function createSessionWorktree(args: { repoRoot: string; name: string }): Promise<SessionWorktreeInfo> {
	const repoRoot = path.resolve(args.repoRoot);
	const name = sanitizeSessionName(args.name);
	if (!name) {
		throw new Error(`session worktree name ${JSON.stringify(args.name)} contains no [A-Za-z0-9_-] characters`);
	}
	const repository = vcs.requireGit(repoRoot);
	const digest = Bun.hash(`${repoRoot}\0${name}`).toString(16).padStart(16, "0").slice(-SESSION_DIR_DIGEST_CHARS);
	const baseSegment = `${SESSION_DIR_PREFIX}${name}-${digest}`;
	const baseBranch = `${SESSION_BRANCH_PREFIX}${name}`;

	let dir: string | undefined;
	let branch: string | undefined;
	for (let attempt = 1; attempt <= MAX_COLLISION_SUFFIX; attempt++) {
		const suffix = attempt === 1 ? "" : `-${attempt}`;
		const candidateDir = getWorktreeDir(`${baseSegment}${suffix}`);
		const candidateBranch = `${baseBranch}${suffix}`;
		const dirTaken = await fs.stat(candidateDir).then(
			() => true,
			() => false,
		);
		if (dirTaken) continue;
		if (await repository.refExists(`refs/heads/${candidateBranch}`)) continue;
		dir = candidateDir;
		branch = candidateBranch;
		break;
	}
	if (!dir || !branch) {
		throw new Error(
			`unable to find a free session worktree slot for "${name}" after ${MAX_COLLISION_SUFFIX} attempts`,
		);
	}

	await repository.createBranch(branch, "HEAD", false);
	await fs.mkdir(path.dirname(dir), { recursive: true });
	await repository.worktreeAdd(dir, branch, false);

	const info: SessionWorktreeInfo = {
		path: dir,
		branch,
		name,
		repoRoot,
		createdAt: new Date().toISOString(),
	};
	await writeMarker(dir, info);
	return info;
}

/** Read the session worktree marker in `dir`; `null` when absent or malformed. */
export async function readSessionWorktreeMarker(dir: string): Promise<SessionWorktreeInfo | null> {
	const resolved = path.resolve(dir);
	const result = await readMarker(resolved);
	if (result.status === "invalid") {
		logger.warn("Fleet: malformed session worktree marker", { dir: resolved, reason: result.reason });
	}
	return result.status === "ok" ? result.info : null;
}

/** Record the omp session JSONL file backing the worktree at `dir`. */
export async function bindSessionWorktree(dir: string, sessionFile: string): Promise<void> {
	const resolved = path.resolve(dir);
	const result = await readMarker(resolved);
	if (result.status !== "ok") {
		const detail = result.status === "invalid" ? ` (${result.reason})` : "";
		throw new Error(`no session worktree marker at ${resolved}${detail}`);
	}
	result.info.sessionFile = path.resolve(sessionFile);
	await writeMarker(resolved, result.info);
}

/**
 * Enumerate marked session worktrees under the managed base, newest first.
 * Dirs without a marker are skipped silently; malformed markers are skipped
 * with a warning. When `repoRoot` is given, only its worktrees are returned.
 */
export async function listSessionWorktrees(repoRoot?: string): Promise<SessionWorktreeInfo[]> {
	const root = getWorktreesDir();
	let names: string[];
	try {
		names = await fs.readdir(root);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const wanted = repoRoot === undefined ? undefined : path.resolve(repoRoot);
	const infos: SessionWorktreeInfo[] = [];
	for (const entry of names) {
		const dir = path.join(root, entry);
		const result = await readMarker(dir);
		if (result.status === "missing") continue;
		if (result.status === "invalid") {
			logger.warn("Fleet: malformed session worktree marker", { dir, reason: result.reason });
			continue;
		}
		if (wanted !== undefined && path.resolve(result.info.repoRoot) !== wanted) continue;
		infos.push(result.info);
	}
	infos.sort((a, b) =>
		a.createdAt === b.createdAt ? a.path.localeCompare(b.path) : b.createdAt.localeCompare(a.createdAt),
	);
	return infos;
}
