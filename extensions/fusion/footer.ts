import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatCwd } from "./format";
import type { FusionState } from "./state";
import type { UsageSnapshot, UsageWindow } from "./usage";
import { fg, justify, loadColor } from "./theme";

type Th = Pick<Theme, "fg">;

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
	const icon = fg(theme, color, ""); // nf-pl-branch (U+E0A0)
	const branch = fg(theme, color, git.branch);
	const base = `${icon} ${branch}`;
	return flags.length
		? `${base} ${fg(theme, "dim", `[${flags.join(" ")}]`)}`
		: base;
}

// pi-codex-goal publishes its status under this setStatus() key.
// ponytail: coupled to that one extension's key; generalize only if a second
// status-publishing extension needs first-class footer placement.
const GOAL_STATUS_KEY = "codex-goal";

/** ⚑ goal from pi-codex-goal (`ctx.ui.setStatus("codex-goal", …)`). Shown in every mode. */
function goalSegment(theme: Th, statuses: ReadonlyMap<string, string>): string {
	const text = statuses.get(GOAL_STATUS_KEY)?.trim();
	if (!text) return "";
	const color = /achieved|complete/i.test(text)
		? "success"
		: /unmet|abandoned|paused|attention/i.test(text)
			? "warning"
			: "accent";
	return `${fg(theme, color, "⚑")} ${fg(theme, "muted", text)}`;
}

/** `5h 3% 3h37m   wk 12% 1d19h` — usage windows, no provider name, no bars. */
function usageSegment(theme: Th, usage: UsageSnapshot | null): string {
	if (!usage?.windows.length) return "";
	return usage.windows
		.map((w: UsageWindow) => {
			const pct = fg(
				theme,
				loadColor(w.usedPercent),
				`${Math.round(w.usedPercent)}%`,
			);
			const reset = w.resetsIn ? ` ${fg(theme, "dim", w.resetsIn)}` : "";
			return `${fg(theme, "dim", w.label)} ${pct}${reset}`;
		})
		.join("   ");
}

export function installFooter(
	ctx: ExtensionContext,
	getState: () => FusionState,
	hooks: {
		setRequestRender: (fn: ((force?: boolean) => void) | undefined) => void;
		setResync: (fn: (() => void) | undefined) => void;
		setFrameOverflows: (fn: (() => boolean) | undefined) => void;
		onBranchChange: () => void;
	},
): void {
	ctx.ui.setFooter((tui, theme, footerData) => {
		hooks.setRequestRender((force?: boolean) => tui.requestRender(force));
		// Viewport resync: pi-tui's differ can desync its row bookkeeping from
		// the physical screen (implicit scrolls during over-viewport repaints),
		// leaving stale/duplicated rows it can never repaint. This reprints ONLY
		// the visible screen from pi's own frame buffer, IN PLACE:
		//  - no \x1b[3J — the user's scrollback content survives;
		//  - no \x1b[2J — macOS terminals (iTerm2/Terminal.app default settings)
		//    push the cleared screen INTO scrollback on ED(2), so a 2J-based
		//    repaint appended a duplicate screenful to scrollback on every heal.
		//    Scrolling up then showed the whole session repeated over and over.
		// Instead: home the cursor, per-row erase+rewrite (EL(2)), then ED(0)
		// below the content — none of which trigger the save-to-scrollback path.
		hooks.setResync(() => {
			const t = tui as unknown as {
				terminal: { rows: number; write(s: string): void };
				previousLines?: string[];
				previousViewportTop?: number;
				cursorRow?: number;
				hardwareCursorRow?: number;
				requestRender(): void;
			};
			const lines = t.previousLines;
			if (!lines || lines.length === 0) return;
			const height = t.terminal.rows;
			const start = Math.max(0, lines.length - height);
			let buf = "\x1b[?2026h\x1b[H"; // sync + home (NO clear — see above)
			for (let i = start; i < lines.length; i++) {
				if (i > start) buf += "\r\n";
				buf += `\x1b[2K${lines[i]}`;
			}
			buf += "\x1b[0J"; // clear anything below the reprinted content
			buf += "\x1b[?2026l";
			t.terminal.write(buf);
			// Re-establish the bookkeeping pi-tui assumes on the next diff.
			t.previousViewportTop = start;
			t.cursorRow = lines.length - 1;
			t.hardwareCursorRow = lines.length - 1;
			t.requestRender(); // repositions the hardware cursor
		});
		// Does pi-tui's current frame exceed the visible viewport? Only an
		// over-viewport repaint scrolls rows off the top into terminal scrollback,
		// where the in-place resync can never reach them. This is the signal the
		// orchestrator uses at agent_end to pick the deep clean (full clear +
		// reprint) over the cheap scrollback-preserving resync.
		hooks.setFrameOverflows(() => {
			const t = tui as unknown as {
				previousLines?: string[];
				terminal: { rows: number };
			};
			return (t.previousLines?.length ?? 0) > t.terminal.rows;
		});
		const unsub = footerData.onBranchChange(() => {
			hooks.onBranchChange();
			tui.requestRender();
		});

		return {
			dispose: () => {
				unsub();
				hooks.setRequestRender(undefined);
				hooks.setResync(undefined);
				hooks.setFrameOverflows(undefined);
			},
			invalidate() {},
			render(width: number): string[] {
				if (width <= 0) return [""];
				const state = getState();
				const inner = Math.max(1, width - 2);

				// ── LEFT:  󰝰 ~/proj   main [!2]   5h 3% 3h37m   wk 12% 1d19h   ● 🐴 ponytail: ⚡ FULL
				const folder = `${fg(theme, "muted", "󰝰")} ${fg(theme, "accent", formatCwd(state.cwd))}`;
				const branch = branchSegment(theme, state);
				const usage = usageSegment(theme, state.usage);
				const extStatuses: ReadonlyMap<string, string> =
					footerData.getExtensionStatuses();
				const goal = goalSegment(theme, extStatuses);
				const statuses = Array.from(extStatuses.entries())
					.filter(([key, text]) => key !== GOAL_STATUS_KEY && text)
					.map(([, text]) => text)
					.join("  ");

				// ── RIGHT: ctx 42%/1.0M  ·  $3.922
				const ctxPct = state.contextPercent;
				const ctxColor = ctxPct === null ? "dim" : loadColor(ctxPct);
				const ctxSeg = `${fg(theme, "dim", "ctx ")}${fg(theme, ctxColor, state.contextLabel)}`;
				const costSeg = fg(theme, "success", state.costLabel);
				const right = `${ctxSeg}${fg(theme, "dim", "  ·  ")}${costSeg}`;

				// goal gets its own line below — the info row is already crowded.
				const goalLine = goal ? [` ${justify(goal, "", inner)} `] : [];

				// minimal: folder + branch on the left, ctx on the right; always one line.
				const renderMinimal = () => {
					const left = [folder, branch, usage].filter(Boolean).join("  ");
					return [` ${justify(left, ctxSeg, inner)} `, ...goalLine];
				};
				if (state.mode === "minimal") return renderMinimal();

				const left = [folder, branch, usage, statuses]
					.filter(Boolean)
					.join("  ");
				const fitsOneLine =
					visibleWidth(left) + 1 + visibleWidth(right) <= inner;

				// adaptive: collapse to minimal instead of wrapping onto a second line.
				if (!fitsOneLine && state.mode === "adaptive") return renderMinimal();

				if (!fitsOneLine) {
					// full: second line carries usage on the left, ctx/cost on the right.
					const topLeft = [folder, branch, statuses].filter(Boolean).join("  ");
					return [
						` ${justify(topLeft, "", inner)} `,
						` ${justify(usage, right, inner)} `,
						...goalLine,
					];
				}
				return [` ${justify(left, right, inner)} `, ...goalLine];
			},
		};
	});
}
