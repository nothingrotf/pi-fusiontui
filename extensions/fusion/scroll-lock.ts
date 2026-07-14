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
const PAGE_DOWN = /\x1b\[(?:6|4;\d+)(?:;\d+)?~/;
const PAGE_DOWN_ALT = /\x1b\[\[6~|\x1b\[6[$^]|\x1b\[57422(?:;\d+)?u/;
const END = /\x1b\[(?:F|4~|8~|8[$^]|1;\d+F|57424(?:;\d+)?u)/;
const SGR_WHEEL_UP = /\x1b\[<6[04];\d+;\d+M/;
const SGR_WHEEL_DOWN = /\x1b\[<6[15];\d+;\d+M/;

function legacyWheelDirection(data: string): "up" | "down" | undefined {
	const marker = data.indexOf("\x1b[M");
	if (marker === -1 || marker + 3 >= data.length) return undefined;
	const button = (data.charCodeAt(marker + 3) - 32) & 0xff;
	if ((button & 0x40) === 0) return undefined; // ordinary click/drag
	return (button & 1) === 0 ? "up" : "down";
}

function isScrollBackInput(data: string): boolean {
	return PAGE_UP.test(data) || PAGE_UP_ALT.test(data) || SGR_WHEEL_UP.test(data) || legacyWheelDirection(data) === "up";
}

function isFollowInput(data: string): boolean {
	return (
		(PAGE_DOWN.test(data) || PAGE_DOWN_ALT.test(data)) ||
		END.test(data) ||
		SGR_WHEEL_DOWN.test(data) ||
		legacyWheelDirection(data) === "down"
	);
}

const ENABLE_MOUSE_REPORTING = "\x1b[?1000h\x1b[?1006h";
const DISABLE_MOUSE_REPORTING = "\x1b[?1006l\x1b[?1000l";

/**
 * Pause TUI renders while the user is navigating terminal history. Pi-tui does
 * not expose a scrollback/following state, so this wraps its public render
 * request and the private scheduled render seam. Mouse reporting is enabled
 * only while following; when the first wheel-up arrives it is disabled again,
 * returning subsequent wheel events to the terminal's native scrollback.
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
	let active = false;
	let mouseReporting = false;
	const canReportMouse = process.stdout.isTTY === true;
	const setMouseReporting = (enabled: boolean) => {
		if (!canReportMouse || mouseReporting === enabled) return;
		target.terminal.write(enabled ? ENABLE_MOUSE_REPORTING : DISABLE_MOUSE_REPORTING);
		mouseReporting = enabled;
	};

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
		// Let the terminal handle the rest of the user's wheel/trackpad gesture
		// in its native scrollback rather than sending more events to Pi.
		setMouseReporting(false);
	};
	const resume = () => {
		if (!paused) return;
		paused = false;
		setMouseReporting(active);
		// The differ's previous frame is still the last frame actually painted;
		// resume normally so Pi can append current state without clearing history.
		target.requestRender();
	};

	return {
		setActive(enabled: boolean): void {
			active = enabled;
			if (!paused) setMouseReporting(active);
		},
		handleInput(data: string): ScrollLockInputResult {
			if (isScrollBackInput(data)) {
				pause();
				// Wheel events are only visible while reporting is enabled; consume the
				// first one so the editor never interprets it as an unknown key.
				return SGR_WHEEL_UP.test(data) || legacyWheelDirection(data) === "up"
					? { consume: true }
					: undefined;
			}
			if (paused && isFollowInput(data)) {
				resume();
				return undefined;
			}
			return undefined;
		},
		pause,
		resume,
		isPaused: () => paused,
		dispose(): void {
			paused = false;
			active = false;
			setMouseReporting(false);
			if (target.requestRender === installedRequestRender)
				target.requestRender = originalRequestRender;
			if (target.doRender === installedDoRender)
				target.doRender = originalDoRender;
		},
	};
}
