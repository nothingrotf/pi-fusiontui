---
date: 2026-07-26T23:20:50-0300
author: Gabriel Aguiar
commit: 2d62b78
branch: main
repository: pi-fusiontui
topic: "droidSkin toggle — gate the droid skin at session_start, keep footer + metaRow"
tags: [research, codebase, config, commands, session-lifecycle, editor, droid-patches, tests]
status: ready
last_updated: 2026-07-26T23:20:50-0300
last_updated_by: Gabriel Aguiar
---

# Research: droidSkin toggle — gate the droid skin at session_start, keep footer + metaRow

## Research Question
Add `droidSkin: boolean` (default `true`) to `~/.pi/fusiontui.json` with an `isBoolean` guard in `extensions/fusion/config.ts`, register `/fusion-droid` in `extensions/fusion/index.ts` alongside `/fusion`, and gate the `session_start` install block on the loaded flag — skipping `installDroidTools`, the three `patch*` calls (including the `agent_start` re-assert) and `setWorkingVisible(false)` — while keeping the footer and the model/effort `metaRow`.

Source FRD: `.rpiv/artifacts/discover/2026-07-26_23-14-24_droid-skin-toggle.md`.

## Summary

The change is mechanically small but sits on top of the repo's two most fix-prone areas: the `session_start` install block and the editor render prelude. Five findings dominate.

1. **Two FRD claims are false.** `tests/index.test.ts` exists (279 lines, fake host, shipped in `be77b55`), and `metaRow` does **not** use the DROID palette — it reads only the pi `Theme` via `fg()`. What *is* droid in the editor is the rounded box and the `>` chevron.
2. **The flag must be read before `extensions/fusion/index.ts:452`** (the first skin consumer, `patchAssistantIcon`). The only warning-routed `loadConfig` call is ~80 lines later at `:531` and must be hoisted, not duplicated — a second call would double-warn.
3. **Only the install half needs gating.** Every `unpatch*` is self-guarded (`droid-patches.ts:107`, `:199`, `:271`) and `setWorkingVisible(true)` is idempotent on the host (`interactive-mode.js:188`, `:1421-1435`), so `session_shutdown` (`index.ts:667-671`) must stay ungated — gating it would risk a permanent prototype leak on `/reload`.
4. **The prelude must stay two rows.** `editor.ts:294`, `:296` and `:322-324` hard-code a 2-row prelude, and dropping a prelude row is the exact defect L3-04 documents (High severity, arch review). The safe shape is "status row returns `""` unconditionally when the skin is off".
5. **`index.ts` reads the developer's real `~/.pi/fusiontui.json`** (`:71`, `:105`, `:519`/`:531`) through zero-arg wrappers bound to `homedir()`. Once `droidSkin` gates asserted behaviour, `tests/index.test.ts` becomes machine-dependent. A `setPaletteThemeProvider`-style exported setter is the repo's own precedent for breaking that coupling.

Note on line numbers: two agent passes reported slightly different offsets for the same symbols in `extensions/fusion/index.ts` (e.g. the patch trio as `:452-454` vs `:400-402`, the config read as `:531` vs `:519`). Resolve by symbol, not by line, when implementing.

## Detailed Findings

### Config boundary — `extensions/fusion/config.ts`

- `FusionConfig` (`extensions/fusion/config.ts:33-43`) and `DEFAULT_CONFIG` (`:45-50`) hold four fields, all string-typed. **There is no boolean field and no boolean guard anywhere in the repo.**
- Two validation idioms coexist: the type-guard ternary (`isFooterMode` `:52-54`, `isFocusMode` `:56-58`, used at `:79`/`:88-90`) and the nullable-normalizer (`normalizeSoundValue`, used at `:82-87`).
- **Only the type-guard idiom is falsy-safe.** With `isBoolean(raw.droidSkin) ? raw.droidSkin : DEFAULT_CONFIG.droidSkin`, a persisted `false` survives; the warn line `raw.droidSkin !== undefined && !isBoolean(raw.droidSkin)` correctly stays silent for `false`. The normalizer idiom's warn half (`!local`, `:84`, `:87`) would emit a spurious warning for a valid `false`.
- Adding a field touches **5 sites**: interface (`:33-43`), `DEFAULT_CONFIG` (`:45-50`), the guard block (`:52-58`), the value+warn pair in `loadConfigFrom` (after `:91`), and the return literal (`:92`). TypeScript catches sites 1, 2 and 5; nothing forces the warn line.
- `saveConfigTo` (`:96-119`) is value-agnostic: the `{ ...readRawFrom(path), ...patch }` merge at `:100` copies `false` by value, `JSON.stringify` at `:101` emits the literal `false`, and unknown keys survive. Caveat: a patch key whose value is `undefined` **deletes** the key (spread semantics at `:100`).
- The write path's permission logic (`:105-111`, `statSync` + `writeFileSync({mode})` + `chmodSync`) and the atomic `renameSync` (`:114`) cannot behave differently for a boolean.

### Command surface — `extensions/fusion/commands.ts` + `extensions/fusion/index.ts`

- `commands.ts` is an explicitly pure layer (docblock `extensions/fusion/commands.ts:11-16`: "a string -> value decision with no ctx, no I/O and no state"). Handlers in `index.ts` hold all IO.
- `resolveFooterMode` (`commands.ts:101-106`) documents the convention (`:97-100`): a named value is selected verbatim, **anything else including no argument advances the cycle**. Over a 2-element boolean domain, `nextMode` (`config.ts:139-141`) reduces to `!current` — so the footer convention and a natural boolean toggle coincide. The resolver must therefore carry `current`: `(args, current: boolean) => boolean`.
- Normalization idiom: `args.trim().toLowerCase()` (`commands.ts:102`, mirrored at `:110`, `:119`, `:56-58`).
- `footerModeCompletions` (`commands.ts:108-115`) returns the inline `{ value: string; label: string }[]`, with `value === label` for self-describing enum options and a `startsWith(typed)` filter. Descriptive labels are used only in `soundCompletions` (`:124-126`).
- Handler template is `/fusion` (`index.ts:261-270`): resolve → mutate runtime → persist → side-effect → `ctx.ui.notify`. `/fusion-droid` drops the `refresh()` step (nothing in the live frame changes).
- **No "restart required" notice exists anywhere in the repo** — grep for `restart|takes effect|reload` hits only the FRD. Closest wording precedents: the semicolon-remedy form `fusiontui: invalid sound; use a known id or absolute file path` (`index.ts:175-178`) and the parenthetical form `... (owned by another extension)` (`index.ts:470-473`). Six of seven notify calls use the `fusiontui: ` prefix; `/fusion` is the lone exception (`fusiontui footer mode: <value>`, `:269`).

### session_start install sequence — `extensions/fusion/index.ts`

Ordered, with skin-dependence:

| Site | Step | Gated? |
|---|---|---|
| `index.ts:436` | `if (!ctx.hasUI \|\| ctx.mode !== "tui") return;` | — |
| `:437-446` | `stopTimers`, `resetDroidSession`, `uiGeneration++`, `syncInteractive`, `refreshGit` | no |
| `:450` | `setPaletteThemeProvider(() => ctx.ui.theme)` | **no — must stay live** |
| `:452-454` | `patchAssistantIcon` / `patchUserGutter` / `patchToolFallbacks` | **yes** |
| `:460-474` | `droidToolsInstalled` latch + `getAllTools` scan + `installDroidTools` + skipped notify | **yes** |
| `:475-487` | `installFooter` + `footerToken` ownership guard | no — must stay |
| `:489` | `ctx.ui.setWorkingVisible(false)` | **yes** |
| `:491-514` | foreign-factory recapture, `fusionEditorFactory`, `FUSION_FACTORY_TAG`, `setEditorComponent` | no — editor stays (metaRow) |
| `:531-533` | `sound = loadConfig(onWarning → ctx.ui.notify)` | must be **hoisted above `:452`** |
| `:572` (`agent_start`) | `patchToolFallbacks()` re-assert | **yes** |

- **Hoisting is safe**: `loadConfig` is fully synchronous (`config.ts:120-124` → `readFileSync`), and `ctx.ui.notify` is legal anywhere after the `:436` guard (the skipped-tools notify at `:470-473` already fires before `installFooter`).
- `sound` is typed `Pick<FusionConfig, "completionSound"|"awaitingInputSound"|"soundFocusMode">` (`index.ts:110-113`) and is re-spread by `/fusion-sound` (`:180`, `:187`). The flag must live in a **separate factory-closure variable** beside `droidToolsInstalled` (`:73`), not inside `sound` — that also gives the desired restart-only semantics, since the `/fusion-sound` spreads never touch it.
- The config is already read **three times per process**: `index.ts:71` (`loadMode()`, silent), `:105`/`:113` (`loadConfig()`, silent), `:531` (`loadConfig(onWarning)`). Only the last routes warnings.
- Ordering constraint to preserve: `sound` must be assigned before `syncFocusReporting()` (`:534`), which reads `sound.soundFocusMode`.

### Tool registration one-shot

- `index.ts:460-474`: `droidToolsInstalled = true` is set **before** the work (`:461`), so a throw inside install is never retried. `pi.getAllTools()` requires an active runtime (`loader.js:271-273`), which is why the block lives in `session_start`.
- `installDroidTools` (`extensions/fusion/droid-cards.ts:260-288`) registers 7 same-name overrides (`:265-273`) and returns skipped names (`:282`). `pi.registerTool` is a Map `set` (`loader.js:195-202`); **there is no `unregisterTool`** in the extension API.
- **New finding that softens the restart-only rationale:** the extension closure is rebuilt on every session. `/new`, `/resume`, `/fork` (`agent-session-runtime.js:102-249`) and `/reload` (`agent-session.js:2056-2077`) all tear down and re-invoke the module factory (`loader.js:343-377`), producing a fresh `Extension.tools` Map (`loader.js:352`). So `droidToolsInstalled` resets per session and the previously-registered skinned tools are gone. The restart-only constraint is really "no unregister **mid-session**", not "once per process".
- Consequently the value of `droidToolsInstalled` when the flag is off is behaviourally indistinguishable — no code path re-emits `session_start` into a used closure.

### Prototype patches — `extensions/fusion/droid-patches.ts`

- Every unpatch is self-guarded: `unpatchToolFallbacks` (`:107` `if (!installedShell) return;`), `unpatchAssistantIcon` (`:199`), `unpatchUserGutter` (`:271`), each with an ownership check that refuses to overwrite a later extension's patch (`:111-116`, `:203`, `:275`). Covered by `tests/droid-patches.test.ts:76-100` and `:140-151`, including a double-unpatch case.
- **`index.ts:572` must be gated, and not merely for hygiene.** The reclaim early-return at `droid-patches.ts:42` only fires when `installedShell` is truthy; in a flag-off session it is `undefined`, so an ungated `:572` falls through to the *first-install* branch (`:58-103`) and silently installs the full tool skin at the first turn.
- **`index.ts:667-669` must stay ungated.** Patch bookkeeping lives in `droid-patches.ts` module scope (`:26-37`, `:137-142`, `:223-228`), whose lifetime is the *module*, not the closure — it survives `/new`/`/resume`/`/fork` (cached factory, `loader.js:319-325`) and is discarded on `/reload` (`resource-loader.js:216-220`). `session_shutdown` is emitted *before* the module can be replaced, so the unconditional unpatch trio is the only thing guaranteeing clean prototypes.

### Editor — `extensions/fusion/editor.ts`

- `createFusionEditor` (`:131-158`) is a shim; all presentation is in `applyFusionSkin` (`:164-341`), which mutates only `inner.render` (`:251`), `inner.setPaddingX` (`:189`) and attaches `dispose` (`:336-339`).
- Today's render, row by row: row 0 `statusLine(w)` (`:200-232`), row 1 `metaRow(w)` (`:237-249`), row 2 box top (`:310`), rows 3..n content (`:312-315`), box bottom (`:311`), then dropdown (`:325-327`). Everything is clamped by `capHeight` (`:231-235`) and `fitLine` (`:332`).
- **`metaRow` is skin-free**: `fg(uiTheme, "muted", …)` and `fg(uiTheme, effortColor(…), …)` (`:240-243`) via `theme.ts:23-29` — zero `DROID`/`hex` references. **This falsifies the FRD's constraint bullet.**
- **The box and chevron ARE droid**: `bd = hex(DROID[BORDER_KEYS[meta.agent]], …)` (`:307`) and `chevron = hex(DROID.primary, PROMPT)` (`:308`), with the docblocks at `:36-46` and `:52-55` tracing both to the droid bundle. The comment at `droid-palette.ts:113-115` notes pi's native editor "only draws a top + bottom rule (two horizontal lines), so we redraw a full rounded box".
- **A box-free skin-off render already exists as a code shape**: the `w <= 8` branch (`:257-266`) and the `base.length < 2` branch (`:270-272`) both emit `[status, metaLine, ...base]` with no box.
- **Constant-height invariant, verbatim** (`:206-210`): *"ALWAYS returns a row (blank when idle): pi-tui's differ bakes stale rows into terminal scrollback whenever a repaint grows the frame past the viewport, so the editor must keep a CONSTANT height — toggling this row on/off is what corrupted the transcript on state changes."* And `:330-331`: *"Constant two-row prelude (status + meta), blank when inactive."* And `:255-256`: *"Narrow terminals still retain the two prelude rows. Dropping them was the source of a mode-dependent height jump and stale differ rows (L3-04)."*
- Three constants hard-code a 2-row prelude: `:294` (`- 2`), `:296` (`- 4 /* prelude + top/bottom */`), `:322-324` (`- 2 /* prelude */ - 2 /* box borders */`).
- **The ticker subscription exists only on the `statusLine` path**: slot at `:175`, `releaseTicker` at `:179-182`, subscribe at `:208-213`, unsubscribe paths at `:205`, `:215` and `:337`. Source is the ref-counted 50 ms singleton in `droid-shimmer.ts:13-34`. `stopAllShimmers` (`droid-shimmer.ts:179-185`) and `resetDroidSession` (`:132-136`) never touch it. If `statusLine` is never called, `dispose()` degenerates to `baseDispose?.()`.
- **`isCurrent` has exactly one use site**: `editor.ts:204`, inside `statusLine`. Skipping `statusLine` makes the 6th positional parameter and its `index.ts:510` closure dead.
- Threading a flag in: the production call at `index.ts:505-510` is all-positional with 7 args; `tests/editor-compose.test.ts` has 5 call sites (`:70` 5-arg, `:88` 7-arg, `:112` 7-arg, `:126` 7-arg, `:141` 5-arg). Two of them already pass `() => true` purely to reach `innerFactory`. `FUSION_FACTORY_TAG` (`index.ts:341-344`, `:513`), `reclaimEditor` (`:345-355`) and `dispose` wiring are all **unaffected** — the outer factory signature is fixed by pi (`index.ts:68-70`), so closure capture at `session_start` is the only route in.

### What must stay live with the skin off

- **`setPaletteThemeProvider` (`index.ts:450`) and its teardown (`:660`) stay ungated.** Beyond the palette, `colorMode()` (`droid-palette.ts:201-213`) reads `themeProvider?.()?.getColorMode?.()` to choose truecolor/256/16/plain for every `hex()` call. Without a provider, `syncPalette` hard-resets `DROID` to `FACTORY_DARK` (`droid-palette.ts:8-24`, `:90-93`).
- **`installFooter` (`index.ts:475-487`) stays ungated.** `footer-rows.ts` imports only `fg, justify, loadColor` from `./theme` — no `DROID`. The footer also owns scroll-lock (`footer.ts:22`, `:47`) and the resync/self-heal writer (`footer.ts:56-101`) that `startHealing` drives (`index.ts:136-139`); gating it would kill `/fusion-hold`, `/fusion-follow` and mid-stream healing.
- **Skipping `setWorkingVisible(false)` is provably harmless.** The host field defaults to `true` (`interactive-mode.js:188`), `setWorkingVisible(true)` with no in-flight stream reduces to a field assignment plus a `requestRender()` (`:1421-1435`), the per-turn loader is re-checked not latched (`:2292-2297`), and the extension-teardown path sets it `true` itself (`:1523`). The unpaired shutdown restore at `index.ts:671` costs one extra render.

### Test surface

- `tests/index.test.ts` **exists** (279 lines, `be77b55` + `d971fe1`, both 2026-07-25) with a fake `ExtensionAPI` (`:19-32`), a `makeCtx` fake (`:110-144`) and an `emit` driver (`:147-156`).
- **Two exact-array assertions break on this change**: the sorted command list at `:38-44` (`fusion-droid` sorts between `fusion` and `fusion-follow`) and `calls.workingVisible` at `:167` (`[false]` → `[]`) and `:181` (`[false, true]` → `[true]`).
- **The cheapest gate observable is `tools.length`** — the fake's `registerTool` pushes into an array returned by `activateFusion()` (`:25`, `:30`) that **no test asserts on today**: 7 with the skin on, 0 with it off. The prototype patches leave no trace in this harness at all.
- **The suite is already coupled to the developer's real `~/.pi/fusiontui.json`.** `index.ts:71` (`loadMode()`), `:105` and `:519`/`:531` call zero-arg wrappers bound to `CONFIG_PATH = join(homedir(), ".pi", "fusiontui.json")` (`config.ts:29`), and the docblock at `config.ts:25-28` states `os.homedir()` ignores `$HOME`. Today that is latent (no test asserts those values) — but the suite really does spawn `afplay` via `agent_end` → `playSound` (`index.ts:601-603`, `sound.ts:151`, `:174`).
- Seams available, ranked by in-repo precedent: (1) the `*From(path)` family already exists (`config.ts:60`, `:72`, `:97`) and is exercised by `tests/config.test.ts:19-26`, but does not reach `index.ts`'s zero-arg call sites; (2) an exported setter over module state, modelled byte-for-byte on `setPaletteThemeProvider` (`droid-palette.ts:42-46`) with the `afterEach` reset idiom of `tests/droid-palette.test.ts:13-16` — **this is the chosen route**; (3) DI through `activate(pi)` — no precedent; (4) env var — ruled out in prose at `config.ts:25-28`; (5) `mock.module`/`spyOn` — zero occurrences in `tests/`.
- `tests/config.test.ts` assertions needing a boolean analogue: the save→load round-trip at `:113-117`, the raw-read unknown-key preservation at `:119-124`, and the whole-domain round-trip at `:159-164`. **The non-default value (`false`) is the only discriminating iteration** — a round-trip test on `true` alone would pass even against a load path that always defaults. Not needed: the temp-file/newline, permission and blocked-path cases (`:126-157`), all value-agnostic.
- `tests/commands.test.ts:150-174` is the resolver test template: verbatim selection over the cross-product (including a ` ${X.toUpperCase()} ` variant to pin trim + case), cycle closure, and `unknown ≡ empty` expressed as an equality between two resolver calls (`:171-172`).

## Code References
- `extensions/fusion/config.ts:33-43` — `FusionConfig` interface; the new field's site 1
- `extensions/fusion/config.ts:45-50` — `DEFAULT_CONFIG`; typed as full `FusionConfig`, so it is a compile-time forcing point
- `extensions/fusion/config.ts:52-58` — `isFooterMode` / `isFocusMode`; the `(value: unknown) => value is T` guard idiom `isBoolean` must match
- `extensions/fusion/config.ts:71-93` — `loadConfigFrom`; the per-field value+warn triples and the `warnInvalid` closure at `:75-77`
- `extensions/fusion/config.ts:96-119` — `saveConfigTo`; merge, mode-preserving temp write, atomic rename
- `extensions/fusion/config.ts:120-141` — the four `CONFIG_PATH`-bound wrappers (`loadConfig`, `saveConfig`, `loadMode`, `saveMode`) and `nextMode`
- `extensions/fusion/commands.ts:11-16` — the "pure layer" docblock that dictates where the resolver goes
- `extensions/fusion/commands.ts:97-106` — `resolveFooterMode` + the "unknown or empty advances the cycle" convention
- `extensions/fusion/commands.ts:108-115` — `footerModeCompletions`; the completions shape to mirror
- `extensions/fusion/index.ts:68-73` — `fusionEditorFactory` type (fixed by pi) and the `droidToolsInstalled` closure latch
- `extensions/fusion/index.ts:110-113` — the `sound` Pick; the flag must NOT live here
- `extensions/fusion/index.ts:261-270` — the `/fusion` registration; template for `/fusion-droid`
- `extensions/fusion/index.ts:435-546` — the whole `session_start` handler
- `extensions/fusion/index.ts:450` — `setPaletteThemeProvider`; ungated
- `extensions/fusion/index.ts:452-454` — the patch trio; gated
- `extensions/fusion/index.ts:460-474` — the tool one-shot; gated
- `extensions/fusion/index.ts:475-487` — `installFooter` + `footerToken`; ungated
- `extensions/fusion/index.ts:489` — `setWorkingVisible(false)`; gated
- `extensions/fusion/index.ts:497-514` — the editor factory closure, `FUSION_FACTORY_TAG`, `setEditorComponent`
- `extensions/fusion/index.ts:531-533` — the only warning-routed `loadConfig`; must hoist above `:452`
- `extensions/fusion/index.ts:572` — the `agent_start` `patchToolFallbacks` re-assert; gated (falls through to first-install otherwise)
- `extensions/fusion/index.ts:660-671` — shutdown: palette provider clear, unpatch trio, `setWorkingVisible(true)`; ungated
- `extensions/fusion/editor.ts:131-158` — `createFusionEditor`; the 7 positional parameters
- `extensions/fusion/editor.ts:164-170` — `applyFusionSkin` signature (5 of the 7 values)
- `extensions/fusion/editor.ts:200-232` — `statusLine`; DROID colors, ticker subscribe/release, the `:206-210` invariant docblock
- `extensions/fusion/editor.ts:237-249` — `metaRow`; pi-theme only, no DROID
- `extensions/fusion/editor.ts:251-333` — `inner.render`; three return points (`:259-266`, `:271`, `:332`)
- `extensions/fusion/editor.ts:294`, `:296`, `:322-324` — the three hard-coded 2-row-prelude constants
- `extensions/fusion/editor.ts:307-316` — the box + chevron; the actual droid chrome
- `extensions/fusion/editor.ts:336-339` — `dispose`; releases the ticker + `baseDispose`
- `extensions/fusion/droid-patches.ts:40-104` — `patchToolFallbacks`; reclaim branch at `:42-57` vs first-install at `:58-103`
- `extensions/fusion/droid-patches.ts:106-134` — `unpatchToolFallbacks`; `!installedShell` no-op + ownership checks
- `extensions/fusion/droid-patches.ts:198-207`, `:270-279` — the other two self-guarded unpatches
- `extensions/fusion/droid-cards.ts:260-288` — `installDroidTools`; 7 same-name overrides, returns skipped
- `extensions/fusion/droid-palette.ts:42-46` — `setPaletteThemeProvider`; the exported-setter seam template
- `extensions/fusion/droid-palette.ts:201-213` — `colorMode()`; the second, non-obvious dependency on the theme provider
- `extensions/fusion/footer.ts:20-116` — `installFooter`, ownership token, resync/self-heal
- `extensions/fusion/droid-shimmer.ts:13-34` — the ref-counted 50 ms ticker singleton
- `tests/index.test.ts:19-32` — the fake `ExtensionAPI`; `tools` array is the unasserted gate observable
- `tests/index.test.ts:38-44` — the exact sorted command list; breaks on `/fusion-droid`
- `tests/index.test.ts:159-184` — `session_start` / shutdown assertions incl. `workingVisible`
- `tests/config.test.ts:19-26` — the tmpdir isolation idiom
- `tests/config.test.ts:112-165` — the `saveConfigTo` assertion set
- `tests/commands.test.ts:150-174` — the resolver test template
- `tests/droid-palette.test.ts:13-16` — the setter + `afterEach` reset idiom
- `tests/droid-patches.test.ts:76-100` — patch idempotency + unpatch-when-unpatched
- `tests/editor-compose.test.ts:70`, `:88`, `:112`, `:126`, `:141` — the five positional `createFusionEditor` call sites

## Integration Points

### Inbound References
- `extensions/fusion/index.ts:71` — `createState(process.cwd(), loadMode())`, a silent config read at factory time
- `extensions/fusion/index.ts:105`/`:113` — `loadConfig()` for `sound`, silent, factory time
- `extensions/fusion/index.ts:531` — `loadConfig(onWarning → ctx.ui.notify)`, the only warning-routed read
- `extensions/fusion/index.ts:452-454`, `:460-474`, `:489`, `:572` — the four gate sites
- `extensions/fusion/index.ts:505-510` — the only production `createFusionEditor` call
- `tests/index.test.ts:28` — `activate(pi)`, which transitively performs the real-`$HOME` config reads

### Outbound Dependencies
- `extensions/fusion/config.ts:29` — `CONFIG_PATH` bound at module-evaluation time from `homedir()`
- `extensions/fusion/droid.ts:47-66` — the barrel re-exporting `installDroidTools`, the `patch*`/`unpatch*` trio, `setPaletteThemeProvider`, `subscribeTicker`
- `extensions/fusion/theme.ts:23-29` — `fg(theme, token, text)`, the pi-theme accessor `metaRow` uses
- `node_modules/@earendil-works/pi-coding-agent/.../interactive-mode.js:188`, `:1421-1435`, `:2292-2297`, `:1523` — `workingVisible` semantics
- `node_modules/@earendil-works/pi-coding-agent/.../loader.js:195-202`, `:313-377` — `registerTool` (no inverse) and the per-session extension rebuild
- `node_modules/@earendil-works/pi-coding-agent/.../agent-session-runtime.js:102-249`, `agent-session.js:2056-2077` — `/new`, `/resume`, `/fork`, `/reload` session transitions

### Infrastructure Wiring
- `extensions/fusion/index.ts:513-517` — `FUSION_FACTORY_TAG` write + the deferred 1 s `reclaimEditor`
- `extensions/fusion/index.ts:573`, `:612`, `:645` — the other `reclaimEditor` re-asserts (skin-independent slot defense)
- `extensions/fusion/index.ts:475-477` — `footerToken` symbol minted per session; stale-footer dispose guard
- `extensions/fusion/index.ts:536`/`:654` — `onTerminalInput` subscribe/unsubscribe
- `commitlint.config.js` — conventional commits with lower-case scopes; precedent is `feat(config):` / `feat(droid):`

## Architecture Insights

- **Pure-layer split is enforced by history, not just style.** Command parsing inlined in `index.ts` was extracted twice (`1b8748b`, `d971fe1`). The resolver belongs in `commands.ts` from the first commit.
- **Module scope vs closure scope is the load-bearing distinction in this codebase.** The extension closure (`droidToolsInstalled`, `sound`, `state`) is rebuilt per session; `droid-patches.ts` bookkeeping and the `droid-shimmer.ts` ticker are module-scoped and survive `/new`/`/resume`/`/fork`. That asymmetry is why install can be gated but teardown cannot.
- **Constant editor height is a hard invariant, not a preference** — encoded in three separate comments (`editor.ts:206-210`, `:255-256`, `:330-331`) and one accepted High-severity arch finding (L3-04).
- **Falsy-safety is a new concern.** Every existing field is a non-empty string, so the two validation idioms in `config.ts` are interchangeable today. They diverge for the first boolean.
- **The repo has no deferred-effect UX vocabulary.** Every setting takes effect immediately today; `/fusion-droid` will be the first that does not.

## Precedents & Lessons
6 similar past changes analyzed.

### Precedent: first end-to-end persisted config fields (`completionSound`, `soundFocusMode`)
**Commit(s)**: `a38a39b` — "feat: add completion sound notifications" (2026-07-02)
**Blast radius**: 6 files across 4 layers
  extensions/fusion/ — `config.ts` (+62), `index.ts` (+166), new `sound.ts` (211)
  docs — `README.md` (+36), shipped in the same commit

**Follow-up fixes**:
- `4ab3e97` — "fix: harden rendering boundaries and extension lifecycle" (2026-07-14) — the original validator was a bare `typeof === "string" && length > 0` cast; any garbage string crossed the boundary. Added `normalizeSoundValue` + the `onWarning`/`warnInvalid` path, and made `saveConfig` atomic (L1-02).
- `dbd7df0` — "test(config): parameterize the config path and cover persistence" (2026-07-25) — two more defects found only once tests existed: the failure path unlinked the wrong temp file, and a top-level JSON array was accepted as a config object.

**Takeaway**: ship the guard, the `warnInvalid` call and the negative test in the same commit — every prior field needed a second pass for exactly that.

### Precedent: adding a field to an existing config shape (`awaitingInputSound`)
**Commit(s)**: `791d912` — "feat: replicate Droid transcript skin and awaiting-input notifications" (2026-07-13)
**Blast radius**: `config.ts` +12 lines, bundled in a 1597-line, 9-file skin commit

**Takeaway**: the field checklist is 5 sites in `config.ts`; the return literal is the one TypeScript only catches through the declared return type.

### Precedent: the `/fusion` command shape
**Commit(s)**: `35f460b` — "feat(config): add full/minimal/adaptive footer modes via /fusion" (2026-06-24)
**Blast radius**: 5 files — new `config.ts`, `index.ts` (+22), `state.ts` (+5), `README.md` (+12)

**Follow-up fixes**:
- `1b8748b` — "test(commands): extract the slash-command surface out of index.ts" (2026-07-25) — parsing lived inline in `index.ts` for a month and was untestable.
- `d971fe1` — "test(footer,index): cover the install seam and the extension wiring" (2026-07-25) — moved 18 more lines out of `index.ts`.

**Takeaway**: pure resolver + completions in `commands.ts`; `index.ts` keeps only ctx/IO.

### Precedent: the session_start install block
**Commit(s)**: `791d912` (2026-07-13) installed it; `4ab3e97` (2026-07-14) rewrote its lifecycle (+296 lines in `index.ts`, 16 files, 1302 insertions); `949323a` (2026-07-25) rewrote the editor half

**Follow-up fixes** (all within 24h of the skin landing):
- `4ab3e97` — generation/liveness guards, `uiActive`, abort controllers; leaked timers and stale closures across sessions
- `7a9498f` — "fix: skin edit tool cards consistently"
- `00bda59` — "fix: preserve transcript reading position during streaming"
- `0a3ca8a` — "fix(footer): stop UI freeze from scroll-lock raw mouse tracking"
- `329e268` (2026-07-25) — "fix(droid): keep OSC 133 markers intact and correctly ordered"

**Takeaway**: install/teardown asymmetry is what produced the 2026-07-14 fix cluster. One flag, read once, stored in a session-scoped variable, never re-read — and only on the install half (teardown is self-guarding; see Detailed Findings).

### Precedent: the editor prelude
**Commit(s)**: `3780ab8` (2026-06-24), `4ab3e97` (2026-07-14), `949323a` (2026-07-25)

**Follow-up fixes**:
- `3780ab8` — "fix(editor): recognize scroll-indicator borders so long pastes do not blank the box" — `isRule` mis-detected borders and sliced out the typed text
- `4ab3e97` — replaced the `width <= 8 → super.render()` fallback because dropping the prelude rows caused a mode-dependent height jump and stale differ rows

**Lessons from docs**:
- `.rpiv/artifacts/architecture-reviews/pi-fusiontui_rendering-and-tui.md` §L3-04 (High, accepted) — the narrow-fallback height variation; resolution: preserve constant height
- same doc §L3-05 — the fixed prelude reduces effective cursor viewport; the budget math hard-codes 2 prelude rows
- same doc §L1-01 / §L1-02 — the config validation and atomicity findings closed by `4ab3e97` / `dbd7df0`

**Takeaway**: keep 2 prelude rows and blank the status row; never drop it.

### Precedent: the source FRD
**Doc**: `.rpiv/artifacts/discover/2026-07-26_23-14-24_droid-skin-toggle.md` (authored at `2d62b78`)

**Takeaway**: use it for the decisions, not for facts about the codebase — two of its constraint bullets are falsified above, and several line numbers have drifted (`statusLine` is `:200-232`, not `:213-232`; `metaRow` is `:237-249`, not `:236-248`). Re-locate by symbol.

### Composite Lessons
- Every config field so far shipped with a broken validator and needed a follow-up fix (`4ab3e97`, `dbd7df0`) — ship guard + warn + negative test together.
- Command parsing inlined in `index.ts` always gets extracted later (`1b8748b`, `d971fe1`).
- Changing the editor's prelude row count is the repo's most expensive mistake (`3780ab8`, `4ab3e97`, arch-review L3-04 High).
- Install/teardown asymmetry in `session_start` caused a five-fix cluster in 24 hours (`4ab3e97` and siblings).
- `feat:` commits that add a user-visible setting have always updated `README.md` in the same commit (`a38a39b`, `791d912`, `35f460b`).
- Reading real-`$HOME` config inside `index.ts` makes the index suite environment-dependent — the `loadConfigFrom(path)` seam exists but `index.ts` does not use it.

## Historical Context (from `.rpiv/artifacts/`)
- `.rpiv/artifacts/discover/2026-07-26_23-14-24_droid-skin-toggle.md` — the source FRD for this change (10 requirements, 7 decisions)
- `.rpiv/artifacts/architecture-reviews/pi-fusiontui_rendering-and-tui.md` — rendering/TUI architecture review; §L1-01, §L1-02, §L3-04, §L3-05 are directly load-bearing here

## Developer Context

**Q (discover: Single flag, not granular per-piece flags): Liga/desliga simples (uma flag mata todo o skin) ou granular (flags separadas pra cards, ícone, editor)?**
A: Liga/desliga simples — one `droidSkin` boolean.

**Q (discover: Read at session_start, restart to apply): Tool cards are registered once with no unregister API, so `droidSkin` can only be honoured at `session_start`. Keep that?**
A: Yes — read at start, changing it requires a restart.

**Q (discover: Native pi spinner returns when the skin is off): With the skin off the native pi spinner comes back. Confirm?**
A: Yes.

**Q (discover: Keep the editor wrapper in metaRow-only mode): The model/effort row lives inside the skinned editor. How to resolve?**
A: Keep the editor wrapper, emit only metaRow.

**Q (discover: New `/fusion-droid on|off` command): New command, or hand-edit the JSON?**
A: New `/fusion-droid on|off` command.

**Q (discover: Sounds and other features stay on): What stays on with `droidSkin: false`?**
A: Footer + metaRow + sounds + git/usage stay.

**Q (discover: Test scope): Config + command, or also an `index.ts` gate test?**
A: Config + command. *(Superseded below — the premise was false.)*

**Q (`extensions/fusion/editor.ts:307-308` vs `:237-249`): `metaRow` uses only the pi theme; the rounded box and the `>` chevron are the actual droid chrome. With `droidSkin: false`, do the box and chevron stay or go?**
A: They go — pi's native editor rendering, metaRow kept. The DROID palette provider still stays live for `colorMode()` (`droid-palette.ts:201-213`).

**Q (`tests/index.test.ts:38-44`, `:167`, `:181`): `tests/index.test.ts` exists (contra the FRD) and two exact-array assertions break. Does the test scope change?**
A: Yes — fix both assertions and cover the gate in `tests/index.test.ts`. This supersedes the FRD's "config + command only" decision and its "no index harness" non-goal.

**Q (`extensions/fusion/index.ts:71`, `:105`, `:531` + `extensions/fusion/config.ts:29`): `index.ts` reads the developer's real `~/.pi/fusiontui.json` and `os.homedir()` ignores `$HOME`, so the index suite becomes machine-dependent once the gate is asserted. Which seam?**
A: Add an exported setter over module state, modelled on `setPaletteThemeProvider` (`droid-palette.ts:42-46`) with the `afterEach` reset idiom of `tests/droid-palette.test.ts:13-16`.

**Q (`extensions/fusion/commands.ts:97-106`): What does a bare `/fusion-droid` do?**
A: Toggle — `on`→true, `off`→false, empty or unknown→`!current`, matching `resolveFooterMode` verbatim.

## Related Research
None — this is the first research artifact in this repository.

## Open Questions
None deferred. The FRD carried no open questions forward, and every checkpoint in this pass was decided.

Two FRD statements are superseded rather than open:
- FRD Non-Goal "Building a test harness for `index.ts` (681 lines, currently untested)" — the harness exists; the gate is now in test scope.
- FRD Constraint "`metaRow` colours come from `DROID.*`" — false; the palette must stay live for the `colorMode()` probe, not for `metaRow`.
