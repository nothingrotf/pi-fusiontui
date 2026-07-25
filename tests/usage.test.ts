import { describe, expect, test } from "bun:test";
import {
	fetchUsageForProvider,
	normalizePercent,
	parseClaudeWindows,
	parseCodexWindows,
	withTimeout,
} from "../extensions/fusion/usage";

const HOUR = 3_600_000;
// formatResetIn floors to whole minutes, so a bare offset lands one minute
// short whenever the test takes a few ms. The half-minute cushion keeps the
// expected countdown stable without changing which unit is exercised.
const isoIn = (ms: number): string => new Date(Date.now() + ms + 30_000).toISOString();
// Round UP: flooring would shave the sub-second remainder off and turn a clean
// "3h" countdown into "2h59m".
const unixIn = (ms: number): number => Math.ceil((Date.now() + ms) / 1000);

describe("normalizePercent", () => {
	test("clamps to 0..100 and rejects anything that is not a finite number", () => {
		expect(normalizePercent(42)).toBe(42);
		expect(normalizePercent(-1)).toBe(0);
		expect(normalizePercent(101)).toBe(100);
		expect(normalizePercent(Number.NaN)).toBe(0);
		expect(normalizePercent(Number.POSITIVE_INFINITY)).toBe(0);
		expect(normalizePercent("57")).toBe(0);
		expect(normalizePercent(null)).toBe(0);
		expect(normalizePercent(undefined)).toBe(0);
		expect(normalizePercent({ utilization: 5 })).toBe(0);
	});
});

describe("parseClaudeWindows", () => {
	test("maps the five-hour and seven-day windows in order", () => {
		const windows = parseClaudeWindows({
			five_hour: { utilization: 3, resets_at: isoIn(2 * HOUR + 13 * 60_000) },
			seven_day: { utilization: 92, resets_at: isoIn(30 * HOUR) },
		});
		expect(windows.map((w) => w.label)).toEqual(["5h", "wk"]);
		expect(windows[0]!.usedPercent).toBe(3);
		expect(windows[0]!.resetsIn).toBe("2h13m");
		expect(windows[1]!.usedPercent).toBe(92);
		expect(windows[1]!.resetsIn).toBe("1d6h");
	});

	test("skips a window whose utilization is absent, but keeps utilization 0", () => {
		expect(parseClaudeWindows({ five_hour: { resets_at: isoIn(HOUR) } })).toEqual([]);
		const zero = parseClaudeWindows({ five_hour: { utilization: 0 } });
		expect(zero).toHaveLength(1);
		expect(zero[0]!.usedPercent).toBe(0);
	});

	test("omits the countdown when resets_at is missing or unparseable", () => {
		expect(parseClaudeWindows({ five_hour: { utilization: 5 } })[0]!.resetsIn).toBeUndefined();
		expect(
			parseClaudeWindows({ five_hour: { utilization: 5, resets_at: "not-a-date" } })[0]!.resetsIn,
		).toBeUndefined();
		expect(parseClaudeWindows({ five_hour: { utilization: 5, resets_at: "" } })[0]!.resetsIn)
			.toBeUndefined();
	});

	test("a past reset reads as 'now' rather than a negative countdown", () => {
		const windows = parseClaudeWindows({
			five_hour: { utilization: 5, resets_at: isoIn(-HOUR) },
		});
		expect(windows[0]!.resetsIn).toBe("now");
	});

	test("returns no windows for junk payloads instead of throwing", () => {
		for (const payload of [undefined, null, 0, "", "string", [], { rate_limit: {} }]) {
			expect(parseClaudeWindows(payload)).toEqual([]);
		}
		expect(parseClaudeWindows({ five_hour: "nope", seven_day: 42 })).toEqual([]);
	});
});

describe("parseCodexWindows", () => {
	test("reads reset_at as unix SECONDS, not milliseconds", () => {
		const windows = parseCodexWindows({
			rate_limit: {
				primary_window: { used_percent: 12, reset_at: unixIn(3 * HOUR) },
				secondary_window: { used_percent: 60, reset_at: unixIn(50 * HOUR) },
			},
		});
		expect(windows.map((w) => w.label)).toEqual(["5h", "wk"]);
		expect(windows[0]!.usedPercent).toBe(12);
		expect(windows[0]!.resetsIn).toBe("3h");
		expect(windows[1]!.usedPercent).toBe(60);
		expect(windows[1]!.resetsIn).toBe("2d2h");
	});

	test("emits a window with 0% when the payload omits used_percent", () => {
		const windows = parseCodexWindows({ rate_limit: { primary_window: { reset_at: null } } });
		expect(windows).toHaveLength(1);
		expect(windows[0]!.usedPercent).toBe(0);
		expect(windows[0]!.resetsIn).toBeUndefined();
	});

	test("clamps hostile percentages", () => {
		const windows = parseCodexWindows({
			rate_limit: {
				primary_window: { used_percent: -12 },
				secondary_window: { used_percent: 9001 },
			},
		});
		expect(windows[0]!.usedPercent).toBe(0);
		expect(windows[1]!.usedPercent).toBe(100);
	});

	test("ignores a non-numeric reset_at instead of producing Invalid Date", () => {
		const windows = parseCodexWindows({
			rate_limit: { primary_window: { used_percent: 1, reset_at: "2026-01-01" } },
		});
		expect(windows[0]!.resetsIn).toBeUndefined();
	});

	test("returns no windows for junk payloads instead of throwing", () => {
		for (const payload of [undefined, null, 0, "string", [], {}, { rate_limit: null }]) {
			expect(parseCodexWindows(payload)).toEqual([]);
		}
	});
});

describe("withTimeout", () => {
	test("aborts the work signal once the deadline passes (L2-02)", async () => {
		const aborted = await withTimeout(undefined, 10, (signal) =>
			new Promise<boolean>((resolve) => {
				signal.addEventListener("abort", () => resolve(true), { once: true });
			}));
		expect(aborted).toBe(true);
	});

	test("relays an already-aborted parent immediately", async () => {
		const parent = AbortSignal.abort(new Error("gone"));
		const aborted = await withTimeout(parent, 10_000, (signal) => Promise.resolve(signal.aborted));
		expect(aborted).toBe(true);
	});

	test("relays a parent that aborts mid-flight", async () => {
		const controller = new AbortController();
		const promise = withTimeout(controller.signal, 10_000, (signal) =>
			new Promise<string>((resolve) => {
				signal.addEventListener("abort", () => resolve("relayed"), { once: true });
			}));
		controller.abort(new Error("provider switched"));
		expect(await promise).toBe("relayed");
	});

	test("clears its timer on success, so a resolved call does not keep the loop alive", async () => {
		const started = Date.now();
		expect(await withTimeout(undefined, 60_000, () => Promise.resolve("done"))).toBe("done");
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	test("propagates a rejection from the work function", async () => {
		await expect(withTimeout(undefined, 1_000, () => Promise.reject(new Error("boom"))))
			.rejects.toThrow("boom");
	});
});

describe("fetchUsageForProvider", () => {
	test("returns null for providers without a usage endpoint", () => {
		expect(fetchUsageForProvider(undefined)).toBeNull();
		expect(fetchUsageForProvider("openai")).toBeNull();
		expect(fetchUsageForProvider("google")).toBeNull();
		expect(fetchUsageForProvider("")).toBeNull();
	});

	// Deliberately driven with an already-aborted signal: the mapping is what is
	// under test, and the suite must never touch the real provider APIs.
	test("routes the two supported providers to a fetcher that honours the abort", async () => {
		for (const provider of ["anthropic", "openai-codex"]) {
			const pending = fetchUsageForProvider(provider, AbortSignal.abort(new Error("cancelled")));
			expect(pending).not.toBeNull();
			await expect(pending!).rejects.toThrow();
		}
	});
});
