/**
 * Fleet overview overlay - the Claude-Code-style top-level session dashboard.
 * Fullscreen table of every fleet session for this project: live supervised
 * sessions (running / waiting / idle / done / error) plus durable archived
 * entries from the fleet index that can be resumed. Enter focuses a session,
 * `n` fires a new task, the in-session model keys carry over — Ctrl+P cycles
 * the configured role ladder and Alt+P opens the picker, both scoped to the
 * NEXT task only — and `x` stops a live session (or drops an archived entry).
 */
import { type Component, matchesKey, type TUI, truncateToWidth } from "@oh-my-pi/pi-tui";
import { formatAge } from "@oh-my-pi/pi-utils";
import type { KeyId } from "../../config/keybindings";
import type { FleetIndexEntry } from "../../fleet/fleet-index";
import type { FleetRecord, FleetSessionStatus } from "../../fleet/types";
import { shortenPath } from "../../tools/render-utils";
import { type ThemeColor, theme } from "../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import { bottomBorder, divider, fit, row, topBorder } from "./overlay-box";

const AGE_TICK_MS = 5_000;

interface StatusStyle {
	glyph: string;
	label: string;
	color: ThemeColor;
}

const STATUS_STYLES: Record<FleetSessionStatus, StatusStyle> = {
	running: { glyph: "●", label: "running", color: "accent" },
	waiting: { glyph: "◐", label: "waiting", color: "warning" },
	idle: { glyph: "○", label: "idle", color: "dim" },
	done: { glyph: "✓", label: "done", color: "success" },
	error: { glyph: "✗", label: "error", color: "error" },
};

const ARCHIVED_STYLE: StatusStyle = { glyph: "▸", label: "archived", color: "dim" };

type FleetOverlayRow = { kind: "live"; record: FleetRecord } | { kind: "archived"; entry: FleetIndexEntry };

export interface FleetOverlayDeps {
	records: () => FleetRecord[];
	archived: () => FleetIndexEntry[];
	/** Display label for the pending next-task model ("default" when unset). */
	nextModelLabel: () => string;
	onDone: () => void;
	onFocus: (id: string) => void;
	onResume: (entry: FleetIndexEntry) => void;
	onNewTask: () => void;
	/** Full model picker for the next task (the in-session Alt+P idiom). */
	onPickModel: () => void;
	/** Role-ladder cycle for the next task (the in-session Ctrl+P idiom). */
	onCycleModel: (direction: 1 | -1) => void;
	/** Keys mirroring `app.model.cycleForward` / `cycleBackward` / `selectTemporary`. */
	cycleForwardKeys: readonly KeyId[];
	cycleBackwardKeys: readonly KeyId[];
	pickerKeys: readonly KeyId[];
	/** Human-readable labels for the footer hint (e.g. "ctrl+p", "alt+p"). */
	cycleKeyLabel: string;
	pickerKeyLabel: string;
	onStop: (id: string) => void;
	onRemoveArchived: (id: string) => void;
	requestRender: () => void;
	/** Supervisor change feed; the overlay re-renders on every tick. */
	subscribe: (listener: () => void) => () => void;
	ui?: TUI;
	cwd: string;
}

export class FleetOverlayComponent implements Component {
	#deps: FleetOverlayDeps;
	#selected = 0;
	#unsubscribe: (() => void) | undefined;
	#ageTimer: NodeJS.Timeout | undefined;

	constructor(deps: FleetOverlayDeps) {
		this.#deps = deps;
		this.#unsubscribe = deps.subscribe(() => deps.requestRender());
		this.#ageTimer = setInterval(() => deps.requestRender(), AGE_TICK_MS);
		this.#ageTimer.unref?.();
	}

	dispose(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		if (this.#ageTimer) {
			clearInterval(this.#ageTimer);
			this.#ageTimer = undefined;
		}
	}

	#rows(): FleetOverlayRow[] {
		const live = this.#deps.records().map(record => ({ kind: "live", record }) as const);
		const archived = this.#deps.archived().map(entry => ({ kind: "archived", entry }) as const);
		return [...live, ...archived];
	}

	handleInput(data: string): void {
		const rows = this.#rows();
		if (matchesSelectUp(data) || matchesKey(data, "k")) {
			this.#selected = rows.length === 0 ? 0 : (this.#selected - 1 + rows.length) % rows.length;
			this.#deps.requestRender();
			return;
		}
		if (matchesSelectDown(data) || matchesKey(data, "j")) {
			this.#selected = rows.length === 0 ? 0 : (this.#selected + 1) % rows.length;
			this.#deps.requestRender();
			return;
		}
		if (matchesKey(data, "enter")) {
			const target = rows[this.#selected];
			if (!target) return;
			if (target.kind === "live") this.#deps.onFocus(target.record.id);
			else this.#deps.onResume(target.entry);
			return;
		}
		if (matchesKey(data, "n")) {
			this.#deps.onNewTask();
			return;
		}
		for (const key of this.#deps.cycleBackwardKeys) {
			if (matchesKey(data, key)) {
				this.#deps.onCycleModel(-1);
				return;
			}
		}
		for (const key of this.#deps.cycleForwardKeys) {
			if (matchesKey(data, key)) {
				this.#deps.onCycleModel(1);
				return;
			}
		}
		for (const key of this.#deps.pickerKeys) {
			if (matchesKey(data, key)) {
				this.#deps.onPickModel();
				return;
			}
		}
		if (matchesKey(data, "x")) {
			const target = rows[this.#selected];
			if (!target) return;
			if (target.kind === "live") this.#deps.onStop(target.record.id);
			else this.#deps.onRemoveArchived(target.entry.id);
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.#deps.onDone();
		}
	}

	render(width: number): readonly string[] {
		const termHeight = this.#deps.ui?.terminal?.rows || process.stdout.rows || 40;
		const rows = this.#rows();
		if (this.#selected >= rows.length) this.#selected = Math.max(0, rows.length - 1);

		const lines: string[] = [];
		lines.push(topBorder(width, " Fleet — top-level sessions "));
		const inner = Math.max(10, width - 4);

		if (rows.length === 0) {
			lines.push(row(theme.fg("dim", "No fleet sessions yet — press n to launch the first task"), width));
		}

		// Bound visible rows to the frame: chrome is top border, optional header,
		// model line, footer, bottom border.
		const maxVisible = Math.max(3, termHeight - 5);
		let start = 0;
		if (rows.length > maxVisible) {
			start = Math.min(Math.max(0, this.#selected - Math.floor(maxVisible / 2)), rows.length - maxVisible);
		}
		const visible = rows.slice(start, start + maxVisible);

		for (const [offset, item] of visible.entries()) {
			const index = start + offset;
			lines.push(row(this.#renderRow(item, inner, index === this.#selected), width));
		}

		lines.push(divider(width));
		lines.push(row(theme.fg("dim", "next task model: ") + theme.fg("accent", this.#deps.nextModelLabel()), width));
		lines.push(
			row(
				theme.fg(
					"dim",
					`↑/↓ select · Enter open · n new task · ${this.#deps.cycleKeyLabel} cycle model · ${this.#deps.pickerKeyLabel} pick model · x stop/remove · Esc close`,
				),
				width,
			),
		);
		lines.push(bottomBorder(width));
		return lines;
	}

	#renderRow(item: FleetOverlayRow, inner: number, selected: boolean): string {
		const style = item.kind === "live" ? STATUS_STYLES[item.record.status] : ARCHIVED_STYLE;
		const title = item.kind === "live" ? item.record.title : (item.entry.title ?? item.entry.id);
		const model = item.kind === "live" ? (item.record.modelSelector ?? "") : (item.entry.model ?? "");
		const at = item.kind === "live" ? item.record.lastActivity : Date.parse(item.entry.updatedAt) || Date.now();
		const location =
			item.kind === "live"
				? (item.record.worktree?.branch ?? shortenPath(item.record.cwd))
				: (item.entry.worktree?.branch ?? shortenPath(item.entry.cwd));

		const glyph = theme.fg(style.color, style.glyph);
		const status = theme.fg(style.color, style.label.padEnd(8));
		const age = theme.fg("dim", formatAge(at).padStart(4));
		const titleWidth = Math.max(8, inner - 8 - 4 - 24 - 22 - 6);
		const titleCell = fit(truncateToWidth(title, titleWidth), titleWidth);
		const modelCell = theme.fg("dim", fit(truncateToWidth(model, 24), 24));
		const locationCell = theme.fg("dim", fit(truncateToWidth(location, 22), 22));
		const line = `${glyph} ${status} ${titleCell} ${modelCell} ${locationCell} ${age}`;
		if (!selected) return line;
		return theme.fg("accent", "▌") + line;
	}
}
