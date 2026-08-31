/**
 * FleetUiGate - one interactive UI, many sessions.
 *
 * Every fleet session receives an {@link ExtensionUIContext} proxy from this
 * gate. While the session is focused, calls delegate to the real interactive
 * UI context. While unfocused, dialog methods (ask/select/confirm/input/
 * editor/custom) queue until the user focuses the session — this pending
 * queue IS the "waiting for input" signal on the overview — and passive
 * surface methods (widgets, status, editor text) become safe no-ops.
 *
 * `timeoutStartsOnPresentation` is forced true: a dialog may sit queued for
 * minutes before the user focuses the session, so selector timeouts must not
 * start until it is actually presented.
 */

import type {
	ExtensionAskDialogQuestion,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionUISelectItem,
} from "../extensibility/extensions/types";
import type { Theme } from "../modes/theme/theme";

class FleetUiGateAbort extends Error {
	constructor(reason: string) {
		super(`Fleet UI request aborted: ${reason}`);
	}
}

interface GateWaiter {
	resolve: (ui: ExtensionUIContext) => void;
	reject: (err: Error) => void;
	cleanup: () => void;
}

export class FleetUiGate {
	#focusedId: string | null = null;
	#getUi: () => ExtensionUIContext | undefined;
	#onPendingChange: (id: string, pending: number) => void;
	#waiters = new Map<string, Set<GateWaiter>>();
	#pending = new Map<string, number>();

	constructor(deps: {
		/** The real interactive UI context (InteractiveMode.getToolUIContext). */
		getUi: () => ExtensionUIContext | undefined;
		/** Pending-dialog count changed for a session; >0 means "waiting for input". */
		onPendingChange: (id: string, pending: number) => void;
	}) {
		this.#getUi = deps.getUi;
		this.#onPendingChange = deps.onPendingChange;
	}

	get focusedId(): string | null {
		return this.#focusedId;
	}

	/** Called by the focus bridge whenever the viewed fleet session changes (null = main/overview). */
	setFocused(id: string | null): void {
		this.#focusedId = id;
		if (id === null) return;
		const waiters = this.#waiters.get(id);
		if (!waiters || waiters.size === 0) return;
		const ui = this.#getUi();
		if (!ui) return;
		for (const waiter of [...waiters]) {
			waiters.delete(waiter);
			waiter.cleanup();
			waiter.resolve(ui);
		}
	}

	/** Reject every queued dialog for a session (disposal/kill). */
	release(id: string, reason = "session closed"): void {
		const waiters = this.#waiters.get(id);
		if (waiters) {
			for (const waiter of [...waiters]) {
				waiters.delete(waiter);
				waiter.cleanup();
				waiter.reject(new FleetUiGateAbort(reason));
			}
			this.#waiters.delete(id);
		}
		if (this.#pending.get(id)) {
			this.#pending.delete(id);
			this.#onPendingChange(id, 0);
		}
	}

	/** Build the per-session UI proxy handed to `setToolUIContext`. */
	createUiContext(id: string): ExtensionUIContext {
		const gate = this;
		const focusedUi = (): ExtensionUIContext | undefined => (gate.#focusedId === id ? gate.#getUi() : undefined);

		const proxy: ExtensionUIContext = {
			timeoutStartsOnPresentation: true,
			async select(title: string, options: ExtensionUISelectItem[], dialogOptions?: ExtensionUIDialogOptions) {
				try {
					const ui = await gate.#acquire(id, dialogOptions?.signal);
					return await ui.select(title, options, dialogOptions);
				} catch (err) {
					if (err instanceof FleetUiGateAbort) return undefined;
					throw err;
				}
			},
			async confirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions) {
				try {
					const ui = await gate.#acquire(id, dialogOptions?.signal);
					return await ui.confirm(title, message, dialogOptions);
				} catch (err) {
					if (err instanceof FleetUiGateAbort) return false;
					throw err;
				}
			},
			async input(title: string, placeholder?: string, dialogOptions?: ExtensionUIDialogOptions) {
				try {
					const ui = await gate.#acquire(id, dialogOptions?.signal);
					return await ui.input(title, placeholder, dialogOptions);
				} catch (err) {
					if (err instanceof FleetUiGateAbort) return undefined;
					throw err;
				}
			},
			async askDialog(questions: ExtensionAskDialogQuestion[], dialogOptions?: ExtensionUIDialogOptions) {
				try {
					const ui = await gate.#acquire(id, dialogOptions?.signal);
					// The real interactive context always implements askDialog; the
					// optional signature exists for headless hosts.
					if (!ui.askDialog) return undefined;
					return await ui.askDialog(questions, dialogOptions);
				} catch (err) {
					if (err instanceof FleetUiGateAbort) return undefined;
					throw err;
				}
			},
			async editor(
				title: string,
				prefill?: string,
				dialogOptions?: ExtensionUIDialogOptions,
				editorOptions?: { promptStyle?: boolean },
			) {
				try {
					const ui = await gate.#acquire(id, dialogOptions?.signal);
					return await ui.editor(title, prefill, dialogOptions, editorOptions);
				} catch (err) {
					if (err instanceof FleetUiGateAbort) return undefined;
					throw err;
				}
			},
			async custom(factory, options) {
				// No safe default result exists for custom<T>; an abort surfaces
				// to the caller as a rejection, matching a dismissed dialog.
				const ui = await gate.#acquire(id, undefined);
				return ui.custom(factory, options);
			},
			notify(message, type) {
				focusedUi()?.notify(message, type);
			},
			onTerminalInput(handler) {
				const ui = focusedUi();
				return ui ? ui.onTerminalInput(handler) : () => {};
			},
			setStatus(key, text) {
				focusedUi()?.setStatus(key, text);
			},
			setWorkingMessage(message) {
				focusedUi()?.setWorkingMessage(message);
			},
			setWidget(key, content, options) {
				focusedUi()?.setWidget(key, content, options);
			},
			setFooter(factory) {
				focusedUi()?.setFooter(factory);
			},
			setHeader(factory) {
				focusedUi()?.setHeader(factory);
			},
			setTitle(title) {
				focusedUi()?.setTitle(title);
			},
			setEditorText(text) {
				focusedUi()?.setEditorText(text);
			},
			pasteToEditor(text) {
				focusedUi()?.pasteToEditor(text);
			},
			getEditorText() {
				return focusedUi()?.getEditorText() ?? "";
			},
			addAutocompleteProvider() {
				// Autocomplete is bound to the shared editor; per-fleet-session
				// providers would leak across sessions. Accepted and ignored,
				// matching headless hosts.
			},
			setEditorComponent() {
				// The shared editor component is owned by the main surface.
			},
			get theme(): Theme {
				const ui = gate.#getUi();
				if (!ui) throw new Error("Fleet UI gate: interactive UI is not available");
				return ui.theme;
			},
			getAllThemes() {
				const ui = gate.#getUi();
				return ui ? ui.getAllThemes() : Promise.resolve([]);
			},
			getTheme(name) {
				const ui = gate.#getUi();
				return ui ? ui.getTheme(name) : Promise.resolve(undefined);
			},
			setTheme(themeValue) {
				const ui = gate.#getUi();
				return ui ? ui.setTheme(themeValue) : Promise.resolve({ success: false, error: "no UI" });
			},
			getToolsExpanded() {
				return focusedUi()?.getToolsExpanded() ?? false;
			},
			setToolsExpanded(expanded) {
				focusedUi()?.setToolsExpanded(expanded);
			},
		};
		return proxy;
	}

	/** Resolve with the real UI once `id` is focused; reject on abort/release. */
	#acquire(id: string, signal: AbortSignal | undefined): Promise<ExtensionUIContext> {
		if (this.#focusedId === id) {
			const ui = this.#getUi();
			if (ui) return Promise.resolve(ui);
		}
		if (signal?.aborted) return Promise.reject(new FleetUiGateAbort("signal aborted"));
		const { promise, resolve, reject } = Promise.withResolvers<ExtensionUIContext>();
		let waiters = this.#waiters.get(id);
		if (!waiters) {
			waiters = new Set();
			this.#waiters.set(id, waiters);
		}
		const onAbort = (): void => {
			if (!waiters.delete(waiter)) return;
			this.#bumpPending(id, -1);
			reject(new FleetUiGateAbort("signal aborted"));
		};
		const waiter: GateWaiter = {
			resolve,
			reject,
			cleanup: () => signal?.removeEventListener("abort", onAbort),
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		waiters.add(waiter);
		this.#bumpPending(id, 1);
		return promise.finally(() => {
			// Settled by focus delivery, abort, or release: the dialog is no
			// longer queued either way.
			if (this.#pending.get(id)) this.#bumpPending(id, -1);
		});
	}

	#bumpPending(id: string, delta: number): void {
		const next = Math.max(0, (this.#pending.get(id) ?? 0) + delta);
		if (next === 0) this.#pending.delete(id);
		else this.#pending.set(id, next);
		this.#onPendingChange(id, next);
	}
}
