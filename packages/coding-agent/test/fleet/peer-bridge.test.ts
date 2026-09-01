import { describe, expect, it } from "bun:test";
import { FleetPeerBridge } from "@oh-my-pi/pi-coding-agent/fleet/peer-bridge";
import { IrcBus, type IrcMessage } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

/**
 * Contract tests for cross-session peer messaging. Each participant is Main
 * of its own private registry; the bridge mirrors siblings as `peer/<id>`
 * refs. Defended failure modes: siblings invisible to `hub list`, a
 * mis-rewritten `from` that breaks reply routing (or self-addresses as
 * "Main"), messages leaking to the wrong world, and unbounded
 * agent-to-agent wake loops.
 */

interface World {
	registry: AgentRegistry;
	received: IrcMessage[];
}

function makeWorld(): World {
	const registry = new AgentRegistry();
	const received: IrcMessage[] = [];
	const main = {
		get isStreaming() {
			return false;
		},
		deliverIrcMessage(message: IrcMessage) {
			received.push(message);
			return Promise.resolve("injected" as const);
		},
	};
	registry.register({
		id: "Main",
		displayName: "main",
		kind: "main",
		session: main as unknown as AgentSession,
		status: "idle",
	});
	return { registry, received };
}

describe("fleet peer bridge", () => {
	it("mirrors joined participants into each other's rosters as messageable peers", () => {
		const a = makeWorld();
		const b = makeWorld();
		const bridge = new FleetPeerBridge();
		bridge.join({ peerId: "peer/a", displayName: "session A", registry: a.registry, sessionFile: "/tmp/a.jsonl" });
		bridge.join({ peerId: "peer/b", displayName: "session B", registry: b.registry });

		const mirrorInA = a.registry.get("peer/b");
		expect(mirrorInA?.displayName).toBe("session B");
		expect(b.registry.get("peer/a")?.sessionFile).toBe("/tmp/a.jsonl");
		// Visible to the model's `hub list` (running/idle, non-advisor).
		expect(a.registry.listVisibleTo("Main").map(ref => ref.id)).toContain("peer/b");
		// Own mirror never lands in one's own world.
		expect(a.registry.get("peer/a")).toBeUndefined();
	});

	it("routes a send to a peer into the peer's own bus with from rewritten for replies", async () => {
		const a = makeWorld();
		const b = makeWorld();
		const bridge = new FleetPeerBridge();
		bridge.join({ peerId: "peer/a", displayName: "A", registry: a.registry });
		bridge.join({ peerId: "peer/b", displayName: "B", registry: b.registry });

		const receipt = await IrcBus.forRegistry(a.registry).send({
			from: "Main",
			to: "peer/b",
			body: "I need port 5173 — can you pause your dev server?",
		});
		expect(receipt.outcome).toBe("injected");
		expect(b.received).toHaveLength(1);
		expect(b.received[0]?.to).toBe("Main");
		expect(b.received[0]?.from).toBe("peer/a");
		expect(b.received[0]?.body).toBe("I need port 5173 — can you pause your dev server?");
		expect(a.received).toHaveLength(0);

		// The rewritten `from` is directly replyable in B's world.
		const reply = await IrcBus.forRegistry(b.registry).send({
			from: "Main",
			to: "peer/a",
			body: "Paused. All yours.",
		});
		expect(reply.outcome).toBe("injected");
		expect(a.received[0]?.from).toBe("peer/b");
	});

	it("attributes a subagent sender in the body while collapsing from to the session peer id", async () => {
		const a = makeWorld();
		const b = makeWorld();
		const bridge = new FleetPeerBridge();
		bridge.join({ peerId: "peer/a", displayName: "A", registry: a.registry });
		bridge.join({ peerId: "peer/b", displayName: "B", registry: b.registry });

		await IrcBus.forRegistry(a.registry).send({ from: "WebScout", to: "peer/b", body: "port taken" });
		expect(b.received[0]?.from).toBe("peer/a");
		expect(b.received[0]?.body).toBe("[from subagent WebScout] port taken");
	});

	it("leave removes the mirrors from both sides and later sends fail cleanly", async () => {
		const a = makeWorld();
		const b = makeWorld();
		const bridge = new FleetPeerBridge();
		bridge.join({ peerId: "peer/a", displayName: "A", registry: a.registry });
		bridge.join({ peerId: "peer/b", displayName: "B", registry: b.registry });
		bridge.leave("peer/b");

		expect(a.registry.get("peer/b")).toBeUndefined();
		expect(b.registry.get("peer/a")).toBeUndefined();
		const receipt = await IrcBus.forRegistry(a.registry).send({ from: "Main", to: "peer/b", body: "hello?" });
		expect(receipt.outcome).toBe("failed");
	});

	it("syncStatus updates the mirror rows siblings see", () => {
		const a = makeWorld();
		const b = makeWorld();
		const bridge = new FleetPeerBridge();
		bridge.join({ peerId: "peer/a", displayName: "A", registry: a.registry });
		bridge.join({ peerId: "peer/b", displayName: "B", registry: b.registry });

		bridge.syncStatus("peer/b", "running");
		expect(a.registry.get("peer/b")?.status).toBe("running");
		bridge.syncStatus("peer/b", "idle");
		expect(a.registry.get("peer/b")?.status).toBe("idle");
	});

	it("caps runaway agent-to-agent messaging with the directed-pair wake budget", async () => {
		const a = makeWorld();
		const b = makeWorld();
		const bridge = new FleetPeerBridge();
		bridge.join({ peerId: "peer/a", displayName: "A", registry: a.registry });
		bridge.join({ peerId: "peer/b", displayName: "B", registry: b.registry });

		const bus = IrcBus.forRegistry(a.registry);
		for (let i = 0; i < 30; i++) {
			const receipt = await bus.send({ from: "Main", to: "peer/b", body: `m${i}` });
			expect(receipt.outcome).toBe("injected");
		}
		const overflow = await bus.send({ from: "Main", to: "peer/b", body: "one too many" });
		expect(overflow.outcome).toBe("failed");
		expect(overflow.error).toContain("budget");
		// The reverse direction has its own budget and still flows.
		const reverse = await IrcBus.forRegistry(b.registry).send({ from: "Main", to: "peer/a", body: "ok" });
		expect(reverse.outcome).toBe("injected");
	});
});
