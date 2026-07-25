import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BUILTIN_SOUNDS,
	FOCUS_META,
	FocusTracker,
	SOUND_FOCUS_MODES,
	SOUND_META,
	normalizeSoundValue,
	playSound,
	previewSound,
	stopSoundPlayback,
	terminalBell,
	type SoundFocusMode,
} from "../extensions/fusion/sound";

const dirs: string[] = [];
const tempDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "fusiontui-sound-"));
	dirs.push(dir);
	return dir;
};

// playSound never reaches a real player here: the bell path writes to a stubbed
// stdout, and every file path we hand it is a non-audio file, which settles as
// a failed playback rather than spawning anything long-lived.
function captureStdout() {
	const original = process.stdout.write.bind(process.stdout);
	const originalIsTTY = process.stdout.isTTY;
	const written: string[] = [];
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	process.stdout.write = ((chunk: unknown) => {
		written.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	return {
		written,
		restore: () => {
			process.stdout.write = original;
			Object.defineProperty(process.stdout, "isTTY", {
				value: originalIsTTY,
				configurable: true,
			});
		},
	};
}

afterEach(() => {
	stopSoundPlayback();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("normalizeSoundValue", () => {
	test("accepts the known enum values", () => {
		for (const value of ["off", "bell", ...BUILTIN_SOUNDS]) {
			expect(normalizeSoundValue(value)).toBe(value);
		}
	});

	test("rejects anything that is not a non-empty string", () => {
		for (const value of [undefined, null, "", 42, {}, [], true]) {
			expect(normalizeSoundValue(value)).toBeNull();
		}
	});

	test("rejects unknown ids and relative paths", () => {
		expect(normalizeSoundValue("fx-nope")).toBeNull();
		expect(normalizeSoundValue("sounds/ping.wav")).toBeNull();
		expect(normalizeSoundValue("./ping.wav")).toBeNull();
		expect(normalizeSoundValue("../ping.wav")).toBeNull();
	});

	test("accepts an absolute path only when it points at a real file", () => {
		const dir = tempDir();
		const file = join(dir, "ping.wav");
		writeFileSync(file, "RIFF");
		expect(normalizeSoundValue(file)).toBe(file);
		expect(normalizeSoundValue(join(dir, "missing.wav"))).toBeNull();
	});

	test("rejects an absolute path that is a directory", () => {
		const dir = tempDir();
		mkdirSync(join(dir, "sub"));
		expect(normalizeSoundValue(join(dir, "sub"))).toBeNull();
	});
});

describe("metadata", () => {
	test("every selectable sound has a label and description", () => {
		for (const id of ["off", "bell", ...BUILTIN_SOUNDS]) {
			expect(SOUND_META[id]?.label.length).toBeGreaterThan(0);
			expect(SOUND_META[id]?.description.length).toBeGreaterThan(0);
		}
	});

	test("every focus mode has a label and description", () => {
		for (const mode of SOUND_FOCUS_MODES) {
			expect(FOCUS_META[mode].label.length).toBeGreaterThan(0);
			expect(FOCUS_META[mode].description.length).toBeGreaterThan(0);
		}
	});
});

describe("terminalBell", () => {
	test("writes BEL when attached to a TTY", () => {
		const stdout = captureStdout();
		try {
			terminalBell();
			expect(stdout.written.join("")).toBe("\x07");
		} finally {
			stdout.restore();
		}
	});
});

describe("playSound focus policy", () => {
	const bellWrites = async (mode: SoundFocusMode, isFocused: boolean | undefined) => {
		const stdout = captureStdout();
		try {
			await playSound("bell", mode, { isFocused });
			return stdout.written.join("");
		} finally {
			stdout.restore();
		}
	};

	test("'off' and an empty value are silent in every mode", async () => {
		for (const mode of SOUND_FOCUS_MODES) {
			const stdout = captureStdout();
			try {
				await playSound("off", mode, { isFocused: true });
				await playSound("" as never, mode, { isFocused: true });
				expect(stdout.written.join("")).toBe("");
			} finally {
				stdout.restore();
			}
		}
	});

	test("'always' plays regardless of focus", async () => {
		expect(await bellWrites("always", true)).toBe("\x07");
		expect(await bellWrites("always", false)).toBe("\x07");
	});

	test("'focused' plays only while the terminal has focus", async () => {
		expect(await bellWrites("focused", true)).toBe("\x07");
		expect(await bellWrites("focused", false)).toBe("");
	});

	test("'unfocused' plays only while the terminal is in the background", async () => {
		expect(await bellWrites("unfocused", false)).toBe("\x07");
		expect(await bellWrites("unfocused", true)).toBe("");
	});

	test("unknown focus is treated as focused", async () => {
		expect(await bellWrites("focused", undefined)).toBe("\x07");
		expect(await bellWrites("unfocused", undefined)).toBe("");
	});

	test("previewSound ignores the focus policy entirely", async () => {
		const stdout = captureStdout();
		try {
			await previewSound("bell");
			expect(stdout.written.join("")).toBe("\x07");
		} finally {
			stdout.restore();
		}
	});
});

describe("playSound file fallback", () => {
	test("a missing custom file falls back to the bell instead of throwing", async () => {
		const stdout = captureStdout();
		try {
			await playSound(join(tempDir(), "absent.wav"), "always", { isFocused: true });
			expect(stdout.written.join("")).toBe("\x07");
		} finally {
			stdout.restore();
		}
	});

	// L4-08: playback must settle exactly once, so a fallback is never doubled.
	test("stopSoundPlayback is safe to call with nothing playing", () => {
		expect(() => {
			stopSoundPlayback();
			stopSoundPlayback();
		}).not.toThrow();
	});
});

describe("FocusTracker", () => {
	test("starts focused and follows explicit updates", () => {
		const tracker = new FocusTracker();
		expect(tracker.isFocused).toBe(true);
		tracker.setFocused(false);
		expect(tracker.isFocused).toBe(false);
		tracker.setFocused(true);
		expect(tracker.isFocused).toBe(true);
	});

	test("parses focus-in and focus-out out of raw terminal input", () => {
		const tracker = new FocusTracker();
		tracker.handleInput("\x1b[O");
		expect(tracker.isFocused).toBe(false);
		tracker.handleInput("\x1b[I");
		expect(tracker.isFocused).toBe(true);
		tracker.handleInput("prefix\x1b[Osuffix");
		expect(tracker.isFocused).toBe(false);
	});

	test("ignores empty input and unrelated escape sequences", () => {
		const tracker = new FocusTracker();
		tracker.handleInput("");
		tracker.handleInput("\x1b[5~");
		tracker.handleInput("hello");
		expect(tracker.isFocused).toBe(true);
	});

	test("enable writes the focus-reporting sequence once, disable undoes it", () => {
		const stdout = captureStdout();
		try {
			const tracker = new FocusTracker();
			tracker.enable();
			tracker.enable();
			expect(stdout.written.join("")).toBe("\x1b[?1004h");
			stdout.written.length = 0;
			tracker.disable();
			tracker.disable();
			expect(stdout.written.join("")).toBe("\x1b[?1004l");
		} finally {
			stdout.restore();
		}
	});

	test("disable without a prior enable writes nothing", () => {
		const stdout = captureStdout();
		try {
			new FocusTracker().disable();
			expect(stdout.written.join("")).toBe("");
		} finally {
			stdout.restore();
		}
	});
});
