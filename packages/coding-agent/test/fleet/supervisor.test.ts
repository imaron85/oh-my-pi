import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { FleetIndex } from "@oh-my-pi/pi-coding-agent/fleet/fleet-index";
import { FleetSupervisor } from "@oh-my-pi/pi-coding-agent/fleet/supervisor";
import type { FleetSessionFactory, FleetSessionHandle } from "@oh-my-pi/pi-coding-agent/fleet/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { __resetDirsFromEnvForTests, setAgentDir } from "@oh-my-pi/pi-utils";

/**
 * Contract tests for the fleet supervisor's observable status machine and its
 * durable-index mirroring, driven through the stub-factory DI seam. Failure
 * modes defended: a launch that never lands in the durable index (crash
 * recovery would lose the session), roster rows lying about
 * running/waiting/done/error, and stop() destroying the resumable entry.
 */

interface StubSession {
	session: AgentSession;
	settlePrompt: (outcome?: Error) => void;
	disposed: () => boolean;
	promptedWith: () => string | undefined;
}

function makeStubSession(sessionFile: string, cwd: string): StubSession {
	const runStateListeners = new Set<(state: "running" | "idle") => void>();
	let streaming = false;
	let disposed = false;
	let promptText: string | undefined;
	let settle: ((err?: Error) => void) | undefined;
	const stub = {
		sessionManager: {
			getSessionFile: () => sessionFile,
			getCwd: () => cwd,
		},
		model: { provider: "test", id: "stub-model" },
		get sessionName() {
			return undefined;
		},
		get isStreaming() {
			return streaming;
		},
		subscribeRunState(listener: (state: "running" | "idle") => void) {
			runStateListeners.add(listener);
			return () => runStateListeners.delete(listener);
		},
		prompt(text: string) {
			promptText = text;
			streaming = true;
			for (const listener of runStateListeners) listener("running");
			const { promise, resolve, reject } = Promise.withResolvers<boolean>();
			settle = (err?: Error) => {
				streaming = false;
				for (const listener of runStateListeners) listener("idle");
				if (err) reject(err);
				else resolve(true);
			};
			return promise;
		},
		dispose() {
			disposed = true;
			return Promise.resolve();
		},
	};
	return {
		session: stub as unknown as AgentSession,
		settlePrompt: outcome => settle?.(outcome),
		disposed: () => disposed,
		promptedWith: () => promptText,
	};
}

/** Resolves once the record's status matches (checks current state first). */
async function untilStatus(supervisor: FleetSupervisor, id: string, status: string): Promise<void> {
	if (supervisor.get(id)?.status === status) return;
	const { promise, resolve } = Promise.withResolvers<void>();
	const unsubscribe = supervisor.onChange(() => {
		if (supervisor.get(id)?.status === status) resolve();
	});
	try {
		await promise;
	} finally {
		unsubscribe();
	}
}

describe("fleet supervisor", () => {
	let agentDir: string;
	let repoRoot: string;
	let stubs: StubSession[];
	let uiContexts: ExtensionUIContext[];
	let factory: FleetSessionFactory;
	let realUi: ExtensionUIContext;

	beforeEach(async () => {
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fleet-sup-agent-"));
		repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fleet-sup-repo-"));
		setAgentDir(agentDir);
		stubs = [];
		uiContexts = [];
		realUi = { confirm: () => Promise.resolve(true) } as unknown as ExtensionUIContext;
		factory = ({ cwd }) => {
			const stub = makeStubSession(path.join(agentDir, `s${stubs.length}.jsonl`), cwd);
			stubs.push(stub);
			const handle: FleetSessionHandle = {
				session: stub.session,
				setToolUIContext: uiContext => {
					uiContexts.push(uiContext as ExtensionUIContext);
				},
			};
			return Promise.resolve(handle);
		};
	});

	afterEach(async () => {
		__resetDirsFromEnvForTests();
		await fs.rm(agentDir, { recursive: true, force: true });
		await fs.rm(repoRoot, { recursive: true, force: true });
	});

	async function makeSupervisor(): Promise<FleetSupervisor> {
		const index = await FleetIndex.load(repoRoot);
		return new FleetSupervisor({
			factory,
			repoRoot,
			gitAvailable: false,
			index,
			getUi: () => realUi,
		});
	}

	it("launch fires the prompt, mirrors the index, and tracks running → done", async () => {
		const supervisor = await makeSupervisor();
		const record = await supervisor.launch({ prompt: "fix the auth bug in the login flow" });

		expect(stubs[0]?.promptedWith()).toBe("fix the auth bug in the login flow");
		expect(record.status).toBe("running");
		expect(record.title).toBe("fix the auth bug in the login flow");
		expect(record.cwd).toBe(repoRoot);

		// Crash-recovery contract: the durable index already knows this session.
		const reloaded = await FleetIndex.load(repoRoot);
		expect(reloaded.get(record.id)?.sessionFile).toBe(stubs[0]?.session.sessionManager.getSessionFile());
		expect(reloaded.get(record.id)?.cwd).toBe(repoRoot);

		stubs[0]?.settlePrompt();
		await untilStatus(supervisor, record.id, "done");
		expect(supervisor.get(record.id)?.status).toBe("done");
	});

	it("a rejected launch prompt surfaces as error status with the message", async () => {
		const supervisor = await makeSupervisor();
		const record = await supervisor.launch({ prompt: "doomed task" });
		stubs[0]?.settlePrompt(new Error("provider exploded"));
		await untilStatus(supervisor, record.id, "error");
		const after = supervisor.get(record.id);
		expect(after?.status).toBe("error");
		expect(after?.error).toBe("provider exploded");
	});

	it("a queued dialog marks the row waiting; focusing delivers it and clears the state", async () => {
		const supervisor = await makeSupervisor();
		const record = await supervisor.launch({ prompt: "interactive task" });
		const proxy = uiContexts[0];
		expect(proxy).toBeDefined();

		// Unfocused session asks a question → queued, the row flips to waiting
		// synchronously with the queued dialog.
		const confirmed = proxy!.confirm("Deploy?", "Ship it to prod?");
		expect(supervisor.get(record.id)?.status).toBe("waiting");

		// Focusing the session wakes the queued dialog against the real UI.
		supervisor.setFocused(record.id);
		expect(await confirmed).toBe(true);
		// Delivered dialog leaves the queue → row returns to running.
		await untilStatus(supervisor, record.id, "running");
		expect(supervisor.get(record.id)?.status).toBe("running");
	});

	it("stop disposes the live session but keeps the archived entry resumable", async () => {
		const supervisor = await makeSupervisor();
		const record = await supervisor.launch({ prompt: "long running refactor" });
		await supervisor.stop(record.id);

		expect(stubs[0]?.disposed()).toBe(true);
		expect(supervisor.get(record.id)).toBeUndefined();
		const archived = supervisor.archivedEntries();
		expect(archived.map(entry => entry.id)).toContain(record.id);

		// Resume revives the archived entry through the factory (idle, no prompt).
		const entry = archived.find(item => item.id === record.id);
		expect(entry).toBeDefined();
		const revived = await supervisor.resume(entry!);
		expect(revived.id).toBe(record.id);
		expect(revived.status).toBe("idle");
		expect(stubs[1]?.promptedWith()).toBeUndefined();
	});

	it("removeArchived refuses live sessions and drops dead entries", async () => {
		const supervisor = await makeSupervisor();
		const record = await supervisor.launch({ prompt: "short task" });
		expect(supervisor.removeArchived(record.id)).rejects.toThrow("live");
		await supervisor.stop(record.id);
		await supervisor.removeArchived(record.id);
		expect(supervisor.archivedEntries()).toEqual([]);
	});
});
