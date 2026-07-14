import type { TUI } from "@earendil-works/pi-tui";

type TuiInternals = {
	requestRender(force?: boolean): void;
	doRender(): void;
	terminal: { write(data: string): void };
};

export type ScrollLockInputResult = { consume?: boolean } | undefined;

export type ScrollLockHandle = {
	handleInput(data: string): ScrollLockInputResult;
	setActive(active: boolean): void;
	pause(): void;
	resume(): void;
	isPaused(): boolean;
	dispose(): void;
};

const PAGE_UP = /\x1b\[(?:5|1;\d+)(?:;\d+)?~/;
const PAGE_UP_ALT = /\x1b\[\[5~|\x1b\[5[$^]|\x1b\[57421(?:;\d+)?u/;
const SGR_WHEEL_UP = /\x1b\[<6[04];\d+;\d+M/;

/** Bare terminal focus reports (`ESC [ I` / `ESC [ O`) — noise, never a resume intent. */
const FOCUS_REPORT = /^\x1b\[[IO]$/;

function legacyWheelUp(data: string): boolean {
	const marker = data.indexOf("\x1b[M");
	if (marker === -1 || marker + 3 >= data.length) return false;
	const button = (data.charCodeAt(marker + 3) - 32) & 0xff;
	if ((button & 0x40) === 0) return false; // ordinary click/drag
	return (button & 1) === 0; // even = wheel up
}

/** PageUp or a reported wheel-up — the only gestures that pause the live view. */
function isScrollBackInput(data: string): boolean {
	return PAGE_UP.test(data) || PAGE_UP_ALT.test(data) || SGR_WHEEL_UP.test(data) || legacyWheelUp(data);
}

/**
 * Pause TUI renders while the user reads terminal history. Pi-tui does not
 * expose a scrollback/following state, so this wraps its public render request
 * and the private scheduled render seam.
 *
 * IMPORTANT: this intentionally does NOT enable raw mouse tracking. Turning on
 * `\x1b[?1000h` hijacks the terminal's native mouse (selection + wheel), and a
 * stray trackpad scroll during a run would then pause rendering with no obvious
 * way back — the agent keeps working while the UI looks frozen. Instead we only
 * pause on an explicit PageUp (or a wheel-up a terminal already reports on its
 * own), and ANY subsequent keystroke — or the next agent turn — resumes the
 * live view, so a pause can never strand the UI.
 */
export function installScrollLock(tui: TUI): ScrollLockHandle {
	const target = tui as unknown as TuiInternals;
	const originalRequestRender = target.requestRender;
	const originalDoRender = target.doRender;
	if (
		typeof originalRequestRender !== "function" ||
		typeof originalDoRender !== "function" ||
		!target.terminal ||
		typeof target.terminal.write !== "function"
	) {
		return {
			handleInput() {},
			setActive() {},
			pause() {},
			resume() {},
			isPaused: () => false,
			dispose() {},
		};
	}

	let paused = false;

	const installedRequestRender = function (this: TuiInternals, force = false): void {
		if (paused) return;
		originalRequestRender.call(this, force);
	};
	const installedDoRender = function (this: TuiInternals): void {
		if (paused) return;
		originalDoRender.call(this);
	};
	target.requestRender = installedRequestRender;
	target.doRender = installedDoRender;

	const pause = () => {
		paused = true;
	};
	const resume = () => {
		if (!paused) return;
		paused = false;
		// The differ's previous frame is still the last frame actually painted;
		// resume normally so Pi can append current state without clearing history.
		target.requestRender();
	};

	return {
		// Kept for API compatibility; raw mouse tracking is deliberately not used.
		setActive(): void {},
		handleInput(data: string): ScrollLockInputResult {
			if (isScrollBackInput(data)) {
				pause();
				// A reported wheel-up would otherwise reach the editor as an unknown
				// key; consume it. PageUp is left for the editor/app to handle.
				return SGR_WHEEL_UP.test(data) || legacyWheelUp(data) ? { consume: true } : undefined;
			}
			// Any real keystroke while paused means "I'm done reading" — resume the
			// live view. Bare focus reports are noise and must not resume.
			if (paused && data.length > 0 && !FOCUS_REPORT.test(data)) {
				resume();
			}
			return undefined;
		},
		pause,
		resume,
		isPaused: () => paused,
		dispose(): void {
			paused = false;
			if (target.requestRender === installedRequestRender)
				target.requestRender = originalRequestRender;
			if (target.doRender === installedDoRender)
				target.doRender = originalDoRender;
		},
	};
}
