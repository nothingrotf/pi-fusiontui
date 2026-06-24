import { CustomEditor, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { type EditorTheme, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { fg } from "./theme";

export type EditorMeta = {
	modelLabel: string;
	effortLabel: string;
};

/** Box border color token. Change to taste: "accent" | "border" | "borderMuted". */
const BORDER_COLOR = "accent";

/** Chevron prompt drawn inside the box (Droid-style). Color = "accent". */
const PROMPT = ">";
const PROMPT_COLOR = "accent";

/** Map effort label → Pi theme thinking-level color token. */
function effortColor(label: string): string {
	switch (label.toLowerCase()) {
		case "minimal": return "thinkingMinimal";
		case "low":     return "thinkingLow";
		case "medium":  return "thinkingMedium";
		case "high":    return "thinkingHigh";
		case "xhigh":   return "thinkingXhigh";
		default:        return "muted";
	}
}

const stripAnsi = (s: string): string =>
	s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");

/** A horizontal rule line drawn by the base editor (all ─ / dashes). */
const isRule = (line: string): boolean => {
	const t = stripAnsi(line).trim();
	return t.length >= 3 && /^[─-]+$/.test(t);
};

/** Truncate to `w`, then pad with spaces to exactly `w` visible columns. */
function fill(line: string, w: number): string {
	const t = truncateToWidth(line, Math.max(0, w), "");
	return `${t}${" ".repeat(Math.max(0, w - visibleWidth(t)))}`;
}

/**
 * Droid-style "bubble" editor:
 *  - Pi's native editor only draws a top + bottom rule (two horizontal lines),
 *    so we redraw a full rounded box ╭╮│╰╯ around the editor content.
 *  - The native colored `›` prompt and the in-text cursor block are preserved
 *    (they shift right with the `│ ` rail automatically).
 *  - A right-aligned `model (effort)` meta row floats above the box.
 */
export class FusionEditor extends CustomEditor {
	private readonly uiTheme: Theme;
	private readonly getMeta: () => EditorMeta;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		uiTheme: Theme,
		getMeta: () => EditorMeta,
	) {
		super(tui, theme, keybindings, { paddingX: 0 });
		this.uiTheme = uiTheme;
		this.getMeta = getMeta;
	}

	private metaRow(width: number): string | undefined {
		const meta = this.getMeta();
		if (!meta.modelLabel || meta.modelLabel === "no-model") return undefined;
		const modelPart = fg(this.uiTheme, "muted", meta.modelLabel);
		const effortPart = meta.effortLabel
			? ` ${fg(this.uiTheme, effortColor(meta.effortLabel), `(${meta.effortLabel})`)}`
			: "";
		const plain = meta.effortLabel ? `${meta.modelLabel} (${meta.effortLabel})` : meta.modelLabel;
		const pad = Math.max(0, width - visibleWidth(plain));
		return `${" ".repeat(pad)}${modelPart}${effortPart}`;
	}

	render(width: number): string[] {
		// Too narrow to box — fall back to the plain editor.
		if (width <= 8) return super.render(width);

		const promptW = visibleWidth(PROMPT) + 1; // chevron + 1 space
		const textW = width - 4 - promptW;         // `│ ` + prompt + text + ` │`
		const base = super.render(textW);
		if (base.length < 2) return super.render(width);

		// Split base into [topRule] content [bottomRule] (+ trailing autocomplete).
		let topIdx = base.findIndex(isRule);
		if (topIdx === -1) topIdx = 0;
		let botIdx = -1;
		for (let i = base.length - 1; i > topIdx; i--) {
			if (isRule(base[i])) { botIdx = i; break; }
		}
		if (botIdx === -1) botIdx = base.length - 1;

		const content = base.slice(topIdx + 1, botIdx);
		const trailing = base.slice(botIdx + 1); // autocomplete dropdown, if any

		const bd = (s: string) => fg(this.uiTheme, BORDER_COLOR, s);
		const chevron = fg(this.uiTheme, PROMPT_COLOR, PROMPT);
		const indent = " ".repeat(promptW); // align wrapped lines under first line
		const top = bd(`╭${"─".repeat(width - 2)}╮`);
		const bottom = bd(`╰${"─".repeat(width - 2)}╯`);
		const rows = (content.length ? content : [""]).map((line, i) => {
			const prefix = i === 0 ? `${chevron} ` : indent;
			return `${bd("│")} ${prefix}${fill(line, textW)} ${bd("│")}`;
		});

		// Align the autocomplete dropdown under the box's inner content (Droid-style):
		// Pi puts the item name at its own col 2 (col 0-1 = selection gutter), so an
		// indent of 2 lands names under the typed text and the → arrow under the chevron.
		const acIndent = "  ";
		const dropdown = trailing.map((line) => (line.length ? `${acIndent}${line}` : line));

		const box = [top, ...rows, bottom, ...dropdown];
		const meta = this.metaRow(width);
		return meta ? [meta, ...box] : box;
	}
}
