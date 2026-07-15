import { describe, expect, test } from "bun:test";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { normalizeSoundValue } from "../extensions/fusion/sound";
import { formatCwd, formatResetIn } from "../extensions/fusion/format";
import { parsePorcelain } from "../extensions/fusion/git";
import { deriveActivity } from "../extensions/fusion/state";
import { renderBar } from "../extensions/fusion/theme";
import { FocusInputParser } from "../extensions/fusion/input";
import {
	DROID,
	patchToolFallbacks,
	resetDroidSession,
	setPaletteThemeProvider,
	syncPalette,
	unpatchToolFallbacks,
} from "../extensions/fusion/droid";
import {
	boundedLines,
	linesFitWidth,
	sanitizeScalar,
	sanitizeStyledLine,
} from "../extensions/fusion/render-safe";

const theme = { fg: (_color: string, text: string) => text };

describe("safe boundary primitives", () => {
	test("rejects unknown/non-absolute sound values", () => {
		expect(normalizeSoundValue("fx-ok01")).toBe("fx-ok01");
		expect(normalizeSoundValue("not-a-sound")).toBeNull();
		expect(normalizeSoundValue("relative.wav")).toBeNull();
		expect(normalizeSoundValue("\n\x1b[2Jbell")).toBeNull();
	});

	test("formats home paths only at a directory boundary", () => {
		const before = process.env.HOME;
		process.env.HOME = "/home/alice";
		try {
			expect(formatCwd("/home/alice/project/src")).toBe("~/project/src");
			expect(formatCwd("/home/alice2/project")).toBe("…/alice2/project");
		} finally {
			if (before === undefined) delete process.env.HOME;
			else process.env.HOME = before;
		}
	});

	test("normalizes invalid dates and progress widths", () => {
		expect(formatResetIn(new Date(Number.NaN))).toBe("now");
		expect(renderBar(theme, Number.NaN, Number.NaN)).toBe("");
		expect(renderBar(theme, 50, -2)).toBe("");
		expect(() => renderBar(theme, 50, Number.POSITIVE_INFINITY)).not.toThrow();
	});

	test("counts complete porcelain XY categories", () => {
		const result = parsePorcelain([
			"# branch.head main",
			"# branch.ab +2 -1",
			"1 M. N... 100644 100644 100644 abc def file.ts",
			"1 .D N... 100644 100644 000000 abc 000 file-old.ts",
			"1 A. N... 000000 100644 100644 000 abc file-new.ts",
			"2 R. N... 100644 100644 100644 abc def 42 file-new.ts\tfile-old.ts",
			"? scratch.txt",
			"u UU N... 100644 100644 100644 100644 a b c d conflict.ts",
		].join("\n"));
		expect(result.branch).toBe("main");
		expect(result.ahead).toBe(2);
		expect(result.behind).toBe(1);
		expect(result.modified).toBe(1);
		expect(result.deleted).toBe(1);
		expect(result.added).toBe(1);
		expect(result.renamed).toBe(1);
		expect(result.untracked).toBe(1);
		expect(result.conflicted).toBe(1);
	});
});

describe("coherent activity and input", () => {
	test("pending asks win over ordinary tool phases", () => {
		expect(deriveActivity(new Set(["ask-1"]), "invoking")).toEqual({
			agent: "awaiting",
			workingLabel: "Waiting for your input...",
		});
		expect(deriveActivity(new Set(), "generating").agent).toBe("working");
		expect(deriveActivity(new Set(), "idle")).toEqual({ agent: "idle", workingLabel: "" });
	});

	test("removes grouped and split focus sequences while preserving text", () => {
		const focused: boolean[] = [];
		const parser = new FocusInputParser((value) => focused.push(value));
		expect(parser.parse("a\x1b[Ib\x1b[O")).toEqual({ data: "ab" });
		expect(focused).toEqual([true, false]);
		expect(parser.parse("x\x1b")).toEqual({ data: "x" });
		expect(parser.parse("[I" )).toEqual({ consume: true });
		expect(focused).toEqual([true, false, true]);
	});
});

describe("Fusion composer palette", () => {
	test("resolves the idle border from the active accent color", () => {
		const rgb = (value: string): string => {
			const [r, g, b] = value.match(/[0-9a-f]{2}/gi)!.map((part) => parseInt(part, 16));
			return `\x1b[38;2;${r};${g};${b}m`;
		};
		const colors: Record<string, string> = {
			accent: "#123456",
			border: "#654321",
			borderMuted: "#111111",
			warning: "#abcdef",
		};
		setPaletteThemeProvider(() => ({
			getFgAnsi: (token: string) => rgb(colors[token] ?? "#010203"),
		} as never));
		try {
			syncPalette(true);
			expect(DROID.borderIdle).toBe(colors.accent);
			expect(DROID.borderWorking).toBe(colors.borderMuted);
			expect(DROID.borderAwaiting).toBe(colors.warning);
		} finally {
			setPaletteThemeProvider(undefined);
		}
	});
});

describe("Fusion transcript skin", () => {
	test("keeps Edit cards out of Pi's default background box", () => {
		patchToolFallbacks();
		try {
			const component = new ToolExecutionComponent(
				"edit",
				"edit-test",
				{ path: "/tmp/example.ts", old_string: "old", new_string: "new" },
				{},
				undefined,
				{ requestRender() {} } as never,
				process.cwd(),
			);
			component.updateResult({
				content: [{ type: "text", text: "" }],
				details: { diff: "@@ -1 +1 @@\\n-old\\n+new" },
			});
			const rendered = component.render(80).join("\\n");
			expect((component as unknown as { getRenderShell(): string }).getRenderShell()).toBe("self");
			expect(rendered).toContain("Edit");
			expect(rendered).toContain("Succeeded. File edited.");
			expect(rendered).toContain("+new");
			expect(rendered).not.toContain("\\x1b[48;");
			expect(rendered).not.toContain("╭");
		} finally {
			unpatchToolFallbacks();
			resetDroidSession();
		}
	});
});

describe("render safety", () => {
	test("strips physical controls but preserves approved styling", () => {
		expect(sanitizeScalar("ok\n\tvalue\x1b[2J")).toBe("ok value");
		const styled = "\x1b[38;2;1;2;3mtext\x1b[39m\x1b[2J";
		expect(sanitizeStyledLine(styled)).toBe("\x1b[38;2;1;2;3mtext\x1b[39m");
	});

	test("bounds expansion with a continuation marker", () => {
		const result = boundedLines(["a", "b", "c", "d"], 3, (hidden) => `... ${hidden} more`);
		expect(result).toEqual(["a", "b", "... 2 more"]);
		expect(linesFitWidth(result, 20)).toBe(true);
	});
});
