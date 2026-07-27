---
date: 2026-07-27T00:06:05-0300
author: Gabriel Aguiar
commit: 2d62b78
branch: main
repository: pi-fusiontui
topic: "droidSkin toggle — disable the droid skin, keep footer + model/effort row"
tags: [plan, config, commands, session-lifecycle, editor, droid-skin]
status: ready
parent: ".rpiv/artifacts/designs/2026-07-26_23-35-14_droid-skin-toggle.md"
phase_count: 4
phases:
  - { n: 1, title: Config field + path seam }
  - { n: 2, title: Command resolver + completions }
  - { n: 3, title: Editor skin-off render }
  - { n: 4, title: session_start gate + /fusion-droid }
last_updated: 2026-07-27T00:06:05-0300
last_updated_by: Gabriel Aguiar
---

# droidSkin Toggle Implementation Plan

## Overview

Add a persisted boolean `droidSkin` (default `true`) to `~/.pi/fusiontui.json`, flipped by a new `/fusion-droid [on|off]` command and read exactly once per session in `session_start`. The flag lives in a factory-closure variable and gates only the **install** half of the droid skin — the prototype patches, the tool-card overrides, the loader suppression, and the editor's droid chrome. Teardown stays ungated because every unpatch is self-guarded and `setWorkingVisible(true)` is idempotent.

Derived from `.rpiv/artifacts/designs/2026-07-26_23-35-14_droid-skin-toggle.md`; phases inherit that design's `## Slices` 1:1.

## Desired End State

```jsonc
// ~/.pi/fusiontui.json
{
  "mode": "full",
  "completionSound": "fx-ok01",
  "droidSkin": false
}
```

```
/fusion-droid off
› fusiontui: droid skin = off (restart pi to apply)

/fusion-droid
› fusiontui: droid skin = on (restart pi to apply)
```

With `droidSkin: false`, after a restart — Pi's native editor emits no prompt
glyph and pushes both a top and a bottom rule, so the meta row simply floats
above it:

```
                                            claude-opus-4-8 (High)
────────────────────────────────────────────────────────────────────
type here
────────────────────────────────────────────────────────────────────
```

versus `droidSkin: true`:

```
 ⠙ Thinking… (Press ESC to stop)
                                            claude-opus-4-8 (High)
╭──────────────────────────────────────────────────────────────────╮
│ > type here                                                      │
╰──────────────────────────────────────────────────────────────────╯
```

## What We're NOT Doing

- **README / docs** — explicitly removed from scope by the developer at decomposition, despite the `a38a39b` / `791d912` / `35f460b` precedent of documenting new settings in the same commit.
- Granular per-piece flags (separate toggles for cards / icon / editor).
- Live mid-session toggling — there is no `unregisterTool` (`loader.js:195-202`), so the flag is read once at `session_start`.
- Moving the model/effort row into the footer.
- Any change to sounds, scroll-lock, git, usage, or the footer.
- Gating `session_shutdown` (`index.ts:660-671`) — deliberately ungated.
- Changing the prelude row count in the **skinned** render path; the box branch keeps its two-row prelude and its `:294` / `:296` / `:322-324` constants untouched.

---

## Phase 1: Config field + path seam

### Overview

Add the `droidSkin` boolean to `FusionConfig` / `DEFAULT_CONFIG`, an `isBoolean` guard with the standard ternary + `warnInvalid` pair, and a `setConfigPath(path?)` module seam so tests can point the zero-arg `loadConfig` / `saveConfig` wrappers away from the developer's real `~/.pi`.

### Changes Required:

#### 1. Config module
**File**: `extensions/fusion/config.ts`
**Changes**: `activePath` module state + exported `setConfigPath`; `droidSkin` field on the interface, in `DEFAULT_CONFIG`, and in the parse/warn/return triple; wrappers read `activePath`.

```ts
// config.ts:29 — after the existing CONFIG_PATH declaration
/**
 * Where the config lives in production. This is the DEFAULT only — the thin
 * wrappers below bind `activePath`, not this constant, so tests can redirect
 * them through setConfigPath without touching ~/.pi.
 */
export const CONFIG_PATH = join(homedir(), ".pi", "fusiontui.json");

/**
 * The path the thin wrappers below actually read and write. Production leaves
 * it at CONFIG_PATH; tests point it at a temp directory before activating the
 * extension and restore it in afterEach — the same module-state + exported
 * setter shape as setPaletteThemeProvider (droid-palette.ts).
 */
let activePath = CONFIG_PATH;

/** Point the default wrappers at `path`; omit the argument to restore CONFIG_PATH. */
export function setConfigPath(path?: string): void {
	activePath = path ?? CONFIG_PATH;
}

// config.ts:42 — new field at the end of the FusionConfig interface
	/** Focus policy for sounds (default: always). */
	soundFocusMode: SoundFocusMode;
	/**
	 * Render the droid transcript skin — tool cards, the assistant icon, the
	 * user gutter and the composer bubble (default: true). Read once per
	 * session, so a change only applies after pi restarts.
	 */
	droidSkin: boolean;
}

// config.ts:45-50 — DEFAULT_CONFIG gains the new default
export const DEFAULT_CONFIG: FusionConfig = {
	mode: "full",
	completionSound: "fx-ok01",
	awaitingInputSound: "fx-ack01",
	soundFocusMode: "always",
	droidSkin: true,
};

// config.ts:58 — new guard beside isFooterMode / isFocusMode
function isBoolean(value: unknown): value is boolean {
	return typeof value === "boolean";
}

// config.ts:91-92 — new value + warn pair, then the extended return literal
	if (raw.soundFocusMode !== undefined && !isFocusMode(raw.soundFocusMode)) warnInvalid("soundFocusMode");
	const droidSkin = isBoolean(raw.droidSkin) ? raw.droidSkin : DEFAULT_CONFIG.droidSkin;
	if (raw.droidSkin !== undefined && !isBoolean(raw.droidSkin)) warnInvalid("droidSkin");
	return { mode, completionSound, awaitingInputSound, soundFocusMode, droidSkin };
}

// config.ts:121-129 — the wrappers read the mutable activePath
/** Load the full config, filling defaults for missing/invalid fields. */
export function loadConfig(onWarning?: (field: string) => void): FusionConfig {
	return loadConfigFrom(activePath, onWarning);
}

/** Merge a partial update into the persisted config (preserves unknown keys). */
export function saveConfig(patch: Partial<FusionConfig>): void {
	saveConfigTo(activePath, patch);
}
```

#### 2. Config tests
**File**: `tests/config.test.ts`
**Changes**: extend the full-shape assertion; add falsy-survival, warn, round-trip, unknown-key and `setConfigPath` tests; reset the seam in the file-level `afterEach`.

```ts
// imports — add loadConfig, saveConfig, setConfigPath to the existing named import
import {
	DEFAULT_CONFIG,
	FOOTER_MODES,
	loadConfig,
	loadConfigFrom,
	nextMode,
	readRawFrom,
	saveConfig,
	saveConfigTo,
	setConfigPath,
	type FooterMode,
} from "../extensions/fusion/config";

// tests/config.test.ts:23-25 — the existing file-level teardown also resets the module seam
afterEach(() => {
	setConfigPath();
	rmSync(dir, { recursive: true, force: true });
});

// tests/config.test.ts:67-80 — the existing full-shape assertion gains the new field
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
			droidSkin: DEFAULT_CONFIG.droidSkin,
		});
	});

// new tests inside describe("loadConfigFrom")
	// A boolean is the first falsy-capable field: `false` must survive the
	// ternary AND must not be mistaken for a present-but-invalid value.
	test("keeps a persisted droidSkin: false instead of falling back to the default", () => {
		write(JSON.stringify({ droidSkin: false }));
		expect(loadConfigFrom(path).droidSkin).toBe(false);
	});

	test("warns for a non-boolean droidSkin and stays silent for a valid false", () => {
		write(JSON.stringify({ droidSkin: "off" }));
		const warned: string[] = [];
		expect(loadConfigFrom(path, (field) => warned.push(field)).droidSkin).toBe(
			DEFAULT_CONFIG.droidSkin,
		);
		expect(warned).toEqual(["droidSkin"]);

		write(JSON.stringify({ droidSkin: false }));
		const quiet: string[] = [];
		loadConfigFrom(path, (field) => quiet.push(field));
		expect(quiet).toEqual([]);
	});

// new tests inside describe("saveConfigTo")
	test("round-trips both droidSkin values", () => {
		for (const droidSkin of [false, true]) {
			saveConfigTo(path, { droidSkin });
			expect(loadConfigFrom(path).droidSkin).toBe(droidSkin);
		}
	});

	test("writes droidSkin as a JSON boolean without disturbing unknown keys", () => {
		write(JSON.stringify({ mode: "minimal", theirKey: { a: 1 } }));
		saveConfigTo(path, { droidSkin: false });
		expect(read()).toEqual({ mode: "minimal", theirKey: { a: 1 }, droidSkin: false });
	});

// new top-level describe (reset lives in the file-level afterEach above)
describe("setConfigPath", () => {
	test("redirects the default wrappers away from ~/.pi and back", () => {
		const other = join(dir, "other.json");
		setConfigPath(path);
		saveConfig({ droidSkin: false });
		expect(read().droidSkin).toBe(false);
		expect(loadConfig().droidSkin).toBe(false);
		setConfigPath(other);
		expect(loadConfig().droidSkin).toBe(DEFAULT_CONFIG.droidSkin);
	});
});
```

### Success Criteria:

#### Automated Verification:
- [x] Config tests pass: `bun test tests/config.test.ts`
- [x] Type checking passes: `bun run typecheck`
- [x] `grep -n "droidSkin" extensions/fusion/config.ts | wc -l` returns 5 (interface, DEFAULT_CONFIG, value line, warn line, return literal)
- [x] `grep -n "activePath" extensions/fusion/config.ts | wc -l` returns 4 (declaration, setter, loadConfig, saveConfig) — returns 5, the extra match is the CONFIG_PATH docblock this plan itself specifies
- [x] A `{"droidSkin": false}` file loads as `false` and produces an empty warning list
- [x] A `{"droidSkin": "off"}` file loads as `true` and warns exactly `["droidSkin"]`
- [x] `saveConfigTo(path, { droidSkin: false })` leaves unknown keys structurally unchanged on a raw `JSON.parse` read (`expect(read()).toEqual(...)`)

#### Manual Verification:
- [ ] `cat ~/.pi/fusiontui.json` is unchanged after `bun test tests/config.test.ts` — the new setConfigPath tests write only into the mkdtemp directory

---

## Phase 2: Command resolver + completions

### Overview

Add the pure parsing layer for `/fusion-droid`: the `DROID_SKIN_ARGS` tuple, `resolveDroidSkin(args, current)` following the `resolveFooterMode` convention verbatim, and `droidSkinCompletions(prefix)`.

Independent of Phase 3 — the two can run in parallel after Phase 1 (Phase 2 has no Phase 1 dependency at all, but is ordered here to keep the sequence linear).

### Changes Required:

#### 1. Commands module
**File**: `extensions/fusion/commands.ts`
**Changes**: append the args tuple, resolver, and completions after `footerModeCompletions` (`:108-115`), before `soundCompletions`. No `ctx.` reference — the pure-layer contract stands.

```ts
// commands.ts — appended after footerModeCompletions (:108-115), before soundCompletions

/** `/fusion-droid` arguments, in cycle order. */
export const DROID_SKIN_ARGS = ["on", "off"] as const;

/**
 * `/fusion-droid [on|off]` — a named value selects it, anything else
 * (including no argument) flips the current one, which is what makes a bare
 * `/fusion-droid` a toggle. Same convention as `/fusion`; over a two-value
 * domain "advance the cycle" and "toggle" are the same operation.
 */
export function resolveDroidSkin(args: string, current: boolean): boolean {
	const arg = args.trim().toLowerCase();
	if (arg === "on") return true;
	if (arg === "off") return false;
	return !current;
}

/** Completions for `/fusion-droid`, filtered by what has been typed. */
export function droidSkinCompletions(prefix: string): { value: string; label: string }[] {
	const typed = prefix.trim().toLowerCase();
	return DROID_SKIN_ARGS.filter((arg) => arg.startsWith(typed)).map((arg) => ({
		value: arg,
		label: arg,
	}));
}
```

#### 2. Commands tests
**File**: `tests/commands.test.ts`
**Changes**: append `describe("resolveDroidSkin")` and `describe("droidSkinCompletions")` after `describe("footerModeCompletions")`, mirroring the resolver test structure at `tests/commands.test.ts:150-183`.

```ts
// imports — add the three new symbols to the existing named import from ../extensions/fusion/commands
import {
	DROID_SKIN_ARGS,
	droidSkinCompletions,
	resolveDroidSkin,
	// …existing imports unchanged
} from "../extensions/fusion/commands";

// new describes, appended after describe("footerModeCompletions")
describe("resolveDroidSkin", () => {
	test("a named value is selected verbatim, whatever the current one", () => {
		for (const current of [true, false]) {
			expect(resolveDroidSkin("on", current)).toBe(true);
			expect(resolveDroidSkin(" ON ", current)).toBe(true);
			expect(resolveDroidSkin("off", current)).toBe(false);
			expect(resolveDroidSkin(" OFF ", current)).toBe(false);
		}
	});

	test("no argument flips the current value, so a bare /fusion-droid toggles", () => {
		expect(resolveDroidSkin("", true)).toBe(false);
		expect(resolveDroidSkin("", false)).toBe(true);
	});

	test("an unknown argument toggles rather than failing", () => {
		for (const current of [true, false]) {
			expect(resolveDroidSkin("sideways", current)).toBe(resolveDroidSkin("", current));
		}
	});
});

describe("droidSkinCompletions", () => {
	test("offers both values and filters case-insensitively", () => {
		expect(droidSkinCompletions("").map((o) => o.value)).toEqual([...DROID_SKIN_ARGS]);
		expect(droidSkinCompletions("OF").map((o) => o.value)).toEqual(["off"]);
		expect(droidSkinCompletions(" o ").map((o) => o.value)).toEqual(["on", "off"]);
		expect(droidSkinCompletions("zzz")).toEqual([]);
	});
});
```

### Success Criteria:

#### Automated Verification:
- [x] Command tests pass: `bun test tests/commands.test.ts`
- [x] Type checking passes: `bun run typecheck`
- [x] Lint passes: `bun run lint`
- [x] `resolveDroidSkin("sideways", c)` equals `resolveDroidSkin("", c)` for both values of `c` — unknown ≡ empty, the same property `resolveFooterMode` is held to in `describe("resolveFooterMode")`
- [x] `droidSkinCompletions("")` returns `["on", "off"]` and `droidSkinCompletions("zzz")` returns `[]`
- [x] `grep -n "ctx\." extensions/fusion/commands.ts` returns no match — the pure-layer contract at `extensions/fusion/commands.ts:11-16` still holds

#### Manual Verification:
- [ ] None — this slice is pure string→value logic with no runtime surface until the command is registered

---

## Phase 3: Editor skin-off render

### Overview

Give `createFusionEditor` an 8th positional `droidSkin` parameter, forward it to `applyFusionSkin`, make the padding lock skin-only, and add the skin-off render branch that returns `[metaRow(w), ...baseRender(w)]` — no status row, no ticker, no bubble, no chevron.

Independent of Phase 2; both must land before Phase 4.

### Changes Required:

#### 1. Editor module
**File**: `extensions/fusion/editor.ts`
**Changes**: 8th positional parameter (`droidSkin = true`), forwarded through `applyFusionSkin`; padding lock wrapped in `if (droidSkin)`; early skin-off branch at the top of `inner.render`.

```ts
// editor.ts:131-158 — createFusionEditor gains an 8th positional parameter and forwards it
export function createFusionEditor(
	tui: TUI,
	theme: EditorTheme,
	keybindings: KeybindingsManager,
	uiTheme: Theme,
	getMeta: () => EditorMeta,
	isCurrent: () => boolean = () => true,
	innerFactory?: InnerEditorFactory,
	droidSkin = true,
): FusionSkinned {
	// …inner construction unchanged…
	inner ??= new CustomEditor(tui, theme, keybindings, { paddingX: 0 });
	return applyFusionSkin(inner, tui, uiTheme, getMeta, isCurrent, droidSkin);
}

// editor.ts:160-170 — applyFusionSkin gains the flag
/**
 * Apply the droid skin to ONE editor instance (instance-level patch, never the
 * prototype — other extensions' editors elsewhere are unaffected).
 *
 * With `droidSkin` false the instance keeps ONLY the model/effort meta row and
 * renders Pi's native editor underneath: no status row, no ticker, no bubble,
 * no chevron, no padding lock.
 */
function applyFusionSkin(
	inner: CustomEditor,
	tui: TUI,
	uiTheme: Theme,
	getMeta: () => EditorMeta,
	isCurrent: () => boolean,
	droidSkin: boolean,
): FusionSkinned {

// editor.ts:186-190 — the padding lock becomes skin-only
	// The bubble math assumes zero native padding — but interactive-mode copies
	// the user's editorPaddingX setting onto every custom editor right after
	// construction (`newEditor.setPaddingX(defaultEditor.getPaddingX())`).
	// Lock it at 0 so the droid frame stays consistent. With the skin off there
	// is no frame to keep consistent, so the user's padding is left alone.
	if (droidSkin) {
		baseSetPaddingX(0);
		inner.setPaddingX = (_padding: number) => baseSetPaddingX(0);
	}

// editor.ts:251-253 — the skin-off branch, first thing in render
	inner.render = (width: number): string[] => {
		const w = normalizeWidth(width);
		// Skin off: Pi's native editor with only the model/effort row floated
		// above it. statusLine is never called, so no ticker is ever subscribed
		// and the droid bubble/chevron never render. Height stays constant —
		// metaRow already returns "" when there is no model.
		if (!droidSkin) {
			const native = baseRender(w);
			return capHeight([metaRow(w), ...native.map((line) => fitLine(line, w, ""))]);
		}
		const status = statusLine(w);
		const metaLine = metaRow(w);
		// …the rest of the existing skinned render is unchanged…
```

#### 2. Editor compose tests
**File**: `tests/editor-compose.test.ts`
**Changes**: append `describe("droidSkin: false")` with an `off()` helper and four tests (native render shape, no status row while working, constant height, padding untouched). Existing five call sites keep compiling untouched.

```ts
// new describe, appended at the end of the file
describe("droidSkin: false", () => {
	const off = (getMeta: () => EditorMeta) => {
		const { tui, keybindings } = deps();
		return createFusionEditor(
			tui,
			editorTheme,
			keybindings,
			uiTheme,
			getMeta,
			() => true,
			undefined,
			false,
		);
	};

	test("renders Pi's native editor under the meta row, with no bubble", () => {
		const editor = off(() => idleMeta);
		const lines = editor.render(60).map(strip);
		expect(lines[0]).toContain("Fable 5 (High)"); // meta row is the first line now
		expect(lines.some((l) => l.trimStart().startsWith("╭"))).toBe(false);
		expect(lines.some((l) => l.trimStart().startsWith("╰"))).toBe(false);
		expect(lines.some((l) => l.includes("│ >"))).toBe(false);
		editor.dispose();
	});

	// The status row is the only ticker subscriber; skipping it must also skip
	// the droid spinner entirely, not just hide it.
	test("never draws the droid status row, even while the agent is working", () => {
		const working: EditorMeta = {
			...idleMeta,
			agent: "working",
			workingLabel: "Thinking…",
		};
		const editor = off(() => working);
		const lines = editor.render(60).map(strip);
		expect(lines.some((l) => l.includes("Thinking…"))).toBe(false);
		expect(lines[0]).toContain("Fable 5 (High)");
		editor.dispose();
	});

	test("keeps a constant height when the model label disappears", () => {
		let meta: EditorMeta = idleMeta;
		const editor = off(() => meta);
		const withModel = editor.render(60).length;
		meta = { ...idleMeta, modelLabel: "no-model" };
		expect(editor.render(60).length).toBe(withModel);
		editor.dispose();
	});

	test("leaves the user's editor padding alone", () => {
		const editor = off(() => idleMeta);
		editor.setPaddingX(4);
		expect(editor.getPaddingX()).toBe(4);
		editor.dispose();
	});
});
```

### Success Criteria:

#### Automated Verification:
- [x] Editor tests pass: `bun test tests/editor-compose.test.ts`
- [x] Type checking passes: `bun run typecheck`
- [x] Lint passes: `bun run lint`
- [x] The four pre-existing skinned tests still pass unchanged — `lines[1]` is the meta row, `lines[2]` starts with `╭`, the last line starts with `╰`
- [x] With `droidSkin: false`, `render(60)` contains no `╭`, no `╰` and no `│ >`
- [x] With `droidSkin: false` and a working agent, no line contains the `workingLabel`
- [x] With `droidSkin: false`, `editor.setPaddingX(4)` then `editor.getPaddingX()` returns `4`
- [x] The skinned box path is untouched: `grep -c "prelude" extensions/fusion/editor.ts` returns 5, and `grep -n "Math.floor(terminalRows \* 0.3) - 2" extensions/fusion/editor.ts` still returns exactly one match

#### Manual Verification:
- [ ] None at this slice — the flag has no production caller until the wiring slice

---

## Phase 4: session_start gate + `/fusion-droid`

### Overview

Wire it together in `extensions/fusion/index.ts`: hoist the single warning-routed `loadConfig` above the skin install, store the flag in a factory-closure variable, gate the four install sites (prototype patches, tool one-shot, loader suppression, `agent_start` re-assert), forward the flag as the editor's 8th argument, and register `/fusion-droid`. `session_shutdown` stays UNCHANGED. Repair `tests/index.test.ts` and pin its config path.

Depends on Phases 1, 2 and 3. Carries the whole-suite green gate.

### Changes Required:

#### 1. Extension entrypoint
**File**: `extensions/fusion/index.ts`
**Changes**: import `DEFAULT_CONFIG` + the two resolvers; add the `droidSkin` closure flag; register `/fusion-droid`; hoist the config read; gate the four install sites; forward the flag to `createFusionEditor`; remove the old late read.

```ts
// index.ts:7-13 — DEFAULT_CONFIG joins the config import
import {
	DEFAULT_CONFIG,
	type FusionConfig,
	loadConfig,
	loadMode,
	saveConfig,
	saveMode,
} from "./config";

// index.ts:46-56 — the two new resolvers join the commands import
import {
	choiceValue,
	droidSkinCompletions,
	focusChoices,
	footerModeCompletions,
	isAskTool,
	isFocusMode,
	parseSoundCommand,
	resolveDroidSkin,
	resolveFooterMode,
	soundChoices,
	soundCompletions,
} from "./commands";

// index.ts:73 — the session flag, beside the tool latch
	let droidToolsInstalled = false;
	// Read ONCE per session in session_start: installDroidTools has no
	// unregister counterpart, so the skin cannot be taken back mid-session.
	// Deliberately not part of `sound` — /fusion-sound re-spreads that object.
	let droidSkin = DEFAULT_CONFIG.droidSkin;

// index.ts:272 — new command, registered right after /fusion
	pi.registerCommand("fusion-droid", {
		description:
			"Turn the droid transcript skin on or off (bare /fusion-droid toggles); restart pi to apply",
		getArgumentCompletions: (prefix) => droidSkinCompletions(prefix),
		handler: async (args, ctx) => {
			// Toggle against the PERSISTED value, not the session one: the session
			// flag is frozen at session_start, so two calls in one session would
			// otherwise flip to the same value twice. Same warning route as
			// session_start — an invalid persisted value must not default silently.
			const current = loadConfig((field) =>
				ctx.ui.notify(`fusiontui: invalid ${field} config; using default`, "warning"),
			).droidSkin;
			const next = resolveDroidSkin(args, current);
			saveConfig({ droidSkin: next });
			// "restart pi", not "next session": installDroidTools is a one-shot with
			// no unregisterTool counterpart, so tool cards registered in this
			// process survive /new.
			ctx.ui.notify(
				`fusiontui: droid skin = ${next ? "on" : "off"} (restart pi to apply)`,
				"info",
			);
		},
	});

// index.ts:445-454 — the single config read is hoisted above the skin install
		syncInteractive(ctx);
		void refreshGit(ctx);

		// One config read per session, routed through notify. Hoisted above the
		// skin install because droidSkin gates it; a second loadConfig call
		// would warn twice for the same present-but-invalid field.
		const config = loadConfig((field) =>
			ctx.ui.notify(`fusiontui: invalid ${field} config; using default`, "warning"),
		);
		sound = config;
		droidSkin = config.droidSkin;

		// Feed the droid skin the ACTIVE pi theme so its palette follows whatever
		// theme is selected (getter stays live across runtime theme switches).
		// Unconditional: hex() resolves its color mode through this provider.
		setPaletteThemeProvider(() => ctx.ui.theme);

		if (droidSkin) {
			patchAssistantIcon();
			patchUserGutter();
			patchToolFallbacks();
		}

// index.ts:456-476 — the tool one-shot gains the flag
		if (droidSkin && !droidToolsInstalled) {
			droidToolsInstalled = true;
			// …body unchanged…
		}

// index.ts:488-489 — the loader suppression gains the flag
		// Suppress Pi's loader row — the live status renders above the composer.
		// With the skin off there is no status row, so Pi's own loader stays.
		if (droidSkin) ctx.ui.setWorkingVisible(false);

// index.ts:505-510 — the editor factory forwards the flag as the 8th argument
			}), () => ctx.ui.getEditorComponent?.() === fusionEditorFactory, foreignEditorFactory, droidSkin);

// index.ts:529-534 — the old late read is removed; only the focus sync remains
		// Focus tracking for focus-sensitive sound modes.
		syncFocusReporting();
		focusInputParser.reset();

// index.ts:572 — the agent_start re-assert gains the flag
		if (droidSkin) patchToolFallbacks();
```

`session_shutdown` (`index.ts:648-679`) is deliberately UNCHANGED: `unpatchAssistantIcon` / `unpatchUserGutter` / `unpatchToolFallbacks` self-guard on their bookkeeping, and `ctx.ui.setWorkingVisible(true)` is idempotent on the host.

#### 2. Extension entrypoint tests
**File**: `tests/index.test.ts`
**Changes**: pin the config path per test with a mkdtemp fixture; repair the sorted command-list assertion; add a completion test and a `describe("droidSkin")` covering persistence, flag-on install, flag-off no-install, the `agent_start` re-assert trap, and flag-off shutdown cleanliness.

```ts
// imports
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ToolExecutionComponent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import activate from "../extensions/fusion/index";
import { FOOTER_MODES, setConfigPath } from "../extensions/fusion/config";

// tests/index.test.ts:12-17 — the docblock is updated: persistence is now safe here
/**
 * The extension entrypoint against a fake host. This covers the wiring — which
 * commands and lifecycle events exist — without a TUI. setConfigPath pins the
 * persisted config to a temp directory for the whole file, so activation and
 * the persisting handlers never read or write the developer's ~/.pi.
 */

// new file-level fixture, above activateFusion()
let configDir: string;
let configPath: string;

beforeEach(() => {
	configDir = mkdtempSync(join(tmpdir(), "fusiontui-index-"));
	configPath = join(configDir, "fusiontui.json");
	setConfigPath(configPath);
});

afterEach(() => {
	setConfigPath();
	rmSync(configDir, { recursive: true, force: true });
});

/** Seed the persisted config BEFORE activateFusion() — index.ts reads it at activation. */
const writeConfig = (patch: Record<string, unknown>) =>
	writeFileSync(configPath, JSON.stringify(patch));
const readConfig = () => JSON.parse(readFileSync(configPath, "utf8"));

// tests/index.test.ts:38-44 — the closed command set gains the new command
		expect([...commands.keys()].sort()).toEqual([
			"fusion",
			"fusion-droid",
			"fusion-follow",
			"fusion-hold",
			"fusion-redraw",
			"fusion-sound",
		]);

// new test beside the other completion tests
	test("/fusion-droid completes on and off", () => {
		const { commands } = activateFusion();
		const complete = commands.get("fusion-droid")!.getArgumentCompletions!;
		expect(complete("").map((o) => o.value)).toEqual(["on", "off"]);
		expect(complete("OF").map((o) => o.value)).toEqual(["off"]);
		expect(complete("zzz")).toEqual([]);
	});

// new describe, appended at the end of the file
describe("droidSkin", () => {
	test("/fusion-droid persists the flag and toggles against the file, not the session", async () => {
		const { commands, events } = activateFusion();
		const { ctx, calls } = makeCtx();
		try {
			await emit(events, "session_start", ctx);
			const handler = commands.get("fusion-droid")!.handler;
			await handler("off", ctx);
			expect(readConfig().droidSkin).toBe(false);
			await handler("", ctx); // bare = toggle, reading the file back
			expect(readConfig().droidSkin).toBe(true);
			expect(calls.notifications.at(-1)).toContain("droid skin = on");
			expect(calls.notifications.at(-1)).toContain("restart pi");
		} finally {
			await emit(events, "session_shutdown", ctx);
		}
	});

	test("with the flag on, session_start installs the seven droid tool cards", async () => {
		writeConfig({ droidSkin: true });
		const { events, tools } = activateFusion();
		const { ctx } = makeCtx();
		try {
			await emit(events, "session_start", ctx);
			expect(tools.map((t) => t.name).sort()).toEqual([
				"bash",
				"edit",
				"find",
				"grep",
				"ls",
				"read",
				"write",
			]);
		} finally {
			await emit(events, "session_shutdown", ctx);
		}
	});

	test("with the flag off, no tool cards install and Pi's loader is left alone", async () => {
		writeConfig({ droidSkin: false });
		const { events, tools } = activateFusion();
		const { ctx, calls, currentEditor } = makeCtx();
		try {
			await emit(events, "session_start", ctx);
			expect(tools).toEqual([]);
			expect(calls.workingVisible).toEqual([]);
			// Only the skin is gated — the footer and the composer still install.
			expect(calls.footers).toHaveLength(1);
			expect(typeof currentEditor()).toBe("function");
		} finally {
			await emit(events, "session_shutdown", ctx);
		}
	});

	// patchToolFallbacks' reclaim branch only fires once installedShell is set,
	// so an ungated agent_start re-assert would fall through to a FIRST install
	// and silently restore the skin one turn in.
	test("with the flag off, a turn does not re-install the tool patches", async () => {
		writeConfig({ droidSkin: false });
		const { events } = activateFusion();
		const { ctx } = makeCtx();
		const proto = ToolExecutionComponent.prototype as unknown as { render: unknown };
		const before = proto.render;
		try {
			await emit(events, "session_start", ctx);
			await emit(events, "agent_start", ctx);
			expect(proto.render).toBe(before);
		} finally {
			await emit(events, "session_shutdown", ctx);
		}
	});

	test("with the flag off, shutdown restores Pi's loader and leaves the prototypes clean", async () => {
		writeConfig({ droidSkin: false });
		const { events } = activateFusion();
		const { ctx, calls } = makeCtx();
		const proto = ToolExecutionComponent.prototype as unknown as { render: unknown };
		const before = proto.render;
		await emit(events, "session_start", ctx);
		await emit(events, "session_shutdown", ctx);
		expect(calls.workingVisible).toEqual([true]);
		expect(proto.render).toBe(before);
	});
});
```

### Success Criteria:

#### Automated Verification:
- [x] The whole gate passes: `bun run check` (lint + typecheck + the full suite)
- [x] `bun test tests/index.test.ts` passes, including the repaired command-list assertion at `tests/index.test.ts:38-44`
- [x] With no config file present, `session_start` still records `workingVisible === [false]` and shutdown `[false, true]` — the two existing assertions stay green UNCHANGED, because the default is `droidSkin: true`
- [x] With `{"droidSkin": false}`, `session_start` registers zero tools, records no `workingVisible` call, and still installs exactly one footer and one editor factory
- [x] With `{"droidSkin": false}`, emitting `agent_start` leaves `ToolExecutionComponent.prototype.render` identical
- [x] With `{"droidSkin": false}`, `session_shutdown` records `workingVisible === [true]` and leaves `ToolExecutionComponent.prototype.render` identical
- [x] `/fusion-droid off` writes `"droidSkin": false` to the pinned config file and a bare `/fusion-droid` flips it back to `true`
- [x] `grep -c "loadConfig(" extensions/fusion/index.ts` returns 3 — the activation-time silent read, the hoisted session read, and the `/fusion-droid` handler; the `session_start` read is the ONLY one inside the lifecycle handler, so no present-but-invalid field warns twice per session
- [x] `grep -c "if (droidSkin" extensions/fusion/index.ts` returns 4 — the prototype-patch block, the tool one-shot, the loader suppression and the `agent_start` re-assert
- [x] `grep -c "foreignEditorFactory, droidSkin)" extensions/fusion/index.ts` returns 1 — the editor factory forwards the flag as its 8th argument

#### Manual Verification:
- [ ] `/fusion-droid off` notifies `restart pi to apply` (not `next session`)
- [ ] `/fusion-droid off`, restart pi: tool calls render as Pi's native cards, assistant messages have no `⛬` gutter, the composer is Pi's native editor with the model/effort row above it, the fusiontui footer still renders, and Pi's spinner appears while the agent works
- [ ] `/fusion-droid on`, restart pi: the transcript is visually indistinguishable from today's skin
- [ ] `cat ~/.pi/fusiontui.json` is untouched by a full `bun test` run

---

## Plan Review (Step 4)

_Independent post-finalization review by artifact-code-reviewer and artifact-coverage-reviewer subagents. Findings triaged at Step 5._

| source | plan-loc | codebase-loc | severity | dimension | finding | recommendation | resolution |
| --- | --- | --- | --- | --- | --- | --- | --- |
| code | Phase 4 §1 (index.ts) | extensions/fusion/index.ts:456-476 | concern | code-quality | The `droidToolsInstalled` latch is never cleared and there is no `unregisterTool`, so turning the skin off and starting a *new session in the same pi process* (e.g. `/new`) re-reads `droidSkin: false` and skips every gate except the already-registered seven droid tool cards, leaving a half-applied skin that the notify text `"applies to the next session"` promises against | Change the notify string to name a process restart (`"restart pi to apply"`) so the guarantee matches the `installDroidTools` one-shot latch | applied: notify string is now `(restart pi to apply)` in Phase 4 §1 and §2, plus the Desired End State block and a new manual criterion |
| code | Phase 4 §1 (index.ts) | extensions/fusion/config.ts:71-74 | suggestion | code-quality | The `/fusion-droid` handler calls `loadConfig()` with no `onWarning` callback, so a present-but-invalid persisted `droidSkin` (e.g. `"off"`) is silently defaulted while every other read in `session_start` routes the same warning to `ctx.ui.notify` | Pass the same `(field) => ctx.ui.notify(...)` callback into the handler's `loadConfig` call | applied: handler now calls `loadConfig((field) => ctx.ui.notify(...))` for `current` |
| code | Phase 1 §1 (config.ts) | extensions/fusion/config.ts:121-129 | suggestion | codebase-fit | `loadMode()`/`saveMode()` are documented as reading `CONFIG_PATH`, but after the seam they route through the mutable `activePath` — the existing docblock at `CONFIG_PATH` no longer describes the wrappers | Update the `CONFIG_PATH` docblock to name `activePath` as the wrapper-bound value | applied: `CONFIG_PATH` docblock added in Phase 1 §1 naming `activePath` as the wrapper-bound value |
| code | Phase 3 (Overview) / Desired End State | node_modules/@earendil-works/pi-tui/dist/components/editor.js:397-409 | suggestion | actionability | The skin-off mock shows `> type here` above a single rule, but pi-tui's `Editor.render` emits no prompt glyph at all and always pushes a **top** rule, so `[metaRow(w), ...baseRender(w)]` actually renders meta / `───` / text / `───` | Correct the Desired End State block to show the top rule and drop the `>` chevron | applied: Desired End State skin-off mock now shows meta / top rule / text / bottom rule with no chevron |
| code | Phase 4 (Success Criteria) | <n/a> | suggestion | actionability | `grep -c "droidSkin" extensions/fusion/index.ts` "covers all five gate sites plus the declaration…" states no expected count, unlike the numeric grep criteria in Phases 1 and 3, so it cannot be checked off mechanically | Replace with an explicit expected count (`returns 8`) matching the declaration + 5 gate sites + handler lines | applied: replaced with two mechanical greps — `grep -c "if (droidSkin"` returns 4 and `grep -c "foreignEditorFactory, droidSkin)"` returns 1; the fragile `loadConfig((field)` count was also dropped |

_Coverage review: all nine `## Verification Notes` intents from the parent design resolved on at least one path; no uncovered entries._

## Testing Strategy

### Automated:
- `bun test tests/config.test.ts` — Phase 1
- `bun test tests/commands.test.ts` — Phase 2
- `bun test tests/editor-compose.test.ts` — Phase 3
- `bun run check` (lint + typecheck + full suite) — Phase 4 gate
- `bun run typecheck` and `bun run lint` after every phase touching production TypeScript

### Manual Testing Steps:
1. `/fusion-droid off`, restart pi — confirm no droid tool cards, no `⛬` assistant icon, no user gutter, native composer with the model/effort row above it, footer still present, Pi's spinner while working.
2. `/fusion-droid on`, restart pi — confirm the transcript is indistinguishable from today's skin.
3. `cat ~/.pi/fusiontui.json` after a full `bun test` run — confirm it is untouched.
4. Put `{"droidSkin": "off"}` in the config and start a session — confirm exactly one `invalid droidSkin config; using default` warning and the skin on.

## Performance Considerations

- No additional filesystem read: the `session_start` `loadConfig` call is hoisted, not duplicated. The two activation-time reads (`index.ts:72`, `:113`) are unchanged.
- The flag-off path strictly does less work: no prototype patching, no seven `registerTool` calls, no `statusLine` invocation and therefore no 50 ms ticker subscription (`editor.ts:208-213`, `droid-shimmer.ts:13-34`).
- The skin-off render skips the rule-detection scan, the content-budget arithmetic and the box construction (`editor.ts:274-329`).

## Migration Notes

None. An absent `droidSkin` key loads as `true`, which is byte-identical to today's behaviour. `saveConfigTo` preserves unknown keys, so downgrading to a build without the field leaves the key inert on disk.

## Developer Context

Carried from the design artifact's `## Developer Context`:

- **Box and chevron with `droidSkin: false`?** They go — Pi's native editor rendering with the `metaRow` kept.
- **Does `tests/index.test.ts` scope change?** Yes — fix both broken assertions and cover the gate there.
- **Which test seam?** An exported setter over module state, modelled on `setPaletteThemeProvider`.
- **Bare `/fusion-droid`?** Toggle — `on` → true, `off` → false, empty or unknown → `!current`.
- **New editor parameter shape?** 8th positional parameter at the end.
- **README?** Out of scope (reversed at decomposition).
- **Blank status row in skin-off mode?** Dropped — `[metaRow(w), ...baseRender(w)]`.

Ratified deviation (design Slice 4 micro-checkpoint): the `/fusion-droid` handler sources `current` from disk (`loadConfig().droidSkin`) rather than live state as `/fusion` does, because the session flag is frozen at `session_start`.

## References

- Design: `.rpiv/artifacts/designs/2026-07-26_23-35-14_droid-skin-toggle.md`
- Research: `.rpiv/artifacts/research/2026-07-26_23-20-50_droid-skin-toggle.md`
- Discover / FRD: `.rpiv/artifacts/discover/2026-07-26_23-14-24_droid-skin-toggle.md`
- Architecture review: `.rpiv/artifacts/architecture-reviews/pi-fusiontui_rendering-and-tui.md` — L1-01, L1-02, L3-04, L3-05
