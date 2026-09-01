/**
 * Fleet: Claude-Code-style multi-session hosting inside one omp process.
 *
 * One interactive TUI process supervises N resident top-level AgentSessions
 * (each with a private AgentRegistry per `omp://sdk.md`), an overview overlay
 * lists them, and the focus controller retargets the single interactive
 * surface onto whichever session the user enters.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import type { AgentSession } from "../session/agent-session";
import type { ConfiguredThinkingLevel } from "../thinking";
import type { ResumeInterruptedSubagentsResult } from "./resume-subagents";

/**
 * - `running`: a turn is in flight.
 * - `waiting`: a tool/approval dialog is pending user attention (focus to answer).
 * - `idle`: live, no turn in flight, last launched prompt not yet settled (turn boundary).
 * - `done`: last launched prompt settled successfully; session stays live for follow-ups.
 * - `error`: last launched prompt rejected; message in {@link FleetRecord.error}.
 */
export type FleetSessionStatus = "running" | "waiting" | "idle" | "done" | "error";

export interface FleetLaunchRequest {
	prompt: string;
	/** Display title; defaults to a prompt-derived stub until session titling lands. */
	title?: string;
	/** Model for THIS session only (the overview's Ctrl+P role cycle / Alt+P pick). */
	model?: Model;
	/** Thinking level carried by the picked role, when the model came from the role cycle. */
	thinkingLevel?: ConfiguredThinkingLevel;
	/** Create a dedicated git worktree (default: true inside a git repo). */
	worktree?: boolean;
}

export interface FleetSessionHandle {
	session: AgentSession;
	setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
	/** Release factory-owned resources beyond `session.dispose()` (e.g. MCP manager). */
	dispose?: () => Promise<void>;
	/**
	 * Bound by the factory on resumed sessions when `task.autoResumeSubagents`
	 * is on: restores the persisted subagent tree and re-kicks every subagent
	 * cut off mid-run (see fleet/resume-subagents.ts).
	 */
	resumeSubagents?: () => Promise<ResumeInterruptedSubagentsResult>;
}

/**
 * Builds one additional top-level session in this process. Mirrors the ACP
 * session-factory shape (`createAcpSessionFactory`): fresh SessionManager,
 * cwd-cloned settings, private AgentRegistry.
 */
export type FleetSessionFactory = (args: {
	cwd: string;
	model?: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
	/** Resume this session JSONL instead of creating a fresh session. */
	resumeSessionFile?: string;
}) => Promise<FleetSessionHandle>;

/** Live row of the fleet overview. */
export interface FleetRecord {
	id: string;
	title: string;
	status: FleetSessionStatus;
	session: AgentSession;
	cwd: string;
	worktree?: { path: string; branch: string };
	/** `provider/id` of the session's current model, for the roster badge. */
	modelSelector?: string;
	createdAt: number;
	endedAt?: number;
	lastActivity: number;
	error?: string;
}
