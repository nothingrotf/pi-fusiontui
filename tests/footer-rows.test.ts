import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	GOAL_STATUS_KEY,
	branchSegment,
	goalSegment,
	renderFooterRows,
	usageSegment,
} from "../extensions/fusion/footer-rows";
import { emptyGitStatus } from "../extensions/fusion/git";
import { createState, type FusionState } from "../extensions/fusion/state";
import type { FooterMode } from "../extensions/fusion/config";
import type { UsageSnapshot } from "../extensions/fusion/usage";

// A theme whose fg() emits a real SGR pair, so the tests exercise the same
// "styled string, zero visible width added" path the TUI takes.
const theme = {
	fg: (color: string, text: string) => `\x1b[38;5;${color.length}m${text}\x1b[39m`,
} as unknown as Pick<Theme, "fg">;

// A theme that throws on every token — `fg` must degrade to plain text rather
// than take the whole footer render down with it.
const hostileTheme = {
	fg: () => {
		throw new Error("unknown color token");
	},
} as unknown as Pick<Theme, "fg">;

const MODES: FooterMode[] = ["full", "minimal", "adaptive"];
const EXPECTED_ROWS: Record<FooterMode, number> = { full: 2, minimal: 1, adaptive: 1 };

function state(overrides: Partial<FusionState> = {}): FusionState {
	return { ...createState("/Users/dev/projects/pi-fusiontui", "full"), ...overrides };
}

const usage: UsageSnapshot = {
	provider: "anthropic",
	windows: [
		{ label: "5h", usedPercent: 3, resetsIn: "3h37m" },
		{ label: "wk", usedPercent: 92, resetsIn: "1d19h" },
	],
};

const busyState = (mode: FooterMode): FusionState =>
	state({
		mode,
		usage,
		contextLabel: "42%/1.0M",
		contextPercent: 42,
		costLabel: "$3.922",
		git: {
			...emptyGitStatus(),
			branch: "feature/some-really-long-branch-name",
			dirty: true,
			modified: 12,
			staged: 3,
			untracked: 7,
			ahead: 2,
			behind: 1,
		},
	});

const statuses = (entries: Record<string, string> = {}): ReadonlyMap<string, string> =>
	new Map(Object.entries(entries));

describe("footer geometry contract", () => {
	// L3-01: the single most-regressed behaviour in this repo (three separate
	// width/wrap fixes). Sweep every width a terminal can plausibly report.
	test("no rendered line ever exceeds the requested width", () => {
		for (const mode of MODES) {
			const s = busyState(mode);
			const ext = statuses({ [GOAL_STATUS_KEY]: "goal: shipping the footer", ci: "CI green" });
			for (let width = 0; width <= 200; width++) {
				const rows = renderFooterRows(theme, s, ext, width);
				for (const line of rows) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}
		}
	});

	// L3-02: a status arriving mid-session must not change the frame height.
	test("row count is fixed per mode, whatever the width or the content", () => {
		const variants: ReadonlyArray<[string, ReadonlyMap<string, string>]> = [
			["empty", statuses()],
			["goal only", statuses({ [GOAL_STATUS_KEY]: "goal: active" })],
			["statuses only", statuses({ ci: "CI green", lsp: "3 diagnostics" })],
			["both", statuses({ [GOAL_STATUS_KEY]: "goal: active", ci: "CI green" })],
		];
		for (const mode of MODES) {
			for (const [name, ext] of variants) {
				for (const width of [0, 1, 2, 3, 10, 40, 80, 200]) {
					const rows = renderFooterRows(theme, busyState(mode), ext, width);
					expect(`${mode}/${name}/${width}: ${rows.length}`).toBe(
						`${mode}/${name}/${width}: ${EXPECTED_ROWS[mode]}`,
					);
				}
				const idle = renderFooterRows(theme, state({ mode }), ext, 80);
				expect(idle.length).toBe(EXPECTED_ROWS[mode]);
			}
		}
	});

	test("never emits an embedded newline, so a row is always one physical line", () => {
		const evil = state({
			mode: "full",
			cwd: "/tmp/a\nb",
			contextLabel: "42%\n/1.0M",
			costLabel: "$1\r\n.000",
			git: { ...emptyGitStatus(), branch: "main\nrogue" },
		});
		const ext = statuses({ [GOAL_STATUS_KEY]: "line1\nline2", other: "x\r\ny" });
		for (const width of [0, 5, 20, 80, 200]) {
			for (const line of renderFooterRows(theme, evil, ext, width)) {
				expect(line).not.toContain("\n");
				expect(line).not.toContain("\r");
			}
		}
	});

	// L3-03: external setStatus() text must not smuggle cursor moves into the frame.
	test("strips terminal control sequences coming from extension statuses", () => {
		const ext = statuses({
			[GOAL_STATUS_KEY]: "\x1b[2Jgoal\x07",
			evil: "\x1b]0;title\x07status\x1b[10A",
		});
		const rows = renderFooterRows(theme, state({ mode: "full" }), ext, 120);
		const joined = rows.join("");
		expect(joined).toContain("goal");
		expect(joined).toContain("status");
		expect(joined).not.toContain("\x1b[2J");
		expect(joined).not.toContain("\x1b[10A");
		expect(joined).not.toContain("\x1b]0;");
		expect(joined).not.toContain("\x07");
	});

	test("degrades to plain text when the theme rejects every color token", () => {
		const rows = renderFooterRows(hostileTheme, busyState("full"), statuses(), 200);
		expect(rows.length).toBe(2);
		expect(rows.join("")).toContain("feature/some-really-long-branch-name");
		expect(rows.join("")).toContain("$3.922");
		for (const line of rows) expect(visibleWidth(line)).toBeLessThanOrEqual(200);
	});

	test("survives a non-finite width instead of throwing", () => {
		for (const width of [Number.NaN, Number.POSITIVE_INFINITY, -10]) {
			const rows = renderFooterRows(theme, busyState("full"), statuses(), width);
			expect(rows.length).toBe(2);
			for (const line of rows) expect(line).toBe("");
		}
	});
});

describe("footer segments", () => {
	test("branch segment renders every porcelain counter with its flag letter", () => {
		const s = state({
			git: {
				...emptyGitStatus(),
				branch: "main",
				dirty: true,
				conflicted: 1,
				staged: 2,
				modified: 3,
				added: 4,
				deleted: 5,
				renamed: 6,
				copied: 7,
				untracked: 8,
				ahead: 9,
				behind: 10,
			},
		});
		const plain = branchSegment(hostileTheme, s);
		expect(plain).toContain("main");
		expect(plain).toContain("[=1 +2 !3 A4 D5 R6 C7 ?8 ↑9 ↓10]");
	});

	test("branch segment is empty without a branch, and flag-free when clean", () => {
		expect(branchSegment(theme, state())).toBe("");
		const clean = branchSegment(hostileTheme, state({
			git: { ...emptyGitStatus(), branch: "main" },
		}));
		expect(clean).toContain("main");
		expect(clean).not.toContain("[");
	});

	test("usage segment clamps out-of-range and non-finite percentages", () => {
		const text = usageSegment(hostileTheme, {
			provider: "anthropic",
			windows: [
				{ label: "lo", usedPercent: -50, resetsIn: "" },
				{ label: "hi", usedPercent: 4000, resetsIn: "" },
				{ label: "nan", usedPercent: Number.NaN, resetsIn: "" },
			],
		});
		expect(text).toContain("lo 0%");
		expect(text).toContain("hi 100%");
		expect(text).toContain("nan 0%");
	});

	test("usage segment is empty without a snapshot or windows", () => {
		expect(usageSegment(theme, null)).toBe("");
		expect(usageSegment(theme, { provider: "anthropic", windows: [] })).toBe("");
	});

	test("goal segment is empty for a missing or blank status", () => {
		expect(goalSegment(theme, statuses())).toBe("");
		expect(goalSegment(theme, statuses({ [GOAL_STATUS_KEY]: "   " }))).toBe("");
	});

	test("goal segment picks its color from the goal wording", () => {
		const tokens: string[] = [];
		const spy = {
			fg: (color: string, text: string) => {
				tokens.push(color);
				return text;
			},
		} as unknown as Pick<Theme, "fg">;
		const colorFor = (text: string): string => {
			tokens.length = 0;
			goalSegment(spy, statuses({ [GOAL_STATUS_KEY]: text }));
			return tokens[0]!;
		};
		expect(colorFor("goal achieved")).toBe("success");
		expect(colorFor("COMPLETE")).toBe("success");
		expect(colorFor("goal paused")).toBe("warning");
		expect(colorFor("needs attention")).toBe("warning");
		expect(colorFor("in progress")).toBe("accent");
	});
});
