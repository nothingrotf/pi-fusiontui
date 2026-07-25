import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatCwd } from "./format";
import { fitLine, sanitizeScalar } from "./render-safe";
import type { FusionState } from "./state";
import { fg, justify, loadColor } from "./theme";
import type { UsageSnapshot, UsageWindow } from "./usage";

/**
 * The footer's PURE geometry layer: state + width in, physical lines out.
 *
 * It is deliberately free of `tui`, `ctx` and every other effectful handle so
 * the width/height contract can be exercised directly (see
 * tests/footer-rows.test.ts). `installFooter` in footer.ts owns the effects and
 * calls straight into `renderFooterRows`.
 */

type Th = Pick<Theme, "fg">;

/** ` main [!2 ↑1]` — Starship-style branch segment with nerd-font icon. */
export function branchSegment(theme: Th, state: FusionState): string {
	const { git } = state;
	if (!git.branch) return "";
	const flags: string[] = [];
	if (git.conflicted) flags.push(`=${git.conflicted}`);
	if (git.staged) flags.push(`+${git.staged}`);
	if (git.modified) flags.push(`!${git.modified}`);
	if (git.added) flags.push(`A${git.added}`);
	if (git.deleted) flags.push(`D${git.deleted}`);
	if (git.renamed) flags.push(`R${git.renamed}`);
	if (git.copied) flags.push(`C${git.copied}`);
	if (git.untracked) flags.push(`?${git.untracked}`);
	if (git.ahead) flags.push(`↑${git.ahead}`);
	if (git.behind) flags.push(`↓${git.behind}`);
	const color = git.dirty ? "warning" : "success";
	const icon = fg(theme, color, ""); // nf-pl-branch (U+E0A0)
	const branch = fg(theme, color, sanitizeScalar(git.branch));
	const base = `${icon} ${branch}`;
	return flags.length
		? `${base} ${fg(theme, "dim", `[${flags.join(" ")}]`)}`
		: base;
}

// pi-codex-goal publishes its status under this setStatus() key.
// ponytail: coupled to that one extension's key; generalize only if a second
// status-publishing extension needs first-class footer placement.
export const GOAL_STATUS_KEY = "codex-goal";

/** ⚑ goal from pi-codex-goal (`ctx.ui.setStatus("codex-goal", …)`). Shown in every mode. */
export function goalSegment(theme: Th, statuses: ReadonlyMap<string, string>): string {
	const raw = statuses.get(GOAL_STATUS_KEY);
	const text = raw === undefined ? "" : sanitizeScalar(raw);
	if (!text) return "";
	const color = /achieved|complete/i.test(text)
		? "success"
		: /unmet|abandoned|paused|attention/i.test(text)
			? "warning"
			: "accent";
	return `${fg(theme, color, "⚑")} ${fg(theme, "muted", text)}`;
}

/** `5h 3% 3h37m   wk 12% 1d19h` — usage windows, no provider name, no bars. */
export function usageSegment(theme: Th, usage: UsageSnapshot | null): string {
	if (!usage?.windows.length) return "";
	return usage.windows
		.map((w: UsageWindow) => {
			const used = typeof w.usedPercent === "number" && Number.isFinite(w.usedPercent)
				? Math.max(0, Math.min(100, w.usedPercent))
				: 0;
			const pct = fg(theme, loadColor(used), `${Math.round(used)}%`);
			const resetText = sanitizeScalar(w.resetsIn);
			const reset = resetText ? ` ${fg(theme, "dim", resetText)}` : "";
			return `${fg(theme, "dim", sanitizeScalar(w.label))} ${pct}${reset}`;
		})
		.join("   ");
}

/** One physical row: a 1-column gutter on each side, then left/right justified. */
function row(theme: Th, width: number, left: string, right = ""): string {
	const outer = width >= 2 ? 1 : 0;
	const inner = Math.max(0, Math.floor(width) - outer * 2);
	return fitLine(
		`${" ".repeat(outer)}${justify(left, right, inner)}${" ".repeat(outer)}`,
		width,
		"",
	);
}

/**
 * The footer's physical lines for `width`.
 *
 * Height contract (L3-02): `minimal` and `adaptive` are ALWAYS exactly one row,
 * `full` is ALWAYS exactly two — extension statuses and the goal segment fold
 * into existing rows instead of adding new ones, so a status update can never
 * change the frame height. Width contract (L3-01): every returned line fits
 * `width` after padding, because `row` final-fits the assembled string.
 */
export function renderFooterRows(
	theme: Th,
	state: FusionState,
	extStatuses: ReadonlyMap<string, string>,
	width: number,
): string[] {
	// ── LEFT:  󰝰 ~/proj   main [!2]   5h 3% 3h37m   wk 12% 1d19h   ● 🐴 ponytail: ⚡ FULL
	const folder = `${fg(theme, "muted", "󰝰")} ${fg(theme, "accent", formatCwd(state.cwd))}`;
	const branch = branchSegment(theme, state);
	const usage = usageSegment(theme, state.usage);
	const goal = goalSegment(theme, extStatuses);
	const statuses = Array.from(extStatuses.entries())
		.filter(([key, text]) => key !== GOAL_STATUS_KEY && text)
		.map(([, text]) => sanitizeScalar(text))
		.filter(Boolean)
		.join("  ");

	// ── RIGHT: ctx 42%/1.0M  ·  $3.922
	const ctxPct = state.contextPercent;
	const ctxColor = ctxPct === null ? "dim" : loadColor(ctxPct);
	const ctxSeg = `${fg(theme, "dim", "ctx ")}${fg(theme, ctxColor, sanitizeScalar(state.contextLabel))}`;
	const costSeg = fg(theme, "success", sanitizeScalar(state.costLabel));
	const right = `${ctxSeg}${fg(theme, "dim", "  ·  ")}${costSeg}`;

	if (state.mode === "minimal" || state.mode === "adaptive") {
		const minimalLeft = [folder, branch, usage, goal].filter(Boolean).join("  ");
		return [row(theme, width, minimalLeft, right)];
	}

	const topLeft = [folder, branch, statuses].filter(Boolean).join("  ");
	const secondLeft = [usage, goal].filter(Boolean).join("  ");
	return [row(theme, width, topLeft, right), row(theme, width, secondLeft)];
}
