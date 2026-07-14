/**
 * Sound notifications — a faithful TypeScript port of Droid's notification-sound
 * engine (reverse-engineered from droid.bundle.js: v2R / xi0 / iw1 / J9R).
 *
 * Design mirrors Droid:
 *  - One dispatcher (`playSound`) with precedence:
 *      off → focus policy → terminal bell → built-in WAV → custom .wav path
 *  - Per-OS player: macOS `afplay`, Linux `paplay`/`aplay`/`ffplay`, Windows PowerShell.
 *  - Every failure path degrades gracefully to the terminal bell (BEL, \x07).
 *  - A 2s timeout child process, killed with SIGTERM if it overruns.
 *
 * Unlike Droid we do NOT need to extract assets from a Bun VFS — the two WAVs
 * ship on disk under ./sounds/, so playback reads them directly.
 */
import { execFile, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/** Built-in sound ids (mirror Droid's `dOT` enum). */
export const BUILTIN_SOUNDS = ["fx-ok01", "fx-ack01"] as const;
export type BuiltinSound = (typeof BUILTIN_SOUNDS)[number];

/** A sound setting value: disabled, terminal bell, a built-in, or a custom path. */
export type SoundValue = "off" | "bell" | BuiltinSound | (string & {});

/** When a sound is allowed to play, relative to terminal focus (mirror Droid). */
export const SOUND_FOCUS_MODES = ["always", "focused", "unfocused"] as const;
export type SoundFocusMode = (typeof SOUND_FOCUS_MODES)[number];

/** Human labels + descriptions (mirrors Droid's `soundSelector` i18n). */
export const SOUND_META: Record<string, { label: string; description: string }> = {
	off: { label: "Off", description: "No sound or notification" },
	bell: { label: "Terminal Bell", description: "System terminal bell (classic beep)" },
	"fx-ok01": { label: "FX-OK01", description: "Soft success bloop. (from Droid)" },
	"fx-ack01": { label: "FX-ACK01", description: "Tactile ripple feedback. (from Droid)" },
};

export const FOCUS_META: Record<SoundFocusMode, { label: string; description: string }> = {
	always: { label: "Always", description: "Play regardless of terminal focus" },
	focused: { label: "Focused only", description: "Only when the terminal is focused" },
	unfocused: { label: "Unfocused only", description: "Only when you're away from the terminal" },
};

function isBuiltin(v: string): v is BuiltinSound {
	return (BUILTIN_SOUNDS as readonly string[]).includes(v);
}

/**
 * Central guard for persisted sound values (L1-01): only the known enum
 * values or an absolute path to an existing playable file are accepted.
 * Returns null for anything else so callers can fall back predictably.
 */
export function normalizeSoundValue(value: unknown): SoundValue | null {
	if (typeof value !== "string" || value.length === 0) return null;
	if (value === "off" || value === "bell" || isBuiltin(value)) return value;
	// Custom sounds must be absolute paths to a real file.
	const isAbsolute =
		value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
	if (!isAbsolute) return null;
	try {
		return existsSync(value) && statSync(value).isFile() ? value : null;
	} catch {
		return null;
	}
}

/** Resolve a built-in id to its bundled .wav path (next to this module). */
function builtinPath(id: BuiltinSound): string {
	return fileURLToPath(new URL(`./sounds/${id}.wav`, import.meta.url));
}

/** Whether a command exists on PATH (mirror Droid's `Ch9`). */
const execFileAsync = promisify(execFile);
const playerCache = new Map<string, string | null>();

/** Cached asynchronous PATH probe; never run once per notification (L4-11). */
async function commandExists(cmd: string): Promise<boolean> {
	try {
		const probe = process.platform === "win32" ? "where" : "which";
		await execFileAsync(probe, [cmd], { timeout: 1000 });
		return true;
	} catch {
		return false;
	}
}

/** Terminal bell — write BEL, but only when attached to a TTY (mirror Droid's `J9R`). */
export function terminalBell(): void {
	try {
		if (process.stdout.isTTY) process.stdout.write("\x07");
	} catch {}
}

/** Pick the OS audio player + args for a file (mirror Droid's `iw1`). */
async function playerFor(file: string): Promise<{ command: string; args: string[] } | null> {
	const platform = process.platform;
	let command = playerCache.get(platform);
	if (command === undefined) {
		switch (platform) {
			case "darwin":
				command = "afplay";
				break;
			case "win32":
				command = "powershell";
				break;
			case "linux":
				command = null;
				for (const candidate of ["paplay", "aplay", "ffplay"]) {
					if (await commandExists(candidate)) {
						command = candidate;
						break;
					}
				}
				break;
			default:
				command = null;
		}
		playerCache.set(platform, command);
	}
	if (!command) return null;
	if (command === "aplay") return { command, args: ["-q", file] };
	if (command === "ffplay") return { command, args: ["-nodisp", "-autoexit", file] };
	if (command === "powershell") {
		return {
			command,
			args: [
				"-NoProfile",
				"-NonInteractive",
				"-c",
				`Add-Type -AssemblyName System.Windows.Forms; (New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`,
			],
		};
	}
	return { command, args: [file] };
}

function isPlayableFile(p: string): boolean {
	try {
		return existsSync(p) && statSync(p).isFile();
	} catch {
		return false;
	}
}

const activePlayers = new Map<ChildProcess, () => void>();
let playbackGeneration = 0;

/** Stop every child owned by this extension during teardown (L4-08). */
export function stopSoundPlayback(): void {
	playbackGeneration++;
	for (const [child, settle] of activePlayers) {
		settle();
		try { child.kill("SIGTERM"); } catch {}
	}
	activePlayers.clear();
}

/** Low-level: play a resolved file path, falling back to the bell (mirror Droid's `xi0`). */
async function playFile(file: string, opts: { fallbackToBell?: boolean; timeout?: number } = {}): Promise<boolean> {
	const { fallbackToBell = true, timeout = 2000 } = opts;
	const generation = playbackGeneration;
	if (!isPlayableFile(file)) {
		if (fallbackToBell) terminalBell();
		return false;
	}
	const player = await playerFor(file);
	if (generation !== playbackGeneration) return false;
	if (!player) {
		if (fallbackToBell) terminalBell();
		return false;
	}
	return new Promise((resolve) => {
		let settled = false;
		let child: ChildProcess | undefined;
		const settle = (success: boolean, notify = true) => {
			if (settled) return;
			settled = true;
			if (child) activePlayers.delete(child);
			if (!success && notify && fallbackToBell) terminalBell();
			resolve(success);
		};
		child = execFile(player.command, player.args, { timeout, killSignal: "SIGTERM" }, (err) => {
			settle(!err);
		});
		activePlayers.set(child, () => settle(false, false));
		child.on("error", () => settle(false));
	});
}

export interface PlaySoundContext {
	/** Current terminal focus (undefined = unknown → treated as focused). */
	isFocused?: boolean;
}

/**
 * Main dispatcher (mirror Droid's `v2R`).
 * Precedence: off → focus policy → bell → built-in → custom path.
 */
export async function playSound(
	sound: SoundValue,
	focusMode: SoundFocusMode = "always",
	ctx: PlaySoundContext = {},
): Promise<void> {
	if (!sound || sound === "off") return;

	if (focusMode !== "always") {
		const focused = ctx.isFocused ?? true; // unknown focus → assume focused
		if (focusMode === "focused" && !focused) return;
		if (focusMode === "unfocused" && focused) return;
	}

	if (sound === "bell") {
		terminalBell();
		return;
	}
	if (isBuiltin(sound)) {
		await playFile(builtinPath(sound), {});
		return;
	}
	// Otherwise treat the value as a custom absolute file path.
	await playFile(sound, {});
}

/** Preview helper for the config UI — play immediately, ignoring focus policy. */
export async function previewSound(sound: SoundValue): Promise<void> {
	await playSound(sound, "always", { isFocused: true });
}

// ── Terminal focus tracking ──────────────────────────────────────────────
// Enable focus reporting (\x1b[?1004h) and parse focus-in (\x1b[I) /
// focus-out (\x1b[O). Mirrors Droid's r5H/AgT focus flag. Opt-in: only turned
// on when a focus-sensitive mode is actually selected, to avoid touching the
// terminal state unnecessarily.
const ENABLE_FOCUS_REPORTING = "\x1b[?1004h";
const DISABLE_FOCUS_REPORTING = "\x1b[?1004l";

export class FocusTracker {
	private focused = true;
	private enabled = false;

	get isFocused(): boolean {
		return this.focused;
	}

	enable(): void {
		if (this.enabled) return;
		try {
			if (process.stdout.isTTY) {
				process.stdout.write(ENABLE_FOCUS_REPORTING);
				this.enabled = true;
			}
		} catch {}
	}

	disable(): void {
		if (!this.enabled) return;
		try {
			if (process.stdout.isTTY) process.stdout.write(DISABLE_FOCUS_REPORTING);
		} catch {}
		this.enabled = false;
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
	}

	/** Feed raw terminal input; updates focus state if a focus event is present. */
	handleInput(data: string): void {
		if (!data) return;
		// Focus-in: ESC [ I   Focus-out: ESC [ O
		if (data.includes("\x1b[I")) this.focused = true;
		if (data.includes("\x1b[O")) this.focused = false;
	}
}
