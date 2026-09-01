/**
 * FleetPeerBridge - sibling awareness and messaging between the top-level
 * sessions of one omp process.
 *
 * Each fleet session stays `Main` of its own private AgentRegistry (the
 * #10229/#10230 isolation), but every participant is mirrored into every
 * other participant's registry as a `peer/<id>` ref whose attached "session"
 * is a thin routing proxy. `IrcBus.send` delivers through
 * `ref.session.deliverIrcMessage`, so a `hub send to:"peer/<id>"` from any
 * session re-enters the target's OWN bus addressed to its `Main` — mailbox,
 * idle-wake, and steer semantics all come for free — with `from` rewritten to
 * the sender's peer id so replies route back symmetrically.
 *
 * A sliding-window wake budget per directed pair caps runaway agent-to-agent
 * ping-pong (the mutual-wake risk upstream #7537 explicitly defers): beyond
 * the cap a send fails fast with guidance instead of burning turns.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { IrcBus, type IrcMessage } from "../irc/bus";
import { type AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";

/** Directed-pair wake budget: at most N proxy deliveries per window. */
const WAKE_BUDGET_WINDOW_MS = 10 * 60 * 1000;
const WAKE_BUDGET_MAX = 30;

export interface FleetPeerParticipant {
	/** Stable id under which the OTHER sessions address this one (e.g. `peer/main`, `peer/f-abc`). */
	peerId: string;
	/** Roster display name (session title). */
	displayName: string;
	/** This participant's own registry — the world it is `Main` of. */
	registry: AgentRegistry;
	/** Session JSONL, so `history://peer/<id>` resolves from any sibling. */
	sessionFile?: string;
}

export class FleetPeerBridge {
	#participants = new Map<string, FleetPeerParticipant>();
	/** Directed-pair delivery timestamps for the wake budget. */
	#deliveries = new Map<string, number[]>();
	#disposed = false;

	/** Mirror `participant` into every existing sibling's registry, and vice versa. */
	join(participant: FleetPeerParticipant): void {
		if (this.#disposed || this.#participants.has(participant.peerId)) return;
		for (const sibling of this.#participants.values()) {
			this.#registerMirror(sibling, participant);
			this.#registerMirror(participant, sibling);
		}
		this.#participants.set(participant.peerId, participant);
	}

	/** Remove a participant's mirrors everywhere (session stopped/disposed). */
	leave(peerId: string): void {
		const participant = this.#participants.get(peerId);
		if (!participant) return;
		this.#participants.delete(peerId);
		for (const sibling of this.#participants.values()) {
			sibling.registry.unregister(peerId);
			participant.registry.unregister(sibling.peerId);
		}
	}

	/** Push a participant's run state onto its mirrors so sibling rosters stay truthful. */
	syncStatus(peerId: string, status: "running" | "idle"): void {
		if (!this.#participants.has(peerId)) return;
		for (const sibling of this.#participants.values()) {
			if (sibling.peerId === peerId) continue;
			sibling.registry.setStatus(peerId, status);
		}
	}

	/** Refresh a participant's roster display name (session titles arrive late). */
	syncDisplayName(peerId: string, displayName: string): void {
		const participant = this.#participants.get(peerId);
		if (!participant || participant.displayName === displayName) return;
		participant.displayName = displayName;
		for (const sibling of this.#participants.values()) {
			if (sibling.peerId === peerId) continue;
			// Re-register in place: register() replaces the ref while keeping id.
			const existing = sibling.registry.get(peerId);
			if (!existing) continue;
			sibling.registry.register({
				id: peerId,
				displayName,
				kind: "sub",
				session: existing.session,
				sessionFile: existing.sessionFile,
				status: existing.status,
				createdAt: existing.createdAt,
				lastActivity: existing.lastActivity,
			});
		}
	}

	dispose(): void {
		this.#disposed = true;
		for (const participant of [...this.#participants.values()]) {
			this.leave(participant.peerId);
		}
	}

	/** Register a mirror of `peer` inside `worldOwner`'s registry. */
	#registerMirror(worldOwner: FleetPeerParticipant, peer: FleetPeerParticipant): void {
		worldOwner.registry.register({
			id: peer.peerId,
			displayName: peer.displayName,
			kind: "sub",
			session: this.#createRoutingProxy(worldOwner, peer),
			sessionFile: peer.sessionFile ?? null,
			status: peer.registry.get(MAIN_AGENT_ID)?.session?.isStreaming ? "running" : "idle",
		});
	}

	/**
	 * The mirror ref's "session": resolves the peer's live Main lazily (so the
	 * peer surviving a `/new` or session switch keeps routing) and forwards
	 * deliveries into the peer's own bus with `from` rewritten to the sender's
	 * peer id. Only the two members `IrcBus` touches are real
	 * (`deliverIrcMessage`, `isStreaming`); the cast documents that contract.
	 */
	#createRoutingProxy(worldOwner: FleetPeerParticipant, peer: FleetPeerParticipant): AgentSession {
		const bridge = this;
		const proxy = {
			get isStreaming(): boolean {
				return peer.registry.get(MAIN_AGENT_ID)?.session?.isStreaming === true;
			},
			async deliverIrcMessage(
				message: IrcMessage,
				opts?: { expectsReply?: boolean },
			): Promise<"injected" | "woken"> {
				bridge.#consumeWakeBudget(worldOwner.peerId, peer.peerId);
				// Sub-sender attribution collapses to the sending session's peer id;
				// keep the original sender readable in the body when it wasn't Main.
				const body =
					message.from === MAIN_AGENT_ID ? message.body : `[from subagent ${message.from}] ${message.body}`;
				const receipt = await IrcBus.forRegistry(peer.registry).send(
					{ from: worldOwner.peerId, to: MAIN_AGENT_ID, body, replyTo: message.replyTo },
					opts,
				);
				if (receipt.outcome === "failed") {
					throw new Error(receipt.error ?? `Peer session ${peer.peerId} rejected the message`);
				}
				return receipt.outcome === "injected" ? "injected" : "woken";
			},
		};
		return proxy as unknown as AgentSession;
	}

	#consumeWakeBudget(fromPeerId: string, toPeerId: string): void {
		const key = `${fromPeerId}\u0000${toPeerId}`;
		const now = Date.now();
		const window = (this.#deliveries.get(key) ?? []).filter(ts => now - ts < WAKE_BUDGET_WINDOW_MS);
		if (window.length >= WAKE_BUDGET_MAX) {
			logger.warn("Fleet peer wake budget exhausted", { from: fromPeerId, to: toPeerId });
			throw new Error(
				`Peer message budget to ${toPeerId} is exhausted (${WAKE_BUDGET_MAX} per ${Math.round(WAKE_BUDGET_WINDOW_MS / 60000)}min). ` +
					"Coordinate through files or wait before messaging this session again.",
			);
		}
		window.push(now);
		this.#deliveries.set(key, window);
	}
}
