import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatCwd } from "./format";
import type { FusionState } from "./state";
import type { UsageSnapshot, UsageWindow } from "./usage";
import { fg, loadColor } from "./theme";

type Th = Pick<Theme, "fg">;

/** Left + right justified across `width`, padding the gap. Truncates if tight. */
function justify(left: string, right: string, width: number): string {
	const lw = visibleWidth(left);
	const rw = visibleWidth(right);
	if (lw + 1 + rw > width) return truncateToWidth(left || right, width, "");
	return `${left}${" ".repeat(width - lw - rw)}${right}`;
}

/** ` main [!2 ↑1]` — Starship-style branch segment with nerd-font icon. */
function branchSegment(theme: Th, state: FusionState): string {
	const { git } = state;
	if (!git.branch) return "";
	const flags: string[] = [];
	if (git.conflicted) flags.push(`=${git.conflicted}`);
	if (git.staged) flags.push(`+${git.staged}`);
	if (git.modified) flags.push(`!${git.modified}`);
	if (git.untracked) flags.push(`?${git.untracked}`);
	if (git.ahead) flags.push(`↑${git.ahead}`);
	if (git.behind) flags.push(`↓${git.behind}`);
	const color = git.dirty ? "warning" : "success";
	const icon = fg(theme, color, "");         // nf-pl-branch (U+E0A0)
	const branch = fg(theme, color, git.branch);
	const base = `${icon} ${branch}`;
	return flags.length ? `${base} ${fg(theme, "dim", `[${flags.join(" ")}]`)}` : base;
}

/** `5h 3% 3h37m   wk 12% 1d19h` — usage windows, no provider name, no bars. */
function usageSegment(theme: Th, usage: UsageSnapshot | null): string {
	if (!usage?.windows.length) return "";
	return usage.windows
		.map((w: UsageWindow) => {
			const pct = fg(theme, loadColor(w.usedPercent), `${Math.round(w.usedPercent)}%`);
			const reset = w.resetsIn ? ` ${fg(theme, "dim", w.resetsIn)}` : "";
			return `${fg(theme, "dim", w.label)} ${pct}${reset}`;
		})
		.join("   ");
}

export function installFooter(
	ctx: ExtensionContext,
	getState: () => FusionState,
	hooks: {
		setRequestRender: (fn: (() => void) | undefined) => void;
		onBranchChange: () => void;
	},
): void {
	ctx.ui.setFooter((tui, theme, footerData) => {
		hooks.setRequestRender(() => tui.requestRender());
		const unsub = footerData.onBranchChange(() => {
			hooks.onBranchChange();
			tui.requestRender();
		});

		return {
			dispose: () => {
				unsub();
				hooks.setRequestRender(undefined);
			},
			invalidate() {},
			render(width: number): string[] {
				if (width <= 0) return [""];
				const state = getState();
				const inner = Math.max(1, width - 2);

				// ── LEFT:  󰝰 ~/proj   main [!2]   Claude  5h 3% 3h37m   wk 12% 1d19h
				const folder = `${fg(theme, "muted", "󰝰")} ${fg(theme, "accent", formatCwd(state.cwd))}`;
				const branch = branchSegment(theme, state);
				const usage = usageSegment(theme, state.usage);
				const left = [folder, branch, usage].filter(Boolean).join("  ");

				// ── RIGHT: ctx 42%/1.0M  ·  $3.922
				const ctxPct = state.contextPercent;
				const ctxColor = ctxPct === null ? "dim" : loadColor(ctxPct);
				const ctxSeg = `${fg(theme, "dim", "ctx ")}${fg(theme, ctxColor, state.contextLabel)}`;
				const costSeg = fg(theme, "success", state.costLabel);
				const right = `${ctxSeg}${fg(theme, "dim", "  ·  ")}${costSeg}`;

				return [` ${justify(left, right, inner)} `];
			},
		};
	});
}
