/**
 * Subagent auto-resume: when an interrupted session is resumed, restore its
 * persisted subagent tree (recursively — children, grandchildren, …) as
 * parked registry refs, then revive and re-kick every subagent whose
 * transcript was cut off mid-run so it continues from where it left off and
 * yields.
 *
 * "Cut off mid-run" is judged from the transcript tail (`interrupted`: an
 * in-flight assistant turn died with the process; `pending`: a prompt was
 * submitted but never answered). Completed, aborted (tombstoned), errored,
 * and advisor transcripts are left parked. In-flight provider streams cannot
 * be resurrected — the continue prompt tells the agent its aborted tool calls
 * did not run and to verify state before redoing work.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import type { AgentRef, AgentRegistry } from "../registry/agent-registry";
import { registerPersistedSubagents } from "../registry/persisted-agents";
import type { AgentSession } from "../session/agent-session";
import type { AuthStorage } from "../session/auth-storage";
import { readSessionFileStatus, type SessionStatus } from "../session/session-listing";
import { createPersistedSubagentReviverFactory } from "../task/persisted-revive";
import type { EventBus } from "../utils/event-bus";
import resumePrompt from "./resume-subagent-prompt.md" with { type: "text" };

export interface ResumeInterruptedSubagentsContext {
	/** The resumed parent session (live). */
	session: AgentSession;
	/** The registry owning the parent session's agent tree. */
	registry: AgentRegistry;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settings: Settings;
	enableLsp?: boolean;
	eventBus?: EventBus;
	subagentEventBus?: EventBus;
	/**
	 * Skip installing the persisted-subagent reviver factory (the interactive
	 * bootstrap already installs one on the global lifecycle manager).
	 */
	installReviver?: boolean;
}

export interface ResumeInterruptedSubagentsResult {
	/** Parked subagent refs visible after the roster scan. */
	restored: number;
	/** Ids revived and re-kicked with a continue prompt. */
	continued: string[];
}

/** A parked, revivable subagent transcript (not advisor, not tombstoned). */
function isRevivableSubagentRef(ref: AgentRef): boolean {
	return ref.kind === "sub" && ref.status === "parked" && typeof ref.sessionFile === "string";
}

/** Transcript tail states that mean "the process died mid-run". */
const CONTINUE_STATUSES: Record<SessionStatus, boolean> = {
	interrupted: true,
	pending: true,
	complete: false,
	aborted: false,
	error: false,
	unknown: false,
};

export async function resumeInterruptedSubagents(
	ctx: ResumeInterruptedSubagentsContext,
): Promise<ResumeInterruptedSubagentsResult> {
	const sessionFile = ctx.session.sessionManager.getSessionFile();
	if (!sessionFile) return { restored: 0, continued: [] };

	const lifecycle = AgentLifecycleManager.forRegistry(ctx.registry);
	if (ctx.installReviver !== false) {
		lifecycle.setPersistedSubagentReviverFactory(
			createPersistedSubagentReviverFactory({
				session: ctx.session,
				authStorage: ctx.authStorage,
				modelRegistry: ctx.modelRegistry,
				settings: ctx.settings,
				enableLsp: ctx.enableLsp ?? true,
				eventBus: ctx.eventBus,
				subagentEventBus: ctx.subagentEventBus,
				registry: ctx.registry,
			}),
			Math.trunc(Number(ctx.settings.get("task.agentIdleTtlMs") ?? 420_000) || 0),
		);
	}

	await registerPersistedSubagents(ctx.registry, sessionFile);

	const parked = ctx.registry.list().filter(isRevivableSubagentRef);
	const continued: string[] = [];
	for (const ref of parked) {
		const file = ref.sessionFile;
		if (!file) continue;
		const status = await readSessionFileStatus(file);
		if (!CONTINUE_STATUSES[status]) continue;
		try {
			const revived = await lifecycle.ensureLive(ref.id);
			// Fire the continue turn without awaiting completion: each child runs
			// to its own yield; results land as output artifacts and IRC replies.
			revived.prompt(resumePrompt, { synthetic: true }).catch((err: unknown) => {
				logger.warn("Auto-resumed subagent continue prompt failed", { id: ref.id, err: String(err) });
			});
			continued.push(ref.id);
		} catch (err) {
			logger.warn("Failed to auto-resume subagent", { id: ref.id, err: String(err) });
		}
	}
	if (continued.length > 0) {
		logger.info("Auto-resumed interrupted subagents", { sessionFile, continued });
	}
	return { restored: parked.length, continued };
}
