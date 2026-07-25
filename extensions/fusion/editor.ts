import {
	CustomEditor,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	type EditorTheme,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { DROID, hex, subscribeTicker, tickerTick } from "./droid";
import type { AgentActivity } from "./state";
import { fitLine, normalizeWidth } from "./render-safe";
import { fg } from "./theme";

export type EditorMeta = {
	modelLabel: string;
	effortLabel: string;
	agent: AgentActivity;
	/** Live status shown above the box while the agent runs (never leaks into scrollback). */
	workingLabel: string;
};

/**
 * Droid's live-status spinner — the `dotsClockwise` preset, frames verbatim
 * from the bundle (@592752). Droid steps it at 60 ms; the shared fusion ticker
 * repaints every 2nd 50 ms tick (100 ms) to keep transcript repaints at 10 fps.
 */
const SPINNER = [
	"\u2819", "\u2818", "\u2838", "\u2830", "\u28B0", "\u28A0", "\u28E0", "\u28C0",
	"\u28C4", "\u2844", "\u2846", "\u2806", "\u2807", "\u2803", "\u280B", "\u2809",
];

/**
 * Border color by agent activity. Droid's Auto composer border is a CONSTANT
 * `uT.border` (traced @613578: `borderColor: uT.border`) — activity is
 * conveyed by the spinner row, not the border. The working/awaiting tints are
 * a deliberate fusion deviation, now resolved from the ACTIVE pi theme via
 * the live DROID palette (fallback: droid factory-dark):
 *  - idle     → theme `accent`      (droid fallback #d75f00)
 *  - working  → theme `borderMuted` (droid #767676 — the box recedes)
 *  - awaiting → theme `warning`     (droid #ffaf00 — the agent asked YOU)
 */
const BORDER_KEYS: Record<AgentActivity, "borderIdle" | "borderWorking" | "borderAwaiting"> = {
	idle: "borderIdle",
	working: "borderWorking",
	awaiting: "borderAwaiting",
};

/**
 * Chevron prompt drawn inside the box. Droid draws `"> "` in
 * `_U0.prompt.normal = uT.primary` (#d75f00, traced @613139/@613625).
 */
const PROMPT = ">";

/** Map effort label → Pi theme thinking-level color token. */
function effortColor(label: string): string {
	switch (label.toLowerCase()) {
		case "minimal":
			return "thinkingMinimal";
		case "low":
			return "thinkingLow";
		case "medium":
			return "thinkingMedium";
		case "high":
			return "thinkingHigh";
		case "xhigh":
			return "thinkingXhigh";
		case "max":
			return "thinkingMax";
		default:
			return "muted";
	}
}

const stripAnsi = (s: string): string =>
	s
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b_[^\x07]*(?:\x07|\x1b\\)/g, "");

/**
 * A border line drawn by the base editor. Two shapes:
 *  - a plain horizontal rule, all `─` / dashes; or
 *  - a scroll-indicator border when the input scrolls past ~30% of the
 *    terminal height: `─── ↑ 3 more ───` (top) / `─── ↓ 5 more ───` (bottom).
 * Missing the scroll variant made long pastes slice out the typed text
 * (the box picked the bottom rule as its top), blanking the editor.
 */
const isRule = (line: string): boolean => {
	const t = stripAnsi(line).trim();
	if (t.length < 3) return false;
	return /^[─-]+$/.test(t) || /^─+ ?[↑↓] ?\d+ more/.test(t);
};

/** Truncate to `w`, then pad with spaces to exactly `w` visible columns. */
function fill(line: string, w: number): string {
	const t = truncateToWidth(line, Math.max(0, w), "");
	return `${t}${" ".repeat(Math.max(0, w - visibleWidth(t)))}`;
}

/** A droid-skinned editor instance — `dispose()` releases the ticker. */
export type FusionSkinned = CustomEditor & { dispose: () => void };

/** The shape of a foreign `setEditorComponent` factory being composed. */
export type InnerEditorFactory = (
	tui: TUI,
	theme: EditorTheme,
	keybindings: KeybindingsManager,
) => unknown;

/**
 * Build the droid-style "bubble" composer:
 *  - Pi's native editor only draws a top + bottom rule (two horizontal lines),
 *    so we redraw a full rounded box ╭╮│╰╯ around the editor content.
 *  - The border color encodes the agent activity (idle/working/awaiting).
 *  - The native colored `›` prompt and the in-text cursor block are preserved
 *    (they shift right with the `│ ` rail automatically).
 *  - A right-aligned `model (effort)` meta row floats above the box.
 *
 * COMPOSITION: when `innerFactory` is provided (another extension owned the
 * single editor slot — e.g. rpiv-core's LaneDockEditor, whose handleInput
 * carries the DOWN-from-empty lane-browser gesture), its editor is constructed
 * and re-dressed: the skin patches ONLY the instance's `render`/`setPaddingX`,
 * so the foreign `handleInput` behavior and app keybindings survive untouched
 * underneath the droid bubble. Falls back to a plain CustomEditor when the
 * factory is absent, throws, or returns something that isn't editor-shaped.
 */
export function createFusionEditor(
	tui: TUI,
	theme: EditorTheme,
	keybindings: KeybindingsManager,
	uiTheme: Theme,
	getMeta: () => EditorMeta,
	isCurrent: () => boolean = () => true,
	innerFactory?: InnerEditorFactory,
): FusionSkinned {
	let inner: CustomEditor | undefined;
	if (innerFactory) {
		try {
			const candidate = innerFactory(tui, theme, keybindings) as CustomEditor;
			if (
				candidate &&
				typeof candidate.render === "function" &&
				typeof candidate.handleInput === "function" &&
				typeof candidate.setPaddingX === "function"
			) {
				inner = candidate;
			}
		} catch {
			inner = undefined; // a broken foreign factory must never cost the composer
		}
	}
	inner ??= new CustomEditor(tui, theme, keybindings, { paddingX: 0 });
	return applyFusionSkin(inner, tui, uiTheme, getMeta, isCurrent);
}

/**
 * Apply the droid skin to ONE editor instance (instance-level patch, never the
 * prototype — other extensions' editors elsewhere are unaffected).
 */
function applyFusionSkin(
	inner: CustomEditor,
	tui: TUI,
	uiTheme: Theme,
	getMeta: () => EditorMeta,
	isCurrent: () => boolean,
): FusionSkinned {
	const baseRender = inner.render.bind(inner);
	const baseSetPaddingX = inner.setPaddingX.bind(inner);
	const baseDispose = (inner as { dispose?: () => void }).dispose?.bind(inner);

	let unsubscribeTicker: (() => void) | undefined;
	// Release the ticker subscription. interactive-mode does NOT dispose
	// replaced custom editors — without this, tearing the editor down while the
	// agent is running leaks a 50 ms interval that repaints a dead TUI forever.
	const releaseTicker = () => {
		unsubscribeTicker?.();
		unsubscribeTicker = undefined;
	};

	// The bubble math assumes zero native padding — but interactive-mode copies
	// the user's editorPaddingX setting onto every custom editor right after
	// construction (`newEditor.setPaddingX(defaultEditor.getPaddingX())`).
	// Lock it at 0 so the droid frame stays consistent.
	baseSetPaddingX(0);
	inner.setPaddingX = (_padding: number) => baseSetPaddingX(0);

	/**
	 * `⠋ Thinking… · ctx 3%` — the live status row above the composer (Droid's
	 * transcript spinner analog), rendered here instead of Pi's loader row.
	 *
	 * ALWAYS returns a row (blank when idle): pi-tui's differ bakes stale rows
	 * into terminal scrollback whenever a repaint grows the frame past the
	 * viewport, so the editor must keep a CONSTANT height — toggling this row
	 * on/off is what corrupted the transcript on state changes.
	 */
	const statusLine = (width: number): string => {
		const meta = getMeta();
		const active = meta.agent !== "idle" && meta.workingLabel.length > 0;
		// Animate only while active; the ticker is ref-counted and self-stops.
		if (!isCurrent()) {
			releaseTicker();
			return "";
		}
		if (active && !unsubscribeTicker) {
			// Repaint on every 2nd tick (10 fps) — the spinner frame index derives
			// from tick/2, so intermediate ticks would repaint an identical frame.
			unsubscribeTicker = subscribeTicker(() => {
				if (tickerTick() % 2 === 0) tui.requestRender();
			});
		} else if (!active && unsubscribeTicker) {
			releaseTicker();
		}
		if (!active) return "";
		const frame = SPINNER[Math.floor(tickerTick() / 2) % SPINNER.length];
		// Droid (traced @645188): `paddingLeft: 1`, spinner + text in uT.primary,
		// hint ` (Press ESC to stop)` in uT.text.muted + dim, truncated to width-2.
		// Truncated to width — an overflowing status row wraps in the terminal,
		// changes the editor's height and desyncs pi-tui's differ.
		return truncateToWidth(
			` ${hex(DROID.primary, `${frame} ${meta.workingLabel}`)} ${hex(DROID.muted, "(Press ESC to stop)")}`,
			width,
			"…",
		);
	};

	/** Keep the editor frame within the actual terminal height on extreme LINES. */
	const capHeight = (lines: string[]): string[] => {
		const rows = normalizeWidth(tui.terminal.rows);
		return rows > 0 && lines.length > rows ? lines.slice(-rows) : lines;
	};

	/** Right-aligned `model (effort)` meta row floated above the box (constant-height: blank when no model). */
	const metaRow = (width: number): string => {
		const meta = getMeta();
		if (!meta.modelLabel || meta.modelLabel === "no-model") return "";
		const modelPart = fg(uiTheme, "muted", meta.modelLabel);
		const effortPart = meta.effortLabel
			? ` ${fg(uiTheme, effortColor(meta.effortLabel), `(${meta.effortLabel})`)}`
			: "";
		const plain = meta.effortLabel
			? `${meta.modelLabel} (${meta.effortLabel})`
			: meta.modelLabel;
		const pad = Math.max(0, width - visibleWidth(plain));
		return truncateToWidth(`${" ".repeat(pad)}${modelPart}${effortPart}`, width, "…");
	};

	inner.render = (width: number): string[] => {
		const w = normalizeWidth(width);
		const status = statusLine(w);
		const metaLine = metaRow(w);
		// Narrow terminals still retain the two prelude rows. Dropping them was
		// the source of a mode-dependent height jump and stale differ rows (L3-04).
		if (w <= 8) {
			const compact = baseRender(Math.max(1, w));
			return capHeight([
				status,
				metaLine,
				...(compact.length ? compact : [""]).map((line) => fitLine(line, w, "")),
			]);
		}

		const meta = getMeta();
		const promptW = visibleWidth(PROMPT) + 1; // chevron + 1 space
		const textW = Math.max(1, w - 4 - promptW); // `│ ` + prompt + text + ` │`
		const base = baseRender(textW);
		if (base.length < 2) {
			return capHeight([status, metaLine, ...base.map((line) => fitLine(line, w, ""))]);
		}

		// Split base into [topRule] content [bottomRule] (+ trailing autocomplete).
		// When a rule is missing, keep the lines instead of slicing real content
		// out (the old `topIdx=0 / botIdx=len-1` fallback dropped two lines).
		const topIdx = base.findIndex(isRule);
		let botIdx = -1;
		for (let i = base.length - 1; i > topIdx; i--) {
			if (isRule(base[i])) {
				botIdx = i;
				break;
			}
		}
		let content = base.slice(
			topIdx === -1 ? 0 : topIdx + 1,
			botIdx === -1 ? base.length : botIdx,
		);
		// Reserve the two prelude rows from the base editor's ~30% viewport
		// budget. Keep the cursor-containing rows at the bottom when trimming;
		// this is the safest available integration until pi-tui exposes a public
		// viewport-row callback (L3-05).
		const terminalRows = normalizeWidth(tui.terminal.rows);
		const baseBudget = Math.max(1, Math.floor(terminalRows * 0.3) - 2);
		const availableContentRows = Math.max(0, terminalRows - 4 /* prelude + top/bottom */);
		const maxContentRows = Math.min(baseBudget, availableContentRows);
		if (content.length > maxContentRows) {
			const cursorIndex = content.findIndex((line) => line.includes(CURSOR_MARKER));
			const preferredStart = cursorIndex >= 0
				? cursorIndex - maxContentRows + 1
				: content.length - maxContentRows;
			const start = Math.max(0, Math.min(preferredStart, content.length - maxContentRows));
			content = content.slice(start, start + maxContentRows);
		}
		const trailing = botIdx === -1 ? [] : base.slice(botIdx + 1); // autocomplete dropdown, if any

		const bd = (s: string) => hex(DROID[BORDER_KEYS[meta.agent]], s);
		const chevron = hex(DROID.primary, PROMPT);
		const indent = " ".repeat(promptW); // align wrapped lines under first line
		const top = bd(`╭${"─".repeat(Math.max(0, w - 2))}╮`);
		const bottom = bd(`╰${"─".repeat(Math.max(0, w - 2))}╯`);
		const rows = (content.length ? content : [""]).map((line, i) => {
			const prefix = i === 0 ? `${chevron} ` : indent;
			return `${bd("│")} ${prefix}${fill(line, textW)} ${bd("│")}`;
		});

		// Align the autocomplete dropdown under the box's inner content (Droid-style):
		// Pi puts the item name at its own col 2 (col 0-1 = selection gutter), so an
		// indent of 2 lands names under the typed text and the → arrow under the chevron.
		const acIndent = "  ";
		const dropdownBudget = Math.max(
			0,
			terminalRows - 2 /* prelude */ - 2 /* box borders */ - content.length,
		);
		const dropdown = trailing.slice(0, dropdownBudget).map((line) =>
			line.length ? `${acIndent}${line}` : line,
		);

		const box = [top, ...rows, bottom, ...dropdown];
		// Constant two-row prelude (status + meta), blank when inactive — the
		// editor must never change height on agent-state transitions (see above).
		return capHeight([status, metaLine, ...box.map((line) => fitLine(line, w, ""))]);
	};

	const skinned = inner as FusionSkinned;
	skinned.dispose = () => {
		releaseTicker();
		baseDispose?.();
	};
	return skinned;
}
