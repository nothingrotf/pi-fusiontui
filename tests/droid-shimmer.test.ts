import { afterEach, describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	ensureShimmerRepaint,
	finishShimmer,
	isToolFinished,
	markToolFinished,
	resetDroidSession,
	shimmerText,
	stopAllShimmers,
	subscribeTicker,
	tickerTick,
} from "../extensions/fusion/droid-shimmer";

afterEach(() => {
	resetDroidSession();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("shimmerText", () => {
	test("preserves the text and its visible width, only adding color", () => {
		for (const tick of [0, 1, 7, 19, 20, 4001]) {
			const out = shimmerText("Execute", "#808080", tick);
			expect(stripAnsi(out)).toBe("Execute");
			expect(visibleWidth(out)).toBe(visibleWidth("Execute"));
		}
	});

	// L4-10: splitting by code unit tore emoji and combining marks apart.
	test("does not split grapheme clusters", () => {
		for (const text of ["🐴 ponytail", "e\u0301tape", "👨‍👩‍👧 family", "日本語"]) {
			const out = shimmerText(text, "#808080", 5);
			expect(stripAnsi(out)).toBe(text);
		}
	});

	test("sweeps: the highlight lands on different characters as the tick advances", () => {
		const frames = new Set<string>();
		for (let tick = 0; tick < 20; tick++) frames.add(shimmerText("Execute", "#808080", tick));
		expect(frames.size).toBeGreaterThan(1);
	});

	test("is periodic over 20 ticks (droid hD0)", () => {
		expect(shimmerText("Execute", "#808080", 3)).toBe(shimmerText("Execute", "#808080", 23));
	});

	test("handles an empty string and a single character", () => {
		expect(stripAnsi(shimmerText("", "#808080", 0))).toBe("");
		expect(stripAnsi(shimmerText("x", "#808080", 0))).toBe("x");
	});
});

describe("finished latching", () => {
	test("markToolFinished latches, and reset clears the latch", () => {
		expect(isToolFinished("call-1")).toBe(false);
		markToolFinished("call-1");
		expect(isToolFinished("call-1")).toBe(true);
		resetDroidSession();
		expect(isToolFinished("call-1")).toBe(false);
	});

	// L4-06: a plain Set retained every historical tool id for the whole session.
	test("the latch set is bounded, evicting the oldest ids", () => {
		for (let i = 0; i < 2100; i++) finishShimmer(`call-${i}`);
		expect(isToolFinished("call-2099")).toBe(true);
		expect(isToolFinished("call-0")).toBe(false);
	});
});

describe("ensureShimmerRepaint", () => {
	test("repaints roughly every other tick while the call runs", async () => {
		let repaints = 0;
		ensureShimmerRepaint("call-a", () => repaints++);
		await sleep(260);
		expect(repaints).toBeGreaterThan(0);
		expect(repaints).toBeLessThanOrEqual(4);
	});

	test("subscribes at most once per tool call", async () => {
		let repaints = 0;
		for (let i = 0; i < 5; i++) ensureShimmerRepaint("call-b", () => repaints++);
		await sleep(260);
		expect(repaints).toBeLessThanOrEqual(4);
	});

	test("is a no-op for an already-finished call", async () => {
		markToolFinished("call-c");
		let repaints = 0;
		ensureShimmerRepaint("call-c", () => repaints++);
		await sleep(160);
		expect(repaints).toBe(0);
	});

	test("stops repainting once the call latches done", async () => {
		let repaints = 0;
		ensureShimmerRepaint("call-d", () => repaints++);
		await sleep(160);
		finishShimmer("call-d");
		const settled = repaints;
		await sleep(200);
		expect(repaints).toBe(settled);
	});

	test("stopAllShimmers halts every active loop and latches them finished", async () => {
		let repaints = 0;
		ensureShimmerRepaint("call-e", () => repaints++);
		ensureShimmerRepaint("call-f", () => repaints++);
		await sleep(120);
		stopAllShimmers();
		const settled = repaints;
		expect(isToolFinished("call-e")).toBe(true);
		expect(isToolFinished("call-f")).toBe(true);
		await sleep(200);
		expect(repaints).toBe(settled);
	});
});

describe("ticker", () => {
	test("advances while subscribed and stops when the last listener leaves", async () => {
		const unsubscribe = subscribeTicker(() => {});
		const start = tickerTick();
		await sleep(160);
		const running = tickerTick();
		expect(running).toBeGreaterThan(start);
		unsubscribe();
		await sleep(160);
		expect(tickerTick()).toBe(running);
	});

	// A listener that unsubscribes from inside its own callback used to be
	// visited again mid-tick while the live Set was being iterated (OOM loop).
	test("a listener may unsubscribe from inside its own callback", async () => {
		let calls = 0;
		const unsubscribe = subscribeTicker(() => {
			calls++;
			unsubscribe();
		});
		await sleep(200);
		expect(calls).toBe(1);
	});
});
