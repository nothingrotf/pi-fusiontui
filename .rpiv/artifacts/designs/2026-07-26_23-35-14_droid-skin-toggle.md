---
date: 2026-07-26T23:35:14-0300
author: Gabriel Aguiar
commit: 2d62b78
branch: main
repository: pi-fusiontui
topic: "droidSkin toggle — disable the droid skin, keep footer + model/effort row"
tags: [design, config, commands, session-lifecycle, editor, droid-skin]
status: ready
parent: .rpiv/artifacts/research/2026-07-26_23-20-50_droid-skin-toggle.md
last_updated: 2026-07-26T23:35:14-0300
last_updated_by: Gabriel Aguiar
---

# Design: droidSkin toggle

## Summary

Add a persisted boolean `droidSkin` (default `true`) to `~/.pi/fusiontui.json`, flipped by a new `/fusion-droid [on|off]` command and read exactly once per session in `session_start`. The flag lives in a factory-closure variable and gates only the **install** half of the droid skin — the prototype patches, the tool-card overrides, the loader suppression, and the editor's droid chrome. Teardown stays ungated because every unpatch is self-guarded and `setWorkingVisible(true)` is idempotent.

## Requirements

- `droidSkin: boolean`, default `true`, persisted in `~/.pi/fusiontui.json`.
- Warn (once, via the existing `onWarning` route) when the key is present but not a boolean; fall back to the default.
- Read once during `session_start`; later edits apply on the next session.
- With the flag off: no droid tool cards, no `⛬` assistant icon, no user gutter, no droid tool fallbacks.
- With the flag off: the editor keeps the model/effort `metaRow` but renders pi's native editor beneath it — no rounded box, no `>` chevron, no droid status row, no shimmer ticker.
- With the flag off: pi's native working spinner returns (`setWorkingVisible(false)` is skipped).
- `/fusion-droid` registers with a description, `on`/`off` completions, persists via `saveConfig`, and notifies that the change applies next session.
- Footer, sounds, scroll-lock, git and usage behaviour are unchanged either way.
- `bun test` exits 0, including the two existing assertions this change breaks.

## Current State Analysis

The droid skin is installed unconditionally inside one `session_start` handler and torn down inside one `session_shutdown` handler. Nothing today can turn any part of it off.

### Key Discoveries

- **The install sites are four, not three.** `patchAssistantIcon()` / `patchUserGutter()` / `patchToolFallbacks()` (`extensions/fusion/index.ts:452-454`), the tool one-shot (`:460-474`), `ctx.ui.setWorkingVisible(false)` (`:489`), and the `agent_start` re-assert `patchToolFallbacks()` (`:572`).
- **The `agent_start` re-assert must be gated or the toggle self-destructs.** `patchToolFallbacks`'s early-return reclaim branch only fires when `installedShell` is truthy (`extensions/fusion/droid-patches.ts:42`); in a flag-off session it is `undefined`, so an ungated `:572` falls through to the first-install branch and installs the full tool skin at the first turn.
- **Teardown is already safe when the patch never ran.** `unpatchToolFallbacks` returns early on `!installedShell` (`droid-patches.ts:107`), `unpatchAssistantIcon` on `!originalRender` (`:199`), `unpatchUserGutter` on `!originalUserRender` (`:271`); `tests/droid-patches.test.ts:87-88` and `:149-150` already assert double-unpatch safety.
- **`metaRow` is skin-free.** `extensions/fusion/editor.ts:237-249` reads only `uiTheme` through `fg()` (`extensions/fusion/theme.ts:23-29`). The droid chrome is the box (`editor.ts:307`, `DROID[BORDER_KEYS[...]]`) and the chevron (`:308`, `DROID.primary`).
- **The palette provider must stay live regardless.** `colorMode()` reads `themeProvider?.()?.getColorMode?.()` (`extensions/fusion/droid-palette.ts:203-209`) to pick the ANSI family for every `hex()` call.
- **A box-free render shape already exists.** The `w <= 8` branch (`editor.ts:257-266`) and the `base.length < 2` branch (`:270-272`) both emit `[status, metaLine, ...base]` with no box.
- **The ticker subscription only exists on the `statusLine` path** (`editor.ts:208-213`, released at `:205`, `:215`, `:337`). Skipping `statusLine` means `dispose()` degenerates to `baseDispose?.()`, which stays correct.
- **The only warning-routed config read is late.** `sound = loadConfig(onWarning)` sits at `index.ts:531-533`, ~80 lines after the first skin consumer. `loadConfig` is fully synchronous (`config.ts:121-124` → `readFileSync`), so hoisting it is safe; a second call would double-warn.
- **`tests/index.test.ts` exists** (`be77b55`) and two exact-array assertions break: the sorted command list (`tests/index.test.ts:38-44`) and `calls.workingVisible` (`:167`, `:181`).
- **The index suite reads the developer's real config.** `index.ts:72` (`loadMode()`) and `:113` (`loadConfig()`) bind `CONFIG_PATH` from `homedir()` (`config.ts:29`), which ignores `$HOME` (docblock `config.ts:23-28`). `CONFIG_PATH` is referenced nowhere outside `config.ts`.
- **No boolean field or boolean guard exists yet.** All four current fields are enums or sound strings (`config.ts:32-43`).
- **Every prior config field shipped with a broken validator** and needed a follow-up (`4ab3e97`, `dbd7df0`).

## Scope

### Building

- `droidSkin` field, default, `isBoolean` guard, parse + warn, return-literal entry in `extensions/fusion/config.ts`.
- A `setConfigPath(path?)` seam over the module-level active config path, mirroring `setPaletteThemeProvider`.
- `DROID_SKIN_ARGS`, `resolveDroidSkin`, `droidSkinCompletions` in `extensions/fusion/commands.ts`.
- An eighth positional `droidSkin` parameter on `createFusionEditor` and a skin-off render branch in `extensions/fusion/editor.ts`.
- The hoisted config read, the closure flag, the four gates, and the `/fusion-droid` command in `extensions/fusion/index.ts`.
- Test coverage in `tests/config.test.ts`, `tests/commands.test.ts`, `tests/editor-compose.test.ts`, `tests/index.test.ts`.

### Not Building

- **README / docs** — explicitly removed from scope by the developer at decomposition, despite the `a38a39b` / `791d912` / `35f460b` precedent of documenting new settings in the same commit.
- Granular per-piece flags (separate toggles for cards / icon / editor).
- Live mid-session toggling — there is no `unregisterTool` (`loader.js:195-202`), so the flag is read once at `session_start`.
- Moving the model/effort row into the footer.
- Any change to sounds, scroll-lock, git, usage, or the footer.
- Gating `session_shutdown` (`index.ts:660-671`) — deliberately ungated.
- Changing the prelude row count in the **skinned** render path; the box branch keeps its two-row prelude and its `:294` / `:296` / `:322-324` constants untouched.

## Decisions

### One boolean flag, not granular per-piece flags

Inherited from discover. A single `droidSkin` boolean kills the whole droid visual layer. Fewer states to reason about and to test; the stated intent is one "pi puro" mode.

### Read once at `session_start`, restart to apply

`installDroidTools` (`extensions/fusion/droid-cards.ts:260-288`) registers same-name overrides through `pi.registerTool`, which has no inverse on the extension API. The flag therefore cannot be honoured mid-session. The command persists and notifies; the next session picks it up.

### The flag lives in a factory-closure variable, not in `sound`

`sound` is typed `Pick<FusionConfig, "completionSound" | "awaitingInputSound" | "soundFocusMode">` (`extensions/fusion/index.ts:110-113`) and is re-spread by `/fusion-sound` (`:186`, `:192`). A separate `let droidSkin = DEFAULT_CONFIG.droidSkin;` beside `droidToolsInstalled` (`:73`) keeps the restart-only semantics for free — the `/fusion-sound` spreads can never touch it.

### Hoist the single warning-routed `loadConfig`, do not add a second one

**Ambiguity**: the flag is needed before `index.ts:452`, but the only `onWarning`-routed read is at `:531`.

**Explored**:
- **A — second `loadConfig` call early**: simplest diff, but `loadConfigFrom` warns per present-but-invalid field on every call (`config.ts:74-77`), so an invalid field would notify twice.
- **B — hoist the existing call**: `loadConfig` is synchronous (`config.ts:121-124`), `ctx.ui.notify` is legal anywhere after the `hasUI` guard (`index.ts:436`; the skipped-tools notify at `:470-473` already fires before `installFooter`), and `sound` only has to be assigned before `syncFocusReporting()` at `:534`.

**Decision**: B. One `const config = loadConfig(onWarning)` placed right after `syncActivity()`, feeding both `sound` and `droidSkin`.

### Gate the install half only; leave teardown ungated

**Ambiguity**: should `session_shutdown` mirror the gate?

**Explored**:
- **A — mirror the gate**: symmetric-looking, but the patch bookkeeping lives in `droid-patches.ts` module scope (`:26-37`, `:137-142`, `:223-228`), which survives `/new`/`/resume`/`/fork` and is discarded on `/reload`. A skipped unpatch can strand a prototype whose only restorer is about to be garbage-collected.
- **B — leave it ungated**: every unpatch already no-ops when unpatched (`droid-patches.ts:107`, `:199`, `:271`), and `setWorkingVisible(true)` is idempotent on the host (`interactive-mode.js:188`, `:1421-1435`).

**Decision**: B. The gate touches `index.ts:452-454`, `:460-474`, `:489` and `:572` only.

### `resolveDroidSkin(args, current)` follows the `/fusion` convention verbatim

`resolveFooterMode` (`extensions/fusion/commands.ts:101-106`) documents it: a named value is selected verbatim, anything else — including no argument — advances the cycle. Over a two-value domain that *is* a toggle, so `on` → `true`, `off` → `false`, empty or unknown → `!current`. Parsing stays in the pure layer (`commands.ts:11-16`); `index.ts` keeps only the persistence + notify shell. This is exactly what `1b8748b` and `d971fe1` had to retrofit for `/fusion`.

**Deviation from the `/fusion` shell, ratified at the Slice 4 micro-checkpoint**: `/fusion` sources `current` from live state (`index.ts:265`, `resolveFooterMode(args, state.mode)`), but the `droidSkin` session variable is frozen at `session_start`, so a bare `/fusion-droid` called twice in one session would resolve `on` → `off` → `off`. The handler therefore sources `current` from disk — `resolveDroidSkin(args, loadConfig().droidSkin)` — which is also the value the next session will read. That makes the handler `loadConfig` + `saveConfig` + `ctx.ui.notify` rather than the two-call shell the `/fusion` precedent uses.

### Eighth positional parameter on `createFusionEditor`

**Ambiguity**: an 8th positional parameter versus an options-object refactor.

**Explored**:
- **A — 8th positional**: `droidSkin: boolean = true` after `innerFactory` (`extensions/fusion/editor.ts:138`). All five existing test call sites (`tests/editor-compose.test.ts:70`, `:88`, `:112`, `:126`, `:141`) keep compiling untouched. Propagates a positional tail that already forces `() => true` placeholders at `:112` and `:126`.
- **B — options object**: cleaner call sites, but rewrites all six call sites for one boolean.

**Decision**: A, confirmed by the developer as the direction.

### Skin-off render drops the blank status row

**Ambiguity**: with `statusLine` suppressed, keep a permanently blank prelude row or drop it?

**Explored**:
- **A — drop it**: render becomes `[metaRow(w), ...baseRender(w)]`. Height is still constant (`metaRow` already returns `""` when there is no model, `editor.ts:238-239`), and the 2-row prelude constants at `:294`, `:296`, `:322-324` live inside the box branch, which never runs with the skin off.
- **B — keep it blank**: maximal fidelity to the L3-04 invariant and to the index-based test assertions, at the cost of a permanently empty top row.

**Decision**: A.

### Skin-off does not lock the editor padding

The padding lock (`editor.ts:186-190`) exists because "the bubble math assumes zero native padding". With no bubble, there is no width arithmetic to protect, so the lock is applied only on the skinned path and the user's `editorPaddingX` survives.

### `setConfigPath(path?)` seam, modelled on `setPaletteThemeProvider`

**Ambiguity**: `index.ts` reads the real `~/.pi/fusiontui.json` through zero-arg wrappers (`index.ts:72`, `:113`, and the hoisted read), so a `droidSkin` gate would make `tests/index.test.ts` machine-dependent.

**Explored**:
- **A — exported setter over module state**: `droid-palette.ts:40-45` is the in-repo precedent, and `tests/droid-palette.test.ts:13-16` is the in-repo reset idiom.
- **B — thread a path parameter into `activate(pi)`**: no precedent; `ExtensionAPI` is the host's type and the test fake is already an `as unknown as` cast.
- **C — `mock.module` / `spyOn`**: zero occurrences anywhere in `tests/`.

**Decision**: A. `CONFIG_PATH` stays an exported `const` (the production default, referenced nowhere else); a module-level `activePath` is what the wrappers read, and `setConfigPath(undefined)` restores the default.

### Leave `droidToolsInstalled` untouched when the flag is off

The latch is a factory-closure variable (`index.ts:73`) and the closure is rebuilt on every session (`loader.js:343-377`), so no code path re-tests it within a flag-off session. Setting it inside the gated branch only is the smallest diff and behaviourally identical.

## Architecture

### extensions/fusion/config.ts — MODIFY

```ts
// config.ts:29 — after the existing CONFIG_PATH declaration
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
	 * session, so a change only applies to the next session.
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

### extensions/fusion/commands.ts — MODIFY

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

### extensions/fusion/editor.ts — MODIFY

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

### extensions/fusion/index.ts — MODIFY

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
			"Turn the droid transcript skin on or off (bare /fusion-droid toggles); applies to the next session",
		getArgumentCompletions: (prefix) => droidSkinCompletions(prefix),
		handler: async (args, ctx) => {
			// Toggle against the PERSISTED value, not the session one: the session
			// flag is frozen at session_start, so two calls in one session would
			// otherwise flip to the same value twice.
			const next = resolveDroidSkin(args, loadConfig().droidSkin);
			saveConfig({ droidSkin: next });
			ctx.ui.notify(
				`fusiontui: droid skin = ${next ? "on" : "off"} (applies to the next session)`,
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

### tests/config.test.ts — MODIFY

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

### tests/commands.test.ts — MODIFY

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

### tests/editor-compose.test.ts — MODIFY

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

### tests/index.test.ts — MODIFY

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
			expect(calls.notifications.at(-1)).toContain("next session");
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

## Slices

### Slice 1: Config field + path seam

**Files**: `extensions/fusion/config.ts`, `tests/config.test.ts`

#### Automated Verification:
- [ ] Config tests pass: `bun test tests/config.test.ts`
- [ ] Type checking passes: `bun run typecheck`
- [ ] `grep -n "droidSkin" extensions/fusion/config.ts | wc -l` returns 5 (interface, DEFAULT_CONFIG, value line, warn line, return literal)
- [ ] `grep -n "activePath" extensions/fusion/config.ts | wc -l` returns 4 (declaration, setter, loadConfig, saveConfig)
- [ ] A `{"droidSkin": false}` file loads as `false` and produces an empty warning list
- [ ] A `{"droidSkin": "off"}` file loads as `true` and warns exactly `["droidSkin"]`
- [ ] `saveConfigTo(path, { droidSkin: false })` leaves unknown keys structurally unchanged on a raw `JSON.parse` read (`expect(read()).toEqual(...)`)

#### Manual Verification:
- [ ] `cat ~/.pi/fusiontui.json` is unchanged after `bun test tests/config.test.ts` — the new setConfigPath tests write only into the mkdtemp directory

### Slice 2: Command resolver + completions

**Files**: `extensions/fusion/commands.ts`, `tests/commands.test.ts`

#### Automated Verification:
- [ ] Command tests pass: `bun test tests/commands.test.ts`
- [ ] Type checking passes: `bun run typecheck`
- [ ] Lint passes: `bun run lint`
- [ ] `resolveDroidSkin("sideways", c)` equals `resolveDroidSkin("", c)` for both values of `c` — unknown ≡ empty, the same property `resolveFooterMode` is held to in `describe("resolveFooterMode")`
- [ ] `droidSkinCompletions("")` returns `["on", "off"]` and `droidSkinCompletions("zzz")` returns `[]`
- [ ] `grep -n "ctx\." extensions/fusion/commands.ts` returns no match — the pure-layer contract at `extensions/fusion/commands.ts:11-16` still holds

#### Manual Verification:
- [ ] None — this slice is pure string→value logic with no runtime surface until the command is registered

### Slice 3: Editor skin-off render

**Files**: `extensions/fusion/editor.ts`, `tests/editor-compose.test.ts`

#### Automated Verification:
- [ ] Editor tests pass: `bun test tests/editor-compose.test.ts`
- [ ] Type checking passes: `bun run typecheck`
- [ ] Lint passes: `bun run lint`
- [ ] The four pre-existing skinned tests still pass unchanged — `lines[1]` is the meta row, `lines[2]` starts with `╭`, the last line starts with `╰`
- [ ] With `droidSkin: false`, `render(60)` contains no `╭`, no `╰` and no `│ >`
- [ ] With `droidSkin: false` and a working agent, no line contains the `workingLabel`
- [ ] With `droidSkin: false`, `editor.setPaddingX(4)` then `editor.getPaddingX()` returns `4`
- [ ] The skinned box path is untouched: `grep -c "prelude" extensions/fusion/editor.ts` returns 5, and `grep -n "Math.floor(terminalRows \* 0.3) - 2" extensions/fusion/editor.ts` still returns exactly one match

#### Manual Verification:
- [ ] None at this slice — the flag has no production caller until the wiring slice

### Slice 4: session_start gate + `/fusion-droid`

**Files**: `extensions/fusion/index.ts`, `tests/index.test.ts`

#### Automated Verification:
- [ ] The whole gate passes: `bun run check` (lint + typecheck + the full suite)
- [ ] `bun test tests/index.test.ts` passes, including the repaired command-list assertion at `tests/index.test.ts:38-44`
- [ ] With no config file present, `session_start` still records `workingVisible === [false]` and shutdown `[false, true]` — the two existing assertions stay green UNCHANGED, because the default is `droidSkin: true`
- [ ] With `{"droidSkin": false}`, `session_start` registers zero tools, records no `workingVisible` call, and still installs exactly one footer and one editor factory
- [ ] With `{"droidSkin": false}`, emitting `agent_start` leaves `ToolExecutionComponent.prototype.render` identical
- [ ] With `{"droidSkin": false}`, `session_shutdown` records `workingVisible === [true]` and leaves `ToolExecutionComponent.prototype.render` identical
- [ ] `/fusion-droid off` writes `"droidSkin": false` to the pinned config file and a bare `/fusion-droid` flips it back to `true`
- [ ] `grep -c "loadConfig(" extensions/fusion/index.ts` returns 3 — the activation-time silent read, the hoisted session read, and the `/fusion-droid` handler — and `grep -c "loadConfig((field)" extensions/fusion/index.ts` returns 1, proving the warning-routed read is not duplicated
- [ ] `grep -c "droidSkin" extensions/fusion/index.ts` covers all five gate sites plus the declaration, the command handler and the editor argument

#### Manual Verification:
- [ ] `/fusion-droid off`, restart pi: tool calls render as Pi's native cards, assistant messages have no `⛬` gutter, the composer is Pi's native editor with the model/effort row above it, the fusiontui footer still renders, and Pi's spinner appears while the agent works
- [ ] `/fusion-droid on`, restart pi: the transcript is visually indistinguishable from today's skin
- [ ] `cat ~/.pi/fusiontui.json` is untouched by a full `bun test` run

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
› fusiontui: droid skin = off (applies to the next session)

/fusion-droid
› fusiontui: droid skin = on (applies to the next session)
```

With `droidSkin: false`, after a restart:

```
                                            claude-opus-4-8 (High)
> type here
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

## File Map

```
extensions/fusion/config.ts       # MODIFY — droidSkin field + isBoolean guard + setConfigPath seam
extensions/fusion/commands.ts     # MODIFY — DROID_SKIN_ARGS, resolveDroidSkin, droidSkinCompletions
extensions/fusion/editor.ts       # MODIFY — 8th positional droidSkin param + skin-off render branch
extensions/fusion/index.ts        # MODIFY — hoisted config read, closure flag, 4 gates, /fusion-droid
tests/config.test.ts              # MODIFY — boolean field load/warn/round-trip + setConfigPath
tests/commands.test.ts            # MODIFY — resolveDroidSkin + droidSkinCompletions
tests/editor-compose.test.ts      # MODIFY — skin-off render shape
tests/index.test.ts               # MODIFY — fix 2 broken assertions + gate coverage
```

## Ordering Constraints

- Slice 1 first: `DEFAULT_CONFIG.droidSkin` and `setConfigPath` are referenced by Slice 4.
- Slice 2 before Slice 4: `resolveDroidSkin` / `droidSkinCompletions` are imported by the command registration.
- Slice 3 before Slice 4: the 8th `createFusionEditor` parameter must exist before `index.ts` passes it.
- Slices 2 and 3 are independent of each other and could be implemented in parallel.
- Slice 4 last: it is the only slice that can turn the feature on end-to-end, and it carries the whole-suite green gate.

## Verification Notes

- **`false` must survive the load path.** A round-trip test whose value equals the default proves nothing — `droidSkin: false` is the only discriminating case (research, `tests/config.test.ts:159-164` analogy).
- **`false` must not warn.** The type-guard ternary idiom is falsy-safe; the `normalizeSoundValue`-style `!local` warn idiom is not. Assert an empty `warned` array for `{"droidSkin": false}`.
- **Unknown keys must survive a boolean patch** — `saveConfigTo` merges over `readRawFrom` (`config.ts:100`); mirror `tests/config.test.ts:119-124` with a raw `read()` so the literal token on disk is observed.
- **The `agent_start` re-assert is the silent-failure trap.** Without gating `index.ts:572`, a flag-off session re-installs the tool skin at the first turn. Cover it by emitting `agent_start` in the flag-off index test and asserting the tool array is still empty.
- **Do not change the skinned prelude row count.** L3-04 (High, accepted) in `.rpiv/artifacts/architecture-reviews/pi-fusiontui_rendering-and-tui.md`; the constants at `editor.ts:294`, `:296`, `:322-324` assume two prelude rows.
- **Install/teardown asymmetry caused a five-fix cluster in 24h** (`4ab3e97`, `7a9498f`, `00bda59`, `0a3ca8a`). Confirm shutdown stays ungated and that a flag-off session's shutdown still leaves the prototypes clean.
- **Every prior config field shipped with a broken validator** (`4ab3e97`, `dbd7df0`) — the guard, the warn call and the negative test go in the same slice.
- **`tests/index.test.ts` must not depend on the developer's real `~/.pi`.** Every test that activates the extension has to pin the config path; the reset belongs in `afterEach`, mirroring `tests/droid-palette.test.ts:13-16`.
- Existing index assertions to repair: `tests/index.test.ts:38-44` (sorted command list) and `:167` / `:181` (`workingVisible`).

## Performance Considerations

- No additional filesystem read: the `session_start` `loadConfig` call is hoisted, not duplicated. The two activation-time reads (`index.ts:72`, `:113`) are unchanged.
- The flag-off path strictly does less work: no prototype patching, no seven `registerTool` calls, no `statusLine` invocation and therefore no 50 ms ticker subscription (`editor.ts:208-213`, `droid-shimmer.ts:13-34`).
- The skin-off render skips the rule-detection scan, the content-budget arithmetic and the box construction (`editor.ts:274-329`).

## Migration Notes

None. An absent `droidSkin` key loads as `true`, which is byte-identical to today's behaviour. `saveConfigTo` preserves unknown keys, so downgrading to a build without the field leaves the key inert on disk.

## Pattern References

- `extensions/fusion/config.ts:52-54`, `:79-80` — the `isFooterMode` guard + ternary + `warnInvalid` triple; the exact shape `droidSkin` copies.
- `extensions/fusion/droid-palette.ts:40-45` — module-level state + exported setter; the `setConfigPath` template.
- `tests/droid-palette.test.ts:13-16` — `afterEach` reset of a module-level seam.
- `extensions/fusion/commands.ts:101-115` — `resolveFooterMode` + `footerModeCompletions`; the resolver and completions shape.
- `extensions/fusion/index.ts:261-271` — the `/fusion` registration; the `/fusion-droid` template.
- `tests/commands.test.ts:150-183` — resolver test structure (verbatim selection, cycle, unknown ≡ empty, completions).
- `tests/index.test.ts:180-190` — the "installs nothing" negative-gate test; the shape a flag-off lifecycle test follows.
- `extensions/fusion/editor.ts:257-266` — the existing box-free `[status, metaLine, ...base]` return shape.

## Developer Context

**Q (`extensions/fusion/editor.ts:307-308` vs `:237-249`): `metaRow` uses only the pi theme; the rounded box and the `>` chevron are the actual droid chrome. With `droidSkin: false`, do the box and chevron stay or go?**
A: They go — pi's native editor rendering with the metaRow kept.

**Q (`tests/index.test.ts:38-44`, `:167`, `:181`): the harness exists (contra the FRD) and two exact-array assertions break. Does the test scope change?**
A: Yes — fix both and cover the gate in `tests/index.test.ts`.

**Q (`extensions/fusion/index.ts:72`, `:113` + `extensions/fusion/config.ts:29`): the index suite reads the developer's real config and `os.homedir()` ignores `$HOME`. Which seam?**
A: An exported setter over module state, modelled on `setPaletteThemeProvider`.

**Q (`extensions/fusion/commands.ts:101-106`): what does a bare `/fusion-droid` do?**
A: Toggle — `on` → true, `off` → false, empty or unknown → `!current`.

**Q (`extensions/fusion/editor.ts:131-138`, 5 call sites in `tests/editor-compose.test.ts`): follow the positional convention for the new parameter?**
A: Follow it — 8th positional parameter at the end.

**Q (`README.md:51-55`, precedent `a38a39b` / `791d912` / `35f460b`): update the README in the same change?**
A: Initially yes, then reversed at decomposition — the README slice was removed from scope.

**Q (`editor.ts:206-210`, `:294`, `:296`, `:322-324`): keep a permanently blank status row in skin-off mode, or drop it?**
A: Drop it — `[metaRow(w), ...baseRender(w)]`.

## Design History

- Slice 1: Config field + path seam — approved as generated (slice-verifier: 1 VIOLATION + 2 WARNINGs on the first pass — manual criterion forward-referenced Slice 4, the seam reset was describe-scoped instead of file-level, and a criterion claimed byte-identity it could not observe; all three fixed, re-verified OK)
- Slice 2: Command resolver + completions — approved as generated (slice-verifier: Decisions/Cross-slice OK, 2 criterion-wording WARNINGs fixed before approval — the purity grep matched the docblock itself at `commands.ts:14`, and a criterion cited a test line number this same slice shifts)
- Slice 3: Editor skin-off render — approved as generated (slice-verifier: Decisions/Cross-slice OK, 3 criterion WARNINGs fixed before approval — the L3-04 guard grep could not reach the `- 2` base-budget constant at `editor.ts:294`, a criterion promised a `╰` assertion the test did not make, and the `bun run lint` gate was missing from a slice that edits production TypeScript)
- Slice 4: session_start gate + `/fusion-droid` — approved as generated, with one ratified deviation. slice-verifier raised `Decisions: VIOLATION` — the handler adds a third config call, `resolveDroidSkin(args, loadConfig().droidSkin)`, sourcing `current` from disk instead of live state as `/fusion` does at `index.ts:265`. Surfaced at the micro-checkpoint and ratified by the developer as by-design (the session flag is frozen at `session_start`, so an in-memory toggle would resolve `on` → `off` → `off`); the `## Decisions` entry was amended to record the deviation. Four criterion WARNINGs also fixed: a claimed `workingVisible` "repair" that is not needed (the default keeps them green), an uncheckable `grep` pass condition, a "byte-identical" over-claim, and a missing post-shutdown prototype-cleanliness assertion (test added).

## References

- `.rpiv/artifacts/research/2026-07-26_23-20-50_droid-skin-toggle.md` — parent research
- `.rpiv/artifacts/discover/2026-07-26_23-14-24_droid-skin-toggle.md` — source FRD (two constraint bullets falsified by research)
- `.rpiv/artifacts/architecture-reviews/pi-fusiontui_rendering-and-tui.md` — L1-01, L1-02, L3-04, L3-05
- Precedent commits: `a38a39b`, `791d912`, `35f460b`, `4ab3e97`, `dbd7df0`, `1b8748b`, `d971fe1`, `be77b55`
