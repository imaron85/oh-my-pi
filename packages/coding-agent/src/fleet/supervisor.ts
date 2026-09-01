/**
 * FleetSupervisor - owns the resident top-level sessions of one omp process.
 *
 * Each launch creates (or resumes) a full AgentSession via the injected
 * factory, optionally inside a dedicated persistent git worktree, wires its
 * run-state and dialog-gate signals into an observable {@link FleetRecord},
 * and mirrors identity into the durable {@link FleetIndex} so a crashed or
 * closed process can list and resume every session without hunting paths.
 *
 * Status is corroborated, never inferred from registry status alone
 * (upstream #7503): `running` comes from `subscribeRunState`, `waiting` from
 * the UI gate's pending-dialog count, `done`/`error` from the launched
 * prompt's settled promise.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import type { AgentRegistry } from "../registry/agent-registry";
import { oneLineLabel } from "../task/types";
import type { FleetIndex, FleetIndexEntry } from "./fleet-index";
import { FleetPeerBridge } from "./peer-bridge";
import type { FleetLaunchRequest, FleetRecord, FleetSessionFactory, FleetSessionHandle } from "./types";
import { FleetUiGate } from "./ui-mux";
import { bindSessionWorktree, createSessionWorktree } from "./worktree";

export interface FleetSupervisorDeps {
	factory: FleetSessionFactory;
	/** Primary project root: worktree base + fleet index key. */
	repoRoot: string;
	/** Project is a git checkout; enables per-session worktrees. */
	gitAvailable: boolean;
	index: FleetIndex;
	/** The real interactive UI context, once available (InteractiveMode.getToolUIContext). */
	getUi: () => ExtensionUIContext | undefined;
	/**
	 * The host TUI's main session as a peer participant (global registry).
	 * When provided, every fleet session and the main session mirror each
	 * other as `peer/<id>` refs for cross-session hub awareness/messaging.
	 */
	mainPeer?: { registry: AgentRegistry; sessionFile?: string; displayName?: string };
}

interface FleetRuntime {
	record: FleetRecord;
	handle: FleetSessionHandle;
	unsubscribeRunState: () => void;
	pendingDialogs: number;
	/** A supervisor-launched prompt exists (distinguishes `done` from a merely idle resumed session). */
	launched: boolean;
	/** Settled state of the last supervisor-launched prompt. */
	promptSettled: boolean;
}

export class FleetSupervisor {
	#deps: FleetSupervisorDeps;
	#gate: FleetUiGate;
	#runtimes = new Map<string, FleetRuntime>();
	#listeners = new Set<() => void>();
	#disposed = false;
	#bridge = new FleetPeerBridge();

	constructor(deps: FleetSupervisorDeps) {
		this.#deps = deps;
		this.#gate = new FleetUiGate({
			getUi: deps.getUi,
			onPendingChange: (id, pending) => this.#onDialogPending(id, pending),
		});
		if (deps.mainPeer) {
			this.#bridge.join({
				peerId: "peer/main",
				displayName: deps.mainPeer.displayName ?? "main session",
				registry: deps.mainPeer.registry,
				sessionFile: deps.mainPeer.sessionFile,
			});
		}
	}

	/** Push the host main session's run state onto its peer mirrors. */
	syncMainPeerStatus(status: "running" | "idle"): void {
		this.#bridge.syncStatus("peer/main", status);
	}

	/** Live records, newest first. */
	records(): FleetRecord[] {
		return [...this.#runtimes.values()].map(runtime => runtime.record).sort((a, b) => b.createdAt - a.createdAt);
	}

	get(id: string): FleetRecord | undefined {
		return this.#runtimes.get(id)?.record;
	}

	/** Durable entries with no live runtime (resumable dead sessions), newest first. */
	archivedEntries(): FleetIndexEntry[] {
		return this.#deps.index.entries().filter(entry => !this.#runtimes.has(entry.id));
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Forwarded from the focus bridge; wakes queued dialogs of the focused session. */
	setFocused(id: string | null): void {
		this.#gate.setFocused(id);
	}

	/** Launch a new supervised session and fire its initial prompt (not awaited). */
	async launch(request: FleetLaunchRequest): Promise<FleetRecord> {
		if (this.#disposed) throw new Error("Fleet supervisor is disposed");
		const id = `f-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		const title = request.title?.trim() || oneLineLabel(request.prompt);

		let worktree: FleetRecord["worktree"];
		let cwd = this.#deps.repoRoot;
		if (request.worktree !== false && this.#deps.gitAvailable) {
			const info = await createSessionWorktree({ repoRoot: this.#deps.repoRoot, name: title });
			worktree = { path: info.path, branch: info.branch };
			cwd = info.path;
		}

		const handle = await this.#deps.factory({ cwd, model: request.model, thinkingLevel: request.thinkingLevel });
		const record = this.#adopt({ id, title, handle, cwd, worktree });

		const sessionFile = handle.session.sessionManager.getSessionFile();
		if (worktree && sessionFile) {
			bindSessionWorktree(worktree.path, sessionFile).catch(err => {
				logger.warn("Fleet: failed to bind worktree marker", { worktree: worktree.path, err: String(err) });
			});
		}
		await this.#upsertIndex(record);

		const runtime = this.#runtimes.get(id);
		if (runtime) {
			runtime.launched = true;
			runtime.promptSettled = false;
			handle.session
				.prompt(request.prompt)
				.then(() => {
					runtime.promptSettled = true;
					record.endedAt = Date.now();
				})
				.catch((err: unknown) => {
					runtime.promptSettled = true;
					record.endedAt = Date.now();
					record.error = err instanceof Error ? err.message : String(err);
					logger.warn("Fleet session prompt failed", { id, err: String(err) });
				})
				.finally(() => this.#refresh(id));
		}
		return record;
	}

	/** Revive a dead index entry into a live supervised session. */
	async resume(entry: FleetIndexEntry): Promise<FleetRecord> {
		if (this.#disposed) throw new Error("Fleet supervisor is disposed");
		const existing = this.#runtimes.get(entry.id);
		if (existing) return existing.record;
		const handle = await this.#deps.factory({ cwd: entry.cwd, resumeSessionFile: entry.sessionFile });
		const record = this.#adopt({
			id: entry.id,
			title: entry.title ?? entry.id,
			handle,
			cwd: handle.session.sessionManager.getCwd(),
			worktree: entry.worktree,
			createdAt: Date.parse(entry.createdAt) || Date.now(),
		});
		// Resumed sessions have no supervisor-launched prompt: idle until used.
		await this.#upsertIndex(record);
		this.#refresh(entry.id);
		// Restore + re-kick the persisted subagent tree in the background; the
		// factory bound this only for resumed sessions with auto-resume enabled.
		if (handle.resumeSubagents) {
			handle
				.resumeSubagents()
				.then(result => {
					if (result.continued.length > 0) this.#refresh(entry.id);
				})
				.catch((err: unknown) => {
					logger.warn("Fleet subagent auto-resume failed", { id: entry.id, err: String(err) });
				});
		}
		return record;
	}

	/** Abort + dispose a live session. Its index entry (and worktree) survive for later resume. */
	async stop(id: string): Promise<void> {
		const runtime = this.#runtimes.get(id);
		if (!runtime) return;
		this.#runtimes.delete(id);
		this.#bridge.leave(`peer/${id}`);
		this.#gate.release(id);
		runtime.unsubscribeRunState();
		try {
			await runtime.handle.session.dispose();
		} catch (err) {
			logger.warn("Fleet session dispose failed", { id, err: String(err) });
		}
		try {
			await runtime.handle.dispose?.();
		} catch (err) {
			logger.warn("Fleet handle dispose failed", { id, err: String(err) });
		}
		this.#emit();
	}

	/** Drop a dead entry from the durable index (worktree + JSONL stay on disk). */
	async removeArchived(id: string): Promise<void> {
		if (this.#runtimes.has(id)) throw new Error("Session is live; stop it first");
		await this.#deps.index.remove(id);
		this.#emit();
	}

	async disposeAll(): Promise<void> {
		this.#disposed = true;
		const ids = [...this.#runtimes.keys()];
		for (const id of ids) {
			await this.stop(id);
		}
		this.#bridge.dispose();
	}

	#adopt(args: {
		id: string;
		title: string;
		handle: FleetSessionHandle;
		cwd: string;
		worktree?: FleetRecord["worktree"];
		createdAt?: number;
	}): FleetRecord {
		const { id, handle } = args;
		const record: FleetRecord = {
			id,
			title: args.title,
			status: "idle",
			session: handle.session,
			cwd: args.cwd,
			worktree: args.worktree,
			modelSelector: handle.session.model
				? `${handle.session.model.provider}/${handle.session.model.id}`
				: undefined,
			createdAt: args.createdAt ?? Date.now(),
			lastActivity: Date.now(),
		};
		const runtime: FleetRuntime = {
			record,
			handle,
			pendingDialogs: 0,
			launched: false,
			promptSettled: true,
			unsubscribeRunState: handle.session.subscribeRunState(() => this.#refresh(id)),
		};
		this.#runtimes.set(id, runtime);
		handle.setToolUIContext(this.#gate.createUiContext(id), true);
		if (handle.agentRegistry) {
			this.#bridge.join({
				peerId: `peer/${id}`,
				displayName: record.title,
				registry: handle.agentRegistry,
				sessionFile: handle.session.sessionManager.getSessionFile(),
			});
		}
		this.#refresh(id);
		return record;
	}

	#onDialogPending(id: string, pending: number): void {
		const runtime = this.#runtimes.get(id);
		if (!runtime) return;
		runtime.pendingDialogs = pending;
		this.#refresh(id);
	}

	#refresh(id: string): void {
		const runtime = this.#runtimes.get(id);
		if (!runtime) return;
		const { record, handle } = runtime;
		record.lastActivity = Date.now();
		// Adopt the generated session title once available.
		const generated = handle.session.sessionName;
		if (generated && generated !== record.title) {
			record.title = generated;
			void this.#upsertIndex(record);
		}
		record.modelSelector = handle.session.model
			? `${handle.session.model.provider}/${handle.session.model.id}`
			: record.modelSelector;
		if (runtime.pendingDialogs > 0) record.status = "waiting";
		else if (handle.session.isStreaming) {
			record.status = "running";
			record.error = undefined;
		} else if (record.error) record.status = "error";
		else record.status = runtime.launched && runtime.promptSettled ? "done" : "idle";
		this.#bridge.syncStatus(`peer/${id}`, handle.session.isStreaming ? "running" : "idle");
		this.#bridge.syncDisplayName(`peer/${id}`, record.title);
		this.#emit();
	}

	async #upsertIndex(record: FleetRecord): Promise<void> {
		const sessionFile = record.session.sessionManager.getSessionFile();
		if (!sessionFile) return;
		try {
			await this.#deps.index.upsert({
				id: record.id,
				title: record.title,
				sessionFile,
				cwd: record.cwd,
				worktree: record.worktree,
				model: record.modelSelector,
				createdAt: new Date(record.createdAt).toISOString(),
				updatedAt: new Date().toISOString(),
			});
		} catch (err) {
			logger.warn("Fleet index update failed", { id: record.id, err: String(err) });
		}
	}

	#emit(): void {
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch (err) {
				logger.warn("Fleet listener failed", { err: String(err) });
			}
		}
	}
}
