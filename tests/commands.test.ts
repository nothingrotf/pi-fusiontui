import { describe, expect, test } from "bun:test";
import {
	choiceValue,
	focusChoices,
	isAskTool,
	isFocusMode,
	parseSoundCommand,
	soundChoices,
	soundCompletions,
	type SoundCommand,
} from "../extensions/fusion/commands";
import { BUILTIN_SOUNDS, SOUND_FOCUS_MODES } from "../extensions/fusion/sound";

describe("isAskTool", () => {
	test("matches the ask-style tool names that mean 'awaiting your input'", () => {
		for (const name of [
			"ask",
			"ask_user",
			"ask_user_question",
			"askuser",
			"AskUserQuestion",
			"mcp__thing__ask_user",
			"clarifying_question",
			"QUESTION",
		]) {
			expect(`${name}:${isAskTool(name)}`).toBe(`${name}:true`);
		}
	});

	test("does not fire on unrelated tool names", () => {
		for (const name of ["bash", "read", "task", "basket", "flask", "grep", ""]) {
			expect(`${name}:${isAskTool(name)}`).toBe(`${name}:false`);
		}
	});
});

describe("parseSoundCommand", () => {
	const parse = (args: string): SoundCommand => parseSoundCommand(args);

	test("no arguments opens the completion picker", () => {
		expect(parse("")).toEqual({ kind: "pickCompletion" });
		expect(parse("   ")).toEqual({ kind: "pickCompletion" });
	});

	test("'test' previews, case-insensitively", () => {
		expect(parse("test")).toEqual({ kind: "preview" });
		expect(parse("  TEST  ")).toEqual({ kind: "preview" });
	});

	test("'ask' with a value sets the awaiting sound, without one opens the picker", () => {
		expect(parse("ask bell")).toEqual({ kind: "setAwaiting", value: "bell" });
		expect(parse("ASK fx-ack01")).toEqual({ kind: "setAwaiting", value: "fx-ack01" });
		expect(parse("ask")).toEqual({ kind: "pickAwaiting" });
		expect(parse("ask   ")).toEqual({ kind: "pickAwaiting" });
	});

	test("'focus' accepts only known modes, anything else opens the picker", () => {
		for (const mode of SOUND_FOCUS_MODES) {
			expect(parse(`focus ${mode}`)).toEqual({ kind: "setFocus", mode });
			expect(parse(`focus ${mode.toUpperCase()}`)).toEqual({ kind: "setFocus", mode });
		}
		expect(parse("focus")).toEqual({ kind: "pickFocus" });
		expect(parse("focus sideways")).toEqual({ kind: "pickFocus" });
	});

	test("a bare value sets the completion sound", () => {
		expect(parse("off")).toEqual({ kind: "setCompletion", value: "off" });
		for (const id of BUILTIN_SOUNDS) {
			expect(parse(id)).toEqual({ kind: "setCompletion", value: id });
		}
	});

	// Lower-casing the value here would break paths on a case-sensitive FS.
	test("passes an absolute path through verbatim, case intact", () => {
		expect(parse("/Users/Dev/Sounds/Ping.wav")).toEqual({
			kind: "setCompletion",
			value: "/Users/Dev/Sounds/Ping.wav",
		});
		expect(parse("  /tmp/a.wav  ")).toEqual({ kind: "setCompletion", value: "/tmp/a.wav" });
	});

	test("keeps spaces inside an awaiting-sound path", () => {
		expect(parse("ask /tmp/my sound.wav")).toEqual({
			kind: "setAwaiting",
			value: "/tmp/my sound.wav",
		});
	});
});

describe("pickers", () => {
	test("sound choices list every id and mark exactly the current one", () => {
		const rows = soundChoices("bell");
		expect(rows).toHaveLength(2 + BUILTIN_SOUNDS.length);
		expect(rows.filter((row) => row.includes("(current)"))).toHaveLength(1);
		expect(rows.find((row) => row.startsWith("bell "))).toContain("(current)");
	});

	test("no row is marked current when the value is a custom path", () => {
		expect(soundChoices("/tmp/custom.wav").filter((r) => r.includes("(current)"))).toEqual([]);
	});

	test("focus choices cover every mode with its description", () => {
		const rows = focusChoices();
		expect(rows).toHaveLength(SOUND_FOCUS_MODES.length);
		for (const mode of SOUND_FOCUS_MODES) {
			expect(rows.some((row) => row.startsWith(`${mode} —`))).toBe(true);
		}
	});

	// The picker returns the whole row; only the leading id must survive.
	test("choiceValue round-trips every picker row back to its id", () => {
		for (const row of soundChoices("off")) {
			expect(row.startsWith(`${choiceValue(row)} `)).toBe(true);
		}
		for (const row of focusChoices()) {
			expect(isFocusMode(choiceValue(row))).toBe(true);
		}
	});

	test("choiceValue is empty for a cancelled pick", () => {
		expect(choiceValue(undefined)).toBe("");
		expect(choiceValue(null)).toBe("");
		expect(choiceValue("")).toBe("");
		expect(choiceValue("   ")).toBe("");
	});
});

describe("soundCompletions", () => {
	test("offers every sound id plus the three subcommands", () => {
		const values = soundCompletions("").map((option) => option.value);
		expect(values).toEqual(["off", "bell", ...BUILTIN_SOUNDS, "ask", "focus", "test"]);
	});

	test("filters by prefix, case-insensitively", () => {
		expect(soundCompletions("f").map((o) => o.value)).toEqual([...BUILTIN_SOUNDS, "focus"]);
		expect(soundCompletions("FX").map((o) => o.value)).toEqual([...BUILTIN_SOUNDS]);
		expect(soundCompletions("foc").map((o) => o.value)).toEqual(["focus"]);
		expect(soundCompletions(" a ").map((o) => o.value)).toEqual(["ask"]);
		expect(soundCompletions("zzz")).toEqual([]);
	});

	test("every completion carries a label", () => {
		for (const option of soundCompletions("")) expect(option.label.length).toBeGreaterThan(0);
	});
});
