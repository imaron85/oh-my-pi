import { describe, expect, it } from "bun:test";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { FleetUiGate } from "@oh-my-pi/pi-coding-agent/fleet/ui-mux";

/**
 * Contract tests for the fleet UI gate: dialogs from unfocused sessions queue
 * (driving the waiting-input signal), aborts resolve to safe dialog defaults
 * instead of hanging tools, release() unblocks a killed session's queue, and
 * passive surface calls from unfocused sessions are inert. A regression here
 * either wedges a fleet session's tool forever or leaks another session's
 * dialog onto the focused surface.
 */

function makeRealUi(): { ui: ExtensionUIContext; calls: string[] } {
	const calls: string[] = [];
	const ui = {
		select: (title: string) => {
			calls.push(`select:${title}`);
			return Promise.resolve("picked");
		},
		confirm: (title: string) => {
			calls.push(`confirm:${title}`);
			return Promise.resolve(true);
		},
		input: () => Promise.resolve("typed"),
		notify: (message: string) => {
			calls.push(`notify:${message}`);
		},
		getToolsExpanded: () => true,
	} as unknown as ExtensionUIContext;
	return { ui, calls };
}

describe("fleet UI gate", () => {
	it("queues dialogs while unfocused and delivers them on focus, tracking pending counts", async () => {
		const { ui, calls } = makeRealUi();
		const pendingBySession: Record<string, number> = {};
		const gate = new FleetUiGate({
			getUi: () => ui,
			onPendingChange: (id, pending) => {
				pendingBySession[id] = pending;
			},
		});
		const proxy = gate.createUiContext("a");

		const picked = proxy.select("Choose", []);
		expect(pendingBySession.a).toBe(1);
		expect(calls).toEqual([]);

		gate.setFocused("a");
		expect(await picked).toBe("picked");
		expect(calls).toEqual(["select:Choose"]);
		expect(pendingBySession.a).toBe(0);
	});

	it("focused sessions pass dialogs straight through without queueing", async () => {
		const { ui, calls } = makeRealUi();
		const gate = new FleetUiGate({ getUi: () => ui, onPendingChange: () => {} });
		gate.setFocused("a");
		const proxy = gate.createUiContext("a");
		expect(await proxy.confirm("Now?", "yes")).toBe(true);
		expect(calls).toEqual(["confirm:Now?"]);
	});

	it("an aborted queued dialog resolves to the dialog's dismissal default", async () => {
		const { ui } = makeRealUi();
		const gate = new FleetUiGate({ getUi: () => ui, onPendingChange: () => {} });
		const proxy = gate.createUiContext("a");
		const controller = new AbortController();

		const confirmed = proxy.confirm("Deploy?", "prod", { signal: controller.signal });
		const selected = proxy.select("Pick", [], { signal: controller.signal });
		controller.abort();

		expect(await confirmed).toBe(false);
		expect(await selected).toBeUndefined();
	});

	it("release() resolves every queued dialog of a killed session to defaults", async () => {
		const { ui } = makeRealUi();
		const pendingBySession: Record<string, number> = {};
		const gate = new FleetUiGate({
			getUi: () => ui,
			onPendingChange: (id, pending) => {
				pendingBySession[id] = pending;
			},
		});
		const proxy = gate.createUiContext("a");
		const confirmed = proxy.confirm("Deploy?", "prod");
		expect(pendingBySession.a).toBe(1);

		gate.release("a", "session stopped");
		expect(await confirmed).toBe(false);
		expect(pendingBySession.a).toBe(0);
	});

	it("passive surface calls from an unfocused session are inert, not queued", () => {
		const { ui, calls } = makeRealUi();
		const gate = new FleetUiGate({ getUi: () => ui, onPendingChange: () => {} });
		gate.setFocused("b");
		const proxy = gate.createUiContext("a");

		proxy.notify("background noise");
		proxy.setStatus("k", "text");
		proxy.setTitle("nope");
		expect(proxy.getEditorText()).toBe("");
		expect(proxy.getToolsExpanded()).toBe(false);
		const unsubscribe = proxy.onTerminalInput(() => {});
		unsubscribe();

		expect(calls).toEqual([]);
	});

	it("advertises presentation-relative timeouts (dialogs may wait for focus indefinitely)", () => {
		const gate = new FleetUiGate({ getUi: () => undefined, onPendingChange: () => {} });
		expect(gate.createUiContext("a").timeoutStartsOnPresentation).toBe(true);
	});
});
