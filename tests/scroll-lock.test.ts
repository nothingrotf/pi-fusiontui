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
});
