import { describe, expect, test } from "bun:test";
import { TUI } from "@earendil-works/pi-tui";
import { installScrollLock } from "../extensions/fusion/scroll-lock";

function makeTerminal() {
	const writes: string[] = [];
	return {
		terminal: {
			columns: 20,
			rows: 5,
			write(data: string) { writes.push(data); },
			start() {},
			stop() {},
			drainInput: async () => {},
			moveBy() {},
			hideCursor() {},
			showCursor() {},
			clearLine() {},
			clearFromCursor() {},
			clearScreen() {},
			setTitle() {},
			setProgress() {},
			kittyProtocolActive: false,
		},
		writes,
	};
}

const waitForRender = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

describe("transcript scroll lock", () => {
	test("pauses new frames after PageUp and resumes on PageDown", async () => {
		const { terminal, writes } = makeTerminal();
		const tui = new TUI(terminal);
		let lines = ["old 1", "old 2", "old 3", "old 4", "old 5"];
		tui.addChild({ render: () => lines, invalidate() {} });
		const lock = installScrollLock(tui);

		tui.requestRender(true);
		await waitForRender(5);
		const beforeScroll = writes.length;
		lines = [...lines, "new while reading"];
		tui.requestRender(); // schedule before the user scrolls
		lock.handleInput("\x1b[5~"); // PageUp
		tui.requestRender(true); // agent_end/model changes must remain paused too
		await waitForRender();
		expect(writes.length).toBe(beforeScroll);
		expect(lock.isPaused()).toBe(true);

		lock.handleInput("\x1b[6~"); // PageDown
		await waitForRender(5);
		expect(lock.isPaused()).toBe(false);
		expect(writes.length).toBeGreaterThan(beforeScroll);
		lock.dispose();
	});

	test("recognizes SGR mouse-wheel scroll when a terminal reports it", () => {
		const { terminal } = makeTerminal();
		const tui = new TUI(terminal);
		const lock = installScrollLock(tui);
		lock.setActive(true);
		lock.handleInput("\x1b[<64;10;10M");
		expect(lock.isPaused()).toBe(true);
		lock.resume();
		expect(lock.isPaused()).toBe(false);
		lock.pause();
		expect(lock.isPaused()).toBe(true);
		lock.dispose();
	});

	test("any keystroke resumes a paused view; focus reports do not", async () => {
		const { terminal, writes } = makeTerminal();
		const tui = new TUI(terminal);
		let lines = ["old 1", "old 2"];
		tui.addChild({ render: () => lines, invalidate() {} });
		const lock = installScrollLock(tui);

		tui.requestRender(true);
		await waitForRender(5);
		lock.handleInput("\x1b[5~"); // PageUp pauses
		expect(lock.isPaused()).toBe(true);

		// A bare focus report is noise and must not resume.
		lock.handleInput("\x1b[I");
		expect(lock.isPaused()).toBe(true);

		const beforeType = writes.length;
		lines = [...lines, "typed while paused"];
		lock.handleInput("a"); // any real keystroke resumes
		expect(lock.isPaused()).toBe(false);
		await waitForRender();
		expect(writes.length).toBeGreaterThan(beforeType);
		lock.dispose();
	});

	test("does not enable raw mouse tracking (no native-mouse hijack)", () => {
		const { terminal, writes } = makeTerminal();
		const tui = new TUI(terminal);
		const lock = installScrollLock(tui);
		lock.setActive(true);
		lock.setActive(false);
		expect(writes.some((w) => w.includes("\x1b[?1000h"))).toBe(false);
		lock.dispose();
	});
});
