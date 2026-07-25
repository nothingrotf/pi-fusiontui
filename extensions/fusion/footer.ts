import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderFooterRows } from "./footer-rows";
import type { FusionState } from "./state";
import {
	installScrollLock,
	type ScrollLockHandle,
	type ScrollLockInputResult,
} from "./scroll-lock";

export type FooterInstallHandle = {
	isOwned: () => boolean;
	token: symbol;
	handleInput: (data: string) => ScrollLockInputResult;
	setActive: (active: boolean) => void;
	pause: () => void;
	resume: () => void;
	isPaused: () => boolean;
};

export function installFooter(
	ctx: ExtensionContext,
	getState: () => FusionState,
	hooks: {
		setRequestRender: (fn: ((force?: boolean) => void) | undefined, owner: symbol) => void;
		setResync: (fn: (() => void) | undefined, owner: symbol) => void;
		onBranchChange: () => void;
	},
	ownerToken = Symbol("fusion-footer"),
): FooterInstallHandle {
	let owned = true;
	let scrollLock: ScrollLockHandle | undefined;
	const handle: FooterInstallHandle = {
		isOwned: () => owned,
		token: ownerToken,
		handleInput: (data) => scrollLock?.handleInput(data),
		setActive: (active) => scrollLock?.setActive(active),
		pause: () => scrollLock?.pause(),
		resume: () => scrollLock?.resume(),
		isPaused: () => scrollLock?.isPaused() ?? false,
	};
	ctx.ui.setFooter((tui, theme, footerData) => {
		scrollLock = installScrollLock(tui);
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
			if (scrollLock?.isPaused()) return;
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
		const unsub = footerData.onBranchChange(() => {
			hooks.onBranchChange();
			tui.requestRender();
		});

		return {
			dispose: () => {
				owned = false;
				scrollLock?.dispose();
				scrollLock = undefined;
				unsub();
				hooks.setRequestRender(undefined, ownerToken);
				hooks.setResync(undefined, ownerToken);
			},
			invalidate() {},
			render: (width: number): string[] =>
				renderFooterRows(theme, getState(), footerData.getExtensionStatuses(), width),
		};
	});
	return handle;
}
