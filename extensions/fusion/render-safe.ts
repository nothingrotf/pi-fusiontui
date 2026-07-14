import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Normalize a layout width before any repeat/truncate operation. */
export function normalizeWidth(width: number, max = 10_000): number {
	if (!Number.isFinite(width)) return 0;
	return Math.min(max, Math.max(0, Math.floor(width)));
}

// OSC, CSI, DCS and other ESC-prefixed terminal controls. External text must
// not be allowed to move the cursor or create physical rows in the frame.
const TERMINAL_SEQUENCE =
	/\x1b(?:\][\s\S]*?(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|P[\s\S]*?(?:\x07|\x1b\\)|[()][0-2A-Z])/g;
const C0_AND_C1 = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const C0_AND_C1_NO_ESC = /[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F-\u009F]/g;

/** Strip terminal controls while retaining ordinary Unicode text. */
export function sanitizeText(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.replace(TERMINAL_SEQUENCE, "").replace(C0_AND_C1, "");
}

/** One-line external value for footer labels and tool headers. */
export function sanitizeScalar(value: unknown): string {
	return sanitizeText(value).replace(/[\t\r\n]+/g, " ").replace(/ +/g, " ").trim();
}

/** Preserve intentional line breaks but make every physical line safe. */
export function sanitizeLines(value: unknown): string[] {
	return sanitizeText(value)
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/\t/g, " "));
}

/**
 * Sanitize a line that already contains Fusion/Pi styling. Preserve SGR and
 * shell-integration OSC 133 markers, but remove cursor movement, hyperlinks,
 * arbitrary OSC payloads, and physical controls from rendered message text.
 */
export function sanitizeStyledLine(value: string): string {
	return value
		.replace(TERMINAL_SEQUENCE, (sequence) =>
			/^\x1b\[[0-9;]*m$/.test(sequence) || /^\x1b\]133;[ABC]\x07$/.test(sequence)
				? sequence
				: "",
		)
		.replace(C0_AND_C1_NO_ESC, "");
}

/** Fit a complete, already-styled line to the physical terminal width. */
export function fitLine(line: string, width: number, ellipsis = "…"): string {
	const w = normalizeWidth(width);
	if (w === 0) return "";
	// Generated ANSI is preserved; external content is sanitized before styling.
	return truncateToWidth(line.replace(/[\r\n]/g, " "), w, ellipsis);
}

/** Fit and pad a line to exactly the supplied visible width. */
export function fillLine(line: string, width: number): string {
	const w = normalizeWidth(width);
	const fitted = fitLine(line, w, "");
	return `${fitted}${" ".repeat(Math.max(0, w - visibleWidth(fitted)))}`;
}

/** Bound transcript expansion while retaining a visible continuation marker. */
export function boundedLines(
	lines: readonly string[],
	maxLines: number,
	continuation: (hidden: number) => string,
): string[] {
	const limit = normalizeWidth(maxLines, 10_000);
	if (lines.length <= limit) return [...lines];
	if (limit <= 0) return [];
	const hidden = lines.length - Math.max(0, limit - 1);
	return [...lines.slice(0, Math.max(0, limit - 1)), continuation(hidden)];
}

/** Assert the render contract in development/tests without throwing in TUI. */
export function linesFitWidth(lines: readonly string[], width: number): boolean {
	const w = normalizeWidth(width);
	return lines.every((line) => !line.includes("\n") && visibleWidth(line) <= w);
}
