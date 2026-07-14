import {
	chmodSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	normalizeSoundValue,
	SOUND_FOCUS_MODES,
	type SoundFocusMode,
	type SoundValue,
} from "./sound";

/** Footer layout modes, in cycle order. */
export const FOOTER_MODES = ["full", "minimal", "adaptive"] as const;
export type FooterMode = (typeof FOOTER_MODES)[number];

const CONFIG_PATH = join(homedir(), ".pi", "fusiontui.json");

/** Full persisted config shape for fusiontui. */
export interface FusionConfig {
	mode: FooterMode;
	/** Sound played when the agent finishes its turn (default: fx-ok01). */
	completionSound: SoundValue;
	/**
	 * Sound played when the agent is waiting on you — an AskUser-style question
	 * (default: fx-ack01, mirroring Droid's awaiting-input default).
	 */
	awaitingInputSound: SoundValue;
	/** Focus policy for sounds (default: always). */
	soundFocusMode: SoundFocusMode;
}

export const DEFAULT_CONFIG: FusionConfig = {
	mode: "full",
	completionSound: "fx-ok01",
	awaitingInputSound: "fx-ack01",
	soundFocusMode: "always",
};

function isFooterMode(value: unknown): value is FooterMode {
	return typeof value === "string" && (FOOTER_MODES as readonly string[]).includes(value);
}

function isFocusMode(value: unknown): value is SoundFocusMode {
	return typeof value === "string" && (SOUND_FOCUS_MODES as readonly string[]).includes(value);
}

function readRaw(): Record<string, unknown> {
	try {
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
	} catch {}
	return {};
}

/** Load the full config, filling defaults for missing/invalid fields. */
export function loadConfig(onWarning?: (field: string) => void): FusionConfig {
	const raw = readRaw();
	const warnInvalid = (field: string) => {
		if (Object.prototype.hasOwnProperty.call(raw, field)) onWarning?.(field);
	};
	const mode = isFooterMode(raw.mode) ? raw.mode : DEFAULT_CONFIG.mode;
	if (raw.mode !== undefined && !isFooterMode(raw.mode)) warnInvalid("mode");
	// L1-01: only known enum values / valid absolute paths pass the boundary.
	const completionValue = normalizeSoundValue(raw.completionSound);
	const completionSound: SoundValue = completionValue ?? DEFAULT_CONFIG.completionSound;
	if (raw.completionSound !== undefined && !completionValue) warnInvalid("completionSound");
	const awaitingValue = normalizeSoundValue(raw.awaitingInputSound);
	const awaitingInputSound: SoundValue = awaitingValue ?? DEFAULT_CONFIG.awaitingInputSound;
	if (raw.awaitingInputSound !== undefined && !awaitingValue) warnInvalid("awaitingInputSound");
	const soundFocusMode = isFocusMode(raw.soundFocusMode)
		? raw.soundFocusMode
		: DEFAULT_CONFIG.soundFocusMode;
	if (raw.soundFocusMode !== undefined && !isFocusMode(raw.soundFocusMode)) warnInvalid("soundFocusMode");
	return { mode, completionSound, awaitingInputSound, soundFocusMode };
}

/** Merge a partial update into the persisted config (preserves unknown keys). */
export function saveConfig(patch: Partial<FusionConfig>): void {
	try {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		const next = { ...readRaw(), ...patch };
		const data = `${JSON.stringify(next, null, 2)}\n`;
		// Write/rename in the same directory: readers see either the old complete
		// JSON or the new complete JSON, never a partially written file (L1-02).
		const tempPath = `${CONFIG_PATH}.${process.pid}.tmp`;
		let mode: number | undefined;
		try {
			mode = statSync(CONFIG_PATH).mode & 0o777;
		} catch {}
		if (mode === undefined) writeFileSync(tempPath, data);
		else writeFileSync(tempPath, data, { mode });
		if (mode !== undefined) chmodSync(tempPath, mode);
		renameSync(tempPath, CONFIG_PATH);
	} catch {
		// Best effort, matching the existing config API. A failed rename leaves
		// the previous config intact; clean up the temp file when possible.
		try {
			unlinkSync(`${CONFIG_PATH}.${process.pid}.tmp`);
		} catch {}
	}
}

/** Persisted mode, defaulting to "full" when missing or unreadable. */
export function loadMode(): FooterMode {
	return loadConfig().mode;
}

export function saveMode(mode: FooterMode): void {
	saveConfig({ mode });
}

/** Mode after `current`, wrapping around the cycle. */
export function nextMode(current: FooterMode): FooterMode {
	return FOOTER_MODES[(FOOTER_MODES.indexOf(current) + 1) % FOOTER_MODES.length];
}
