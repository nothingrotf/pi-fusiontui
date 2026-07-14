import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { formatCwd } from "./format";
import type { FusionState } from "./state";
import type { UsageSnapshot, UsageWindow } from "./usage";
import { fitLine, sanitizeScalar } from "./render-safe";
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
	if (git.added) flags.push(`A${git.added}`);
	if (git.deleted) flags.push(`D${git.deleted}`);
	if (git.renamed) flags.push(`R${git.renamed}`);
	if (git.copied) flags.push(`C${git.copied}`);
	if (git.untracked) flags.push(`?${git.untracked}`);
	if (git.ahead) flags.push(`↑${git.ahead}`);
	if (git.behind) flags.push(`↓${git.behind}`);
	const color = git.dirty ? "warning" : "success";
	const icon = fg(theme, color, ""); // nf-pl-branch (U+E0A0)
	const branch = fg(theme, color, sanitizeScalar(git.branch));
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
function usageSegment(theme: Th, usage: UsageSnapshot | null): string {
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

export type FooterInstallHandle = { isOwned: () => boolean; token: symbol };

export function installFooter(
	ctx: ExtensionContext,
	getState: () => FusionState,
	hooks: {
		setRequestRender: (fn: ((force?: boolean) => void) | undefined, owner: symbol) => void;
		setResync: (fn: (() => void) | undefined, owner: symbol) => void;
		setFrameOverflows: (fn: (() => boolean | undefined) | undefined, owner: symbol) => void;
		onBranchChange: () => void;
	},
	ownerToken = Symbol("fusion-footer"),
): FooterInstallHandle {
	let owned = true;
	const handle: FooterInstallHandle = { isOwned: () => owned, token: ownerToken };
	ctx.ui.setFooter((tui, theme, footerData) => {
		hooks.setRequestRender((force?: boolean) => tui.requestRender(force), ownerToken);
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
				terminal?: { rows?: number; write?: (s: string) => void };
				previousLines?: unknown;
				previousViewportTop?: number;
				cursorRow?: number;
				hardwareCursorRow?: number;
			};
			const terminal = t.terminal;
			const lines = t.previousLines;
			const valid = !!terminal && Number.isInteger(terminal.rows) && (terminal.rows ?? 0) > 0
				&& typeof terminal.write === "function" && Array.isArray(lines)
				&& (lines as unknown[]).every((line) => typeof line === "string");
			if (!valid) {
				tui.requestRender(true);
				return;
			}
			const frame = lines as string[];
			if (frame.length === 0) return;
			const height = (terminal.rows ?? 0) as number;
			const write = terminal.write as (s: string) => void;
			const start = Math.max(0, frame.length - height);
			let buf = "\x1b[?2026h\x1b[H"; // sync + home (NO clear — see above)
			for (let i = start; i < frame.length; i++) {
				if (i > start) buf += "\r\n";
				buf += `\x1b[2K${frame[i]}`;
			}
			buf += "\x1b[0J"; // clear anything below the reprinted content
			buf += "\x1b[?2026l";
			try {
				write(buf);
				// Re-establish bookkeeping only when the private slots are writable.
				t.previousViewportTop = start;
				t.cursorRow = frame.length - 1;
				t.hardwareCursorRow = frame.length - 1;
				tui.requestRender(); // public API: repositions the hardware cursor
			} catch {
				tui.requestRender(true);
			}
		}, ownerToken);
		// Does pi-tui's current frame exceed the visible viewport? Only an
		// over-viewport repaint scrolls rows off the top into terminal scrollback,
		// where the in-place resync can never reach them. This is the signal the
		// orchestrator uses at agent_end to pick the deep clean (full clear +
		// reprint) over the cheap scrollback-preserving resync.
		hooks.setFrameOverflows(() => {
			const t = tui as unknown as {
				previousLines?: unknown;
				terminal?: { rows?: number };
			};
			if (!Array.isArray(t.previousLines) || !t.terminal ||
				!Number.isInteger(t.terminal.rows) || (t.terminal.rows ?? 0) <= 0 ||
				!(t.previousLines as unknown[]).every((line) => typeof line === "string"))
				return undefined;
			return t.previousLines.length > (t.terminal.rows ?? 0);
		}, ownerToken);
		const unsub = footerData.onBranchChange(() => {
			hooks.onBranchChange();
			tui.requestRender();
		});

		return {
			dispose: () => {
				owned = false;
				unsub();
				hooks.setRequestRender(undefined, ownerToken);
				hooks.setResync(undefined, ownerToken);
				hooks.setFrameOverflows(undefined, ownerToken);
			},
			invalidate() {},
			render(width: number): string[] {
				const state = getState();
				const row = (left: string, right = ""): string => {
					const outer = width >= 2 ? 1 : 0;
					const inner = Math.max(0, Math.floor(width) - outer * 2);
					return fitLine(
						`${" ".repeat(outer)}${justify(left, right, inner)}${" ".repeat(outer)}`,
						width,
						"",
					);
				};

				// ── LEFT:  󰝰 ~/proj   main [!2]   5h 3% 3h37m   wk 12% 1d19h   ● 🐴 ponytail: ⚡ FULL
				const folder = `${fg(theme, "muted", "󰝰")} ${fg(theme, "accent", formatCwd(state.cwd))}`;
				const branch = branchSegment(theme, state);
				const usage = usageSegment(theme, state.usage);
				const extStatuses: ReadonlyMap<string, string> =
					footerData.getExtensionStatuses();
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

				// minimal/adaptive are exactly one physical row. Goal/status text is
				// folded into that row and final-fitted after all padding (L3-01/02/03).
				const minimalLeft = [folder, branch, usage, goal].filter(Boolean).join("  ");
				if (state.mode === "minimal" || state.mode === "adaptive")
					return [row(minimalLeft, right)];

				// full has a fixed two-row contract, even when the first row happens
				// to fit. This prevents status/goal changes from changing frame height.
				const topLeft = [folder, branch, statuses].filter(Boolean).join("  ");
				const secondLeft = [usage, goal].filter(Boolean).join("  ");
				return [row(topLeft, right), row(secondLeft)];
			},
		};
	});
	return handle;
}
