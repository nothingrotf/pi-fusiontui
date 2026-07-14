import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type FgFn = (color: string, text: string) => string;

/** Left + right justified across `width`. When tight, keep right, ellipsis-truncate left. */
export function justify(left: string, right: string, width: number): string {
	const lw = visibleWidth(left);
	const rw = visibleWidth(right);
	if (lw + 1 + rw <= width)
		return `${left}${" ".repeat(width - lw - rw)}${right}`;
	if (rw + 2 <= width)
		return justify(truncateToWidth(left, width - rw - 1, "…"), right, width);
	return truncateToWidth(right || left, width, "");
}

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
