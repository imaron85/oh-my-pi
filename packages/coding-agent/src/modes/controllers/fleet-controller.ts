/**
 * FleetController - bridges the fleet supervisor into the interactive TUI.
 *
 * Owns lazy supervisor construction (repo root + durable index + UI gate),
 * the overview overlay, the Ctrl+P "model for the next task" pick, the
 * new-task launch flow, and focus bridging: entering a fleet session routes
 * through `SessionFocusController.focusExternalSession`, and every focus
 * change is forwarded to the UI gate so queued dialogs of the focused
 * session are presented.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { FleetIndexEntry } from "../../fleet/fleet-index";
import { FleetIndex } from "../../fleet/fleet-index";
import { FleetSupervisor } from "../../fleet/supervisor";
import type { FleetSessionFactory } from "../../fleet/types";
import { getRepoRoot } from "../../task/worktree";
import type { InteractiveModeContext } from "../types";

export class FleetController {
	#ctx: InteractiveModeContext;
	#factory: FleetSessionFactory | undefined;
	#supervisor: FleetSupervisor | undefined;
	#supervisorPromise: Promise<FleetSupervisor> | undefined;
	/** Model applied to the NEXT launched task only; never touches running sessions. */
	nextTaskModel: Model | undefined;
	#focusedFleetId: string | undefined;
	#supervisorUnsubscribe: (() => void) | undefined;
	/** Re-open the overview after unfocusing a fleet session (Claude-Code back gesture). */
	#reopenOverlayOnUnfocus = false;

	constructor(ctx: InteractiveModeContext, factory: FleetSessionFactory | undefined) {
		this.#ctx = ctx;
		this.#factory = factory;
	}

	get available(): boolean {
		return this.#factory !== undefined && !this.#ctx.collabGuest;
	}

	get supervisor(): FleetSupervisor | undefined {
		return this.#supervisor;
	}

	/** Wired to SessionFocusController.onFocusChanged by InteractiveMode. */
	onViewFocusChanged(id: string | undefined): void {
		const previous = this.#focusedFleetId;
		this.#focusedFleetId = id && this.#supervisor?.get(id) ? id : undefined;
		this.#supervisor?.setFocused(this.#focusedFleetId ?? null);
		if (previous && !this.#focusedFleetId && this.#reopenOverlayOnUnfocus) {
			this.#ctx.showFleetOverlay?.();
		}
	}

	async ensureSupervisor(): Promise<FleetSupervisor> {
		if (this.#supervisor) return this.#supervisor;
		if (!this.#factory) throw new Error("Fleet hosting is unavailable in this launch mode");
		this.#supervisorPromise ??= this.#buildSupervisor(this.#factory);
		return this.#supervisorPromise;
	}

	async #buildSupervisor(factory: FleetSessionFactory): Promise<FleetSupervisor> {
		const cwd = this.#ctx.sessionManager.getCwd();
		let repoRoot = cwd;
		let gitAvailable = true;
		try {
			repoRoot = await getRepoRoot(cwd);
		} catch {
			gitAvailable = false;
		}
		const index = await FleetIndex.load(repoRoot);
		await index.prune();
		const supervisor = new FleetSupervisor({
			factory,
			repoRoot,
			gitAvailable,
			index,
			getUi: () => this.#ctx.getToolUIContext?.(),
		});
		this.#supervisorUnsubscribe = supervisor.onChange(() => {
			// Focused fleet session died/was stopped: fall back to the overview.
			if (this.#focusedFleetId && !supervisor.get(this.#focusedFleetId)) {
				void this.#ctx.unfocusSession();
			}
		});
		this.#supervisor = supervisor;
		return supervisor;
	}

	/** Launch a new task (worktree + session + prompt); returns its record id. */
	async launchTask(prompt: string): Promise<string> {
		const supervisor = await this.ensureSupervisor();
		const record = await supervisor.launch({ prompt, model: this.nextTaskModel });
		return record.id;
	}

	async focusRecord(id: string): Promise<void> {
		const supervisor = await this.ensureSupervisor();
		const record = supervisor.get(id);
		if (!record) throw new Error(`Fleet session ${id} is not live`);
		this.#reopenOverlayOnUnfocus = true;
		await this.#ctx.focusExternalSession?.(id, record.session);
	}

	async resumeArchived(entry: FleetIndexEntry): Promise<string> {
		const supervisor = await this.ensureSupervisor();
		const record = await supervisor.resume(entry);
		return record.id;
	}

	async stopRecord(id: string): Promise<void> {
		if (this.#focusedFleetId === id) await this.#ctx.unfocusSession();
		await this.#supervisor?.stop(id);
	}

	async dispose(): Promise<void> {
		this.#supervisorUnsubscribe?.();
		this.#supervisorUnsubscribe = undefined;
		const supervisor = this.#supervisor;
		this.#supervisor = undefined;
		this.#supervisorPromise = undefined;
		if (supervisor) {
			try {
				await supervisor.disposeAll();
			} catch (err) {
				logger.warn("Fleet supervisor dispose failed", { err: String(err) });
			}
		}
	}
}
