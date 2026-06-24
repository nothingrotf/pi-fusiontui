import type { Theme } from "@earendil-works/pi-coding-agent";

type FgFn = (color: string, text: string) => string;

/** theme.fg that accepts any color token string and never throws on an unknown one. */
export function fg(theme: Pick<Theme, "fg">, color: string, text: string): string {
	try {
		return (theme.fg as unknown as FgFn)(color, text);
	} catch {
		return text;
	}
}

/** Pick a color token by threshold (used for context + usage bars). */
export function loadColor(percent: number): string {
	if (percent >= 90) return "error";
	if (percent >= 70) return "warning";
	if (percent >= 50) return "accent";
	return "success";
}

const BAR_FILLED = "━";
const BAR_EMPTY = "─";

/** A colored progress bar, e.g. ━━━━━━────. */
export function renderBar(theme: Pick<Theme, "fg">, percent: number, width: number): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * width);
	const empty = Math.max(0, width - filled);
	return fg(theme, loadColor(clamped), BAR_FILLED.repeat(filled)) + fg(theme, "dim", BAR_EMPTY.repeat(empty));
}
