import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type FgFn = (color: string, text: string) => string;

/** Left + right justified across `width`. When tight, keep right, ellipsis-truncate left. */
export function justify(left: string, right: string, width: number): string {
	const w = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
	const lw = visibleWidth(left);
	const rw = visibleWidth(right);
	if (lw + 1 + rw <= w)
		return `${left}${" ".repeat(Math.max(0, w - lw - rw))}${right}`;
	if (rw + 2 <= w)
		return justify(truncateToWidth(left, w - rw - 1, "…"), right, w);
	return truncateToWidth(right || left, w, "");
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
	const value = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
	if (value >= 90) return "error";
	if (value >= 70) return "warning";
	if (value >= 50) return "accent";
	return "success";
}

const BAR_FILLED = "━";
const BAR_EMPTY = "─";

/** Widest bar we will ever draw — guards against absurd layout widths (L2-05). */
const BAR_MAX_WIDTH = 200;

/**
 * A colored progress bar, e.g. ━━━━━━────.
 * Total-safe (L2-05): invalid percent renders an empty bar, invalid/negative
 * width renders nothing — never a RangeError inside the footer render.
 */
export function renderBar(theme: Pick<Theme, "fg">, percent: number, width: number): string {
	const w = Number.isFinite(width) ? Math.min(BAR_MAX_WIDTH, Math.max(0, Math.floor(width))) : 0;
	if (w === 0) return "";
	const clamped = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
	const filled = Math.max(0, Math.min(w, Math.round((clamped / 100) * w)));
	const empty = w - filled;
	return fg(theme, loadColor(clamped), BAR_FILLED.repeat(filled)) + fg(theme, "dim", BAR_EMPTY.repeat(empty));
}
