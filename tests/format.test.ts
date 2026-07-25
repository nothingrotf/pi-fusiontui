import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildContextLabel,
	contextPercent,
	formatCount,
	getUsageTotals,
	prettyEffort,
	prettyModel,
} from "../extensions/fusion/format";

describe("formatCount", () => {
	test("scales through the plain / k / M bands", () => {
		expect(formatCount(0)).toBe("0");
		expect(formatCount(999)).toBe("999");
		expect(formatCount(1000)).toBe("1.0k");
		expect(formatCount(1234)).toBe("1.2k");
		expect(formatCount(9999)).toBe("10.0k");
		expect(formatCount(10_000)).toBe("10k");
		expect(formatCount(200_000)).toBe("200k");
		expect(formatCount(1_000_000)).toBe("1.0M");
		expect(formatCount(1_500_000)).toBe("1.5M");
		expect(formatCount(10_000_000)).toBe("10M");
	});

	test("rounds rather than truncating below 1k", () => {
		expect(formatCount(12.4)).toBe("12");
		expect(formatCount(12.6)).toBe("13");
	});

	// L2-04: a bad number must never reach the footer as "NaN".
	test("renders -- for negative and non-finite input", () => {
		for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			expect(formatCount(value)).toBe("--");
		}
	});
});

describe("prettyModel", () => {
	test("strips the vendor prefix and title-cases the rest", () => {
		expect(prettyModel("claude-opus-4-8")).toBe("Opus 4.8");
		expect(prettyModel("grok-composer-2.5-fast")).toBe("Composer 2.5 Fast");
		expect(prettyModel("gpt-5-codex")).toBe("5 Codex");
		expect(prettyModel("gemini-pro")).toBe("Pro");
	});

	test("keeps only the last path segment of a namespaced id", () => {
		expect(prettyModel("anthropic/claude-sonnet-4-5")).toBe("Sonnet 4.5");
	});

	test("merges consecutive number groups into one dotted version", () => {
		expect(prettyModel("claude-haiku-4-5-1")).toBe("Haiku 4.5.1");
		expect(prettyModel("model-4-turbo-5")).toBe("Model 4 Turbo 5");
	});

	test("falls back to no-model for missing or blank ids", () => {
		expect(prettyModel(undefined)).toBe("no-model");
		expect(prettyModel("")).toBe("no-model");
		expect(prettyModel("   ")).toBe("no-model");
	});

	test("strips terminal controls out of the model id", () => {
		expect(prettyModel("\x1b[31mclaude-opus-4\x1b[0m")).toBe("Opus 4");
	});
});

describe("prettyEffort", () => {
	test("title-cases the ordinary levels and special-cases xhigh/max", () => {
		expect(prettyEffort("low")).toBe("Low");
		expect(prettyEffort("medium")).toBe("Medium");
		expect(prettyEffort("HIGH")).toBe("High");
		expect(prettyEffort("xhigh")).toBe("XHigh");
		expect(prettyEffort("max")).toBe("Max");
	});

	test("renders nothing for off, missing or blank levels", () => {
		expect(prettyEffort("off")).toBe("");
		expect(prettyEffort("OFF")).toBe("");
		expect(prettyEffort(undefined)).toBe("");
		expect(prettyEffort("  ")).toBe("");
	});
});

const assistant = (usage: unknown) => ({
	type: "message",
	message: { role: "assistant", usage },
});

const ctxWith = (entries: unknown[], extra: Record<string, unknown> = {}) =>
	({
		sessionManager: { getEntries: () => entries, getBranch: () => entries },
		getContextUsage: () => undefined,
		...extra,
	}) as unknown as ExtensionContext;

describe("getUsageTotals", () => {
	test("sums tokens and cost across every assistant message", () => {
		const totals = getUsageTotals(
			ctxWith([
				assistant({ input: 10, output: 5, cacheRead: 1, cacheWrite: 2, cost: { total: 0.5 } }),
				assistant({ input: 20, output: 7, cacheRead: 3, cacheWrite: 4, cost: { total: 1.25 } }),
			]),
		);
		expect(totals).toEqual({ input: 30, output: 12, cacheRead: 4, cacheWrite: 6, cost: 1.75 });
	});

	test("ignores non-assistant entries and non-message entries", () => {
		const totals = getUsageTotals(
			ctxWith([
				{ type: "message", message: { role: "user", usage: { input: 999 } } },
				{ type: "tool", message: { role: "assistant", usage: { input: 999 } } },
				assistant({ input: 1 }),
			]),
		);
		expect(totals.input).toBe(1);
	});

	test("treats missing and non-finite usage fields as zero", () => {
		const totals = getUsageTotals(
			ctxWith([
				assistant(undefined),
				assistant({ input: Number.NaN, output: "12", cost: { total: Number.POSITIVE_INFINITY } }),
				assistant({ input: 4 }),
			]),
		);
		expect(totals).toEqual({ input: 4, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
	});

	test("falls back to getBranch when getEntries is unavailable", () => {
		const ctx = {
			sessionManager: { getBranch: () => [assistant({ input: 7 })] },
		} as unknown as ExtensionContext;
		expect(getUsageTotals(ctx).input).toBe(7);
	});

	test("returns zeroes for an empty session", () => {
		expect(getUsageTotals(ctxWith([]))).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
		});
	});
});

const ctxUsage = (usage: unknown, contextWindow?: number) =>
	({
		sessionManager: { getEntries: () => [], getBranch: () => [] },
		getContextUsage: () => usage,
		model: contextWindow === undefined ? undefined : { contextWindow },
	}) as unknown as ExtensionContext;

describe("buildContextLabel", () => {
	test("formats percent over the abbreviated window size", () => {
		expect(buildContextLabel(ctxUsage({ percent: 42 }, 200_000))).toBe("42%/200k");
		expect(buildContextLabel(ctxUsage({ percent: 7.4 }, 1_000_000))).toBe("7%/1.0M");
	});

	test("takes the window from the usage payload when the model omits it", () => {
		expect(buildContextLabel(ctxUsage({ percent: 50, contextWindow: 8000 }))).toBe("50%/8.0k");
	});

	// L2-04: never surface NaN% or a negative percentage.
	test("renders ? for an unknown percent and clamps absurd ones", () => {
		expect(buildContextLabel(ctxUsage({ percent: null }, 1000))).toBe("?/1.0k");
		expect(buildContextLabel(ctxUsage({ percent: Number.NaN }, 1000))).toBe("?/1.0k");
		expect(buildContextLabel(ctxUsage({ percent: -20 }, 1000))).toBe("0%/1.0k");
		expect(buildContextLabel(ctxUsage({ percent: 5000 }, 1000))).toBe("999%/1.0k");
	});

	test("renders -- when the window is missing or unusable", () => {
		expect(buildContextLabel(ctxUsage(undefined, 1000))).toBe("--");
		expect(buildContextLabel(ctxUsage({ percent: 10 }))).toBe("--");
		expect(buildContextLabel(ctxUsage({ percent: 10 }, 0))).toBe("--");
		expect(buildContextLabel(ctxUsage({ percent: 10 }, Number.NaN))).toBe("--");
	});
});

describe("contextPercent", () => {
	test("passes a finite percent through, unclamped", () => {
		expect(contextPercent(ctxUsage({ percent: 0 }))).toBe(0);
		expect(contextPercent(ctxUsage({ percent: 42.5 }))).toBe(42.5);
	});

	test("returns null when the percent is unknown or non-finite", () => {
		expect(contextPercent(ctxUsage(undefined))).toBeNull();
		expect(contextPercent(ctxUsage({ percent: null }))).toBeNull();
		expect(contextPercent(ctxUsage({ percent: Number.NaN }))).toBeNull();
	});
});
