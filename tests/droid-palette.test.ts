import { afterEach, describe, expect, test } from "bun:test";
import {
	DROID,
	ansiIn,
	bold,
	hex,
	resolveColorMode,
	setPaletteThemeProvider,
	syncPalette,
	type ColorEnvironment,
} from "../extensions/fusion/droid-palette";

afterEach(() => {
	setPaletteThemeProvider(undefined);
	syncPalette(true);
});

const env = (overrides: Partial<ColorEnvironment> = {}): ColorEnvironment => ({
	noColor: false,
	term: "xterm-256color",
	trueColor: false,
	...overrides,
});

describe("resolveColorMode", () => {
	test("NO_COLOR and TERM=dumb win over every capability", () => {
		expect(resolveColorMode(env({ noColor: true, trueColor: true }))).toBe("plain");
		expect(resolveColorMode(env({ term: "dumb", trueColor: true }))).toBe("plain");
	});

	test("truecolor capability beats the theme and TERM hints", () => {
		expect(resolveColorMode(env({ trueColor: true, themeMode: "256color" }))).toBe("truecolor");
		expect(resolveColorMode(env({ trueColor: true, term: "xterm-16color" }))).toBe("truecolor");
	});

	test("falls back to 256 colors when the theme asks for it", () => {
		expect(resolveColorMode(env({ themeMode: "256color" }))).toBe("256color");
	});

	test("degrades to 16 colors for a 16color/ansi TERM", () => {
		expect(resolveColorMode(env({ term: "xterm-16color" }))).toBe("16color");
		expect(resolveColorMode(env({ term: "ansi" }))).toBe("16color");
		expect(resolveColorMode(env({ term: "SCREEN-16COLOR" }))).toBe("16color");
	});

	test("defaults to 256 colors for an unknown terminal", () => {
		expect(resolveColorMode(env({ term: "" }))).toBe("256color");
		expect(resolveColorMode(env({ term: "screen" }))).toBe("256color");
	});
});

describe("ansiIn", () => {
	test("emits a 24-bit sequence in truecolor, foreground and background", () => {
		expect(ansiIn("#123456", false, "truecolor")).toBe("\x1b[38;2;18;52;86m");
		expect(ansiIn("#123456", true, "truecolor")).toBe("\x1b[48;2;18;52;86m");
	});

	test("emits an indexed sequence in 256-color mode", () => {
		expect(ansiIn("#000000", false, "256color")).toBe("\x1b[38;5;0m");
		expect(ansiIn("#ffffff", false, "256color")).toBe("\x1b[38;5;15m");
		expect(ansiIn("#ffffff", true, "256color")).toBe("\x1b[48;5;15m");
		// Nearest-match, not a lookup table: an off-palette color still resolves.
		expect(ansiIn("#5f8700", false, "256color")).toBe("\x1b[38;5;64m");
	});

	test("maps to the basic and bright ANSI ranges in 16-color mode", () => {
		expect(ansiIn("#000000", false, "16color")).toBe("\x1b[30m");
		expect(ansiIn("#ff0000", false, "16color")).toBe("\x1b[91m");
		expect(ansiIn("#ff0000", true, "16color")).toBe("\x1b[101m");
	});

	test("emits nothing in plain mode or for a malformed color", () => {
		expect(ansiIn("#123456", false, "plain")).toBe("");
		for (const mode of ["truecolor", "256color", "16color"] as const) {
			expect(ansiIn("not-a-color", false, mode)).toBe("");
			expect(ansiIn("#12345", false, mode)).toBe("");
			expect(ansiIn("", false, mode)).toBe("");
		}
	});

	test("accepts upper-case hex", () => {
		expect(ansiIn("#AABBCC", false, "truecolor")).toBe("\x1b[38;2;170;187;204m");
	});
});

describe("hex / bold", () => {
	test("wraps the text and always closes the color it opened", () => {
		const out = hex("#123456", "Execute");
		expect(out).toContain("Execute");
		if (out !== "Execute") expect(out.endsWith("\x1b[39m")).toBe(true);
	});

	test("returns the text untouched for a malformed color", () => {
		expect(hex("nope", "Execute")).toBe("Execute");
	});

	test("bold opens 1 and closes 22, not a full reset", () => {
		expect(bold("x")).toBe("\x1b[1mx\x1b[22m");
	});
});

describe("syncPalette", () => {
	const rgb = (value: string): string => {
		const [r, g, b] = value.match(/[0-9a-f]{2}/gi)!.map((part) => parseInt(part, 16));
		return `\x1b[38;2;${r};${g};${b}m`;
	};

	test("pulls every DROID token from the active theme", () => {
		setPaletteThemeProvider(() => ({
			getFgAnsi: (token: string) => rgb(token === "accent" ? "#abcdef" : "#010203"),
			getBgAnsi: () => rgb("#0a0b0c"),
		} as never));
		syncPalette(true);
		expect(DROID.primary).toBe("#abcdef");
		expect(DROID.userSymbol).toBe("#abcdef");
		expect(DROID.toolName).toBe("#010203");
	});

	test("keeps the traced factory-dark fallback when the theme throws", () => {
		setPaletteThemeProvider(() => ({
			getFgAnsi: () => {
				throw new Error("no such token");
			},
			getBgAnsi: () => {
				throw new Error("no such token");
			},
		} as never));
		syncPalette(true);
		for (const value of Object.values(DROID)) {
			expect(value).toMatch(/^#[0-9a-f]{6}$/i);
		}
	});

	test("falls back cleanly when there is no theme provider at all", () => {
		setPaletteThemeProvider(undefined);
		syncPalette(true);
		expect(DROID.primary).toMatch(/^#[0-9a-f]{6}$/i);
	});
});
