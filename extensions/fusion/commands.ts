import {
	BUILTIN_SOUNDS,
	FOCUS_META,
	SOUND_FOCUS_MODES,
	SOUND_META,
	type SoundFocusMode,
	type SoundValue,
} from "./sound";

/**
 * Pure command-surface logic for index.ts: what a slash-command argument
 * means, and what the pickers offer. Everything here is a string -> value
 * decision with no ctx, no I/O and no state, so the branching can be tested
 * without a running session.
 */

/**
 * Ask-style tools → the agent is awaiting YOUR input (Droid's second sound
 * trigger, docs/ui/12-sound-notifications-spec.md §2). Matches
 * `ask_user_question`, `ask_user`, `askuser`, anything with `question`.
 */
export function isAskTool(name: string): boolean {
	return /(^|_)ask(_|user|$)|question/i.test(name);
}

/** What `/fusion-sound <args>` resolved to. */
export type SoundCommand =
	/** `test` — preview the current completion sound. */
	| { kind: "preview" }
	/** `ask <value>` — set the awaiting-input sound. */
	| { kind: "setAwaiting"; value: string }
	/** `ask` — open the awaiting-input picker. */
	| { kind: "pickAwaiting" }
	/** `focus <mode>` with a known mode. */
	| { kind: "setFocus"; mode: SoundFocusMode }
	/** `focus` with a missing or unknown mode — open the picker. */
	| { kind: "pickFocus" }
	/** A bare value — set the completion sound. */
	| { kind: "setCompletion"; value: string }
	/** No arguments — open the completion picker. */
	| { kind: "pickCompletion" };

export const isFocusMode = (value: string): value is SoundFocusMode =>
	(SOUND_FOCUS_MODES as readonly string[]).includes(value);

/**
 * Parse `/fusion-sound` arguments.
 *
 * `ask` and `focus` are subcommands; anything else is a completion-sound value
 * passed through verbatim (case and path separators intact) for
 * `normalizeSoundValue` to validate — lower-casing here would break absolute
 * paths on case-sensitive filesystems.
 */
export function parseSoundCommand(args: string): SoundCommand {
	const raw = args.trim();
	if (!raw) return { kind: "pickCompletion" };
	const [head = "", ...rest] = raw.split(/\s+/);
	const keyword = head.toLowerCase();

	if (keyword === "test") return { kind: "preview" };

	if (keyword === "ask") {
		const value = rest.join(" ").trim();
		return value ? { kind: "setAwaiting", value } : { kind: "pickAwaiting" };
	}

	if (keyword === "focus") {
		const mode = (rest[0] ?? "").toLowerCase();
		return isFocusMode(mode) ? { kind: "setFocus", mode } : { kind: "pickFocus" };
	}

	return { kind: "setCompletion", value: raw };
}

/** The selectable sound ids, in menu order. */
export const SOUND_CHOICES: readonly string[] = ["off", "bell", ...BUILTIN_SOUNDS];

/** `fx-ok01 — Soft success bloop. (from Droid) (current)` picker rows. */
export function soundChoices(current: SoundValue): string[] {
	return SOUND_CHOICES.map((id) => {
		const description = SOUND_META[id]?.description ?? id;
		return `${id} — ${description}${id === current ? " (current)" : ""}`;
	});
}

/** `focused — Only when the terminal is focused` picker rows. */
export function focusChoices(): string[] {
	return SOUND_FOCUS_MODES.map((mode) => `${mode} — ${FOCUS_META[mode].description}`);
}

/** The id back out of a picker row; "" when nothing was chosen. */
export function choiceValue(pick: string | undefined | null): string {
	return (pick ?? "").trim().split(/\s+/)[0] ?? "";
}

/** Completions for `/fusion-sound`, filtered by what has been typed. */
export function soundCompletions(prefix: string): { value: string; label: string }[] {
	const typed = prefix.trim().toLowerCase();
	return [
		...SOUND_CHOICES.map((value) => ({ value, label: value })),
		{ value: "ask", label: "ask <sound> — awaiting-input sound (AskUser)" },
		{ value: "focus", label: "focus <always|focused|unfocused>" },
		{ value: "test", label: "test — preview the current sound" },
	].filter((option) => option.value.startsWith(typed));
}
