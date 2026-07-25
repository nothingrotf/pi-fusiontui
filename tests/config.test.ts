import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_CONFIG,
	FOOTER_MODES,
	loadConfigFrom,
	nextMode,
	readRawFrom,
	saveConfigTo,
	type FooterMode,
} from "../extensions/fusion/config";

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fusiontui-config-"));
	path = join(dir, "fusiontui.json");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const write = (contents: string) => writeFileSync(path, contents);
const read = () => JSON.parse(readFileSync(path, "utf8"));

describe("nextMode", () => {
	test("cycles through every mode and wraps around", () => {
		let mode: FooterMode = "full";
		const seen: FooterMode[] = [mode];
		for (let i = 0; i < FOOTER_MODES.length - 1; i++) {
			mode = nextMode(mode);
			seen.push(mode);
		}
		expect(new Set(seen).size).toBe(FOOTER_MODES.length);
		expect(nextMode(mode)).toBe("full");
	});
});

describe("readRawFrom", () => {
	test("returns {} for a missing file, invalid JSON, or a non-object document", () => {
		expect(readRawFrom(join(dir, "absent.json"))).toEqual({});
		write("{ not json");
		expect(readRawFrom(path)).toEqual({});
		write("null");
		expect(readRawFrom(path)).toEqual({});
		write('"a string"');
		expect(readRawFrom(path)).toEqual({});
		write("[1, 2, 3]");
		expect(readRawFrom(path)).toEqual({});
	});

	test("returns the parsed object when the file is a JSON object", () => {
		write('{"mode":"minimal","extra":1}');
		expect(readRawFrom(path)).toEqual({ mode: "minimal", extra: 1 });
	});
});

describe("loadConfigFrom", () => {
	test("falls back to every default when the file is absent", () => {
		expect(loadConfigFrom(join(dir, "absent.json"))).toEqual(DEFAULT_CONFIG);
	});

	test("keeps valid fields and defaults the invalid ones", () => {
		write(JSON.stringify({
			mode: "minimal",
			completionSound: "bell",
			awaitingInputSound: "not-a-sound",
			soundFocusMode: "sideways",
		}));
		expect(loadConfigFrom(path)).toEqual({
			mode: "minimal",
			completionSound: "bell",
			awaitingInputSound: DEFAULT_CONFIG.awaitingInputSound,
			soundFocusMode: DEFAULT_CONFIG.soundFocusMode,
		});
	});

	// L1-01: an invalid value must be reported, not silently swallowed.
	test("warns once per present-but-invalid field, and never for absent ones", () => {
		write(JSON.stringify({ mode: "sideways", soundFocusMode: 7 }));
		const warned: string[] = [];
		loadConfigFrom(path, (field) => warned.push(field));
		expect(warned.sort()).toEqual(["mode", "soundFocusMode"]);
	});

	test("does not warn when every present field is valid", () => {
		write(JSON.stringify({ mode: "adaptive", completionSound: "off" }));
		const warned: string[] = [];
		expect(loadConfigFrom(path, (field) => warned.push(field)).mode).toBe("adaptive");
		expect(warned).toEqual([]);
	});

	test("rejects a relative custom sound path but accepts a real absolute file", () => {
		const wav = join(dir, "custom.wav");
		writeFileSync(wav, "RIFF");
		write(JSON.stringify({ completionSound: "sounds/custom.wav", awaitingInputSound: wav }));
		const config = loadConfigFrom(path);
		expect(config.completionSound).toBe(DEFAULT_CONFIG.completionSound);
		expect(config.awaitingInputSound).toBe(wav);
	});

	test("rejects an absolute path that is a directory or does not exist", () => {
		write(JSON.stringify({ completionSound: dir, awaitingInputSound: join(dir, "nope.wav") }));
		expect(loadConfigFrom(path)).toEqual(DEFAULT_CONFIG);
	});
});

describe("saveConfigTo", () => {
	test("creates the directory and writes a config that reads back", () => {
		const nested = join(dir, "deep", "nested", "fusiontui.json");
		saveConfigTo(nested, { mode: "minimal" });
		expect(loadConfigFrom(nested).mode).toBe("minimal");
	});

	// L1-02: another extension's keys in the same file must survive our writes.
	test("preserves unknown keys and untouched fields across a partial patch", () => {
		write(JSON.stringify({ mode: "full", soundFocusMode: "focused", theirKey: { a: 1 } }));
		saveConfigTo(path, { mode: "adaptive" });
		expect(read()).toEqual({ mode: "adaptive", soundFocusMode: "focused", theirKey: { a: 1 } });
	});

	test("leaves no temp file behind and writes trailing-newline JSON", () => {
		saveConfigTo(path, { mode: "minimal" });
		expect(readdirSync(dir)).toEqual(["fusiontui.json"]);
		expect(readFileSync(path, "utf8").endsWith("}\n")).toBe(true);
	});

	test("preserves the existing file permissions instead of resetting them", () => {
		write("{}");
		chmodSync(path, 0o600);
		saveConfigTo(path, { mode: "minimal" });
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	// writeFileSync's `mode` is filtered by the process umask (022 here), so the
	// explicit chmod is what actually restores a group-writable config.
	test("restores permissions the umask would otherwise strip", () => {
		write("{}");
		chmodSync(path, 0o664);
		saveConfigTo(path, { mode: "minimal" });
		expect((statSync(path).mode & 0o777).toString(8)).toBe("664");
	});

	test("a rejected write leaves the previous config intact and cleans up", () => {
		write(JSON.stringify({ mode: "minimal" }));
		const before = readFileSync(path, "utf8");
		// A directory cannot be renamed over by a file write — forces the catch.
		const blocked = join(dir, "blocked");
		saveConfigTo(blocked, { mode: "adaptive" });
		saveConfigTo(join(blocked, "..", "..", "\0bad"), { mode: "adaptive" });
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
	});

	test("round-trips every footer mode", () => {
		for (const mode of FOOTER_MODES) {
			saveConfigTo(path, { mode });
			expect(loadConfigFrom(path).mode).toBe(mode);
		}
	});
});
