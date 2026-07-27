---
template_version: 1
date: 2026-07-27T00:22:55-0300
author: Gabriel Aguiar
commit: 2d62b78
branch: main
repository: pi-fusiontui
topic: "Validation of droidSkin toggle — disable the droid skin, keep footer + model/effort row"
status: ready
verdict: pass
parent: ".rpiv/artifacts/plans/2026-07-27_00-06-05_droid-skin-toggle.md"
tags: [validation, config, commands, session-lifecycle, editor, droid-skin]
last_updated: 2026-07-27T00:22:55-0300
---

## Validation Report: droidSkin toggle

### Implementation Status

- ✓ Phase 1: Config field + path seam — Fully implemented
- ✓ Phase 2: Command resolver + completions — Fully implemented
- ✓ Phase 3: Editor skin-off render — Fully implemented
- ✓ Phase 4: session_start gate + `/fusion-droid` — Fully implemented

All work is in the working tree (uncommitted); the eight modified files are exactly the eight the plan names. The only other dirt is untracked `.rpiv/artifacts/` workflow output. No `--baseline` was supplied, so the whole tree was judged.

### Automated Verification Results

- ✓ Full gate: `bun run check` — lint (oxlint `--deny-warnings`) + typecheck (`tsc --noEmit`) + suite green; 241 pass / 0 fail, 1865 assertions, 16 files, 2.48s
- ✓ Config tests: `bun test tests/config.test.ts` — all pass, including `droidSkin: false` survival, the `"off"` warn case, both round-trips, unknown-key preservation and `setConfigPath`
- ✓ Command tests: `bun test tests/commands.test.ts` — `resolveDroidSkin` named/bare/unknown and `droidSkinCompletions` filtering all pass
- ✓ Editor tests: `bun test tests/editor-compose.test.ts` — four new skin-off tests pass; the pre-existing skinned tests pass unchanged
- ✓ Index tests: `bun test tests/index.test.ts` — repaired command-list assertion plus the five `describe("droidSkin")` cases pass
- ✓ `grep -c "droidSkin" extensions/fusion/config.ts` → 5 (expected 5)
- ✓ `grep -c "activePath" extensions/fusion/config.ts` → 5 (plan pre-ruled 5: 4 + the CONFIG_PATH docblock it specifies)
- ✓ `grep -c "ctx\." extensions/fusion/commands.ts` → 0 (pure-layer contract holds)
- ✓ `grep -c "prelude" extensions/fusion/editor.ts` → 5, `grep -c "Math.floor(terminalRows \* 0.3) - 2"` → 1 (skinned box path untouched)
- ✓ `grep -c "loadConfig(" extensions/fusion/index.ts` → 3 (expected 3)
- ✓ `grep -c "if (droidSkin" extensions/fusion/index.ts` → 4 (expected 4)
- ✓ `grep -c "foreignEditorFactory, droidSkin)" extensions/fusion/index.ts` → 1 (expected 1)
- ✓ `cat ~/.pi/fusiontui.json` after the full run — still `{"mode": "minimal"}`, no `droidSkin` key written; the seam kept every test inside its temp dir
- ✓ No regressions detected

### Code Review Findings

#### Matches Plan:

- `extensions/fusion/config.ts:24-40` — `CONFIG_PATH` docblock rewritten and the `activePath` module state + exported `setConfigPath(path?)` seam added, mirroring `droid-palette.ts:42-46`
- `extensions/fusion/config.ts:55-60, :68, :79-81, :115-117` — interface field, `DEFAULT_CONFIG.droidSkin: true`, `isBoolean` guard, ternary + `warnInvalid` pair and the extended return literal, all in the exact shape of the sibling fields
- `extensions/fusion/config.ts:148, :153` — both thin wrappers now bind `activePath`
- `extensions/fusion/commands.ts:117-140` — `DROID_SKIN_ARGS`, `resolveDroidSkin`, `droidSkinCompletions` placed between `footerModeCompletions` and `soundCompletions` as specified; no `ctx.` reference
- `extensions/fusion/editor.ts:139, :158` — 8th positional `droidSkin = true` forwarded into `applyFusionSkin`; `:175` receives it
- `extensions/fusion/editor.ts:193-198` — padding lock wrapped in `if (droidSkin)`
- `extensions/fusion/editor.ts:262-269` — skin-off early branch returns `capHeight([metaRow(w), ...baseRender(w).map(...)])`; `statusLine` is unreachable, so no ticker is ever subscribed (verified `editor.ts:224` is the sole subscription site)
- `extensions/fusion/index.ts:77-80` — session flag initialised from `DEFAULT_CONFIG.droidSkin`, kept out of the `sound` object
- `extensions/fusion/index.ts:280-302` — `/fusion-droid` registered with completions, disk-sourced `current`, the `ctx.ui.notify` warning route, and the `(restart pi to apply)` notify string the plan review mandated
- `extensions/fusion/index.ts:479-486` — the single warning-routed `loadConfig` hoisted above the skin install; the old late `sound = loadConfig(...)` at the former `:529-531` is gone
- `extensions/fusion/index.ts:493-497, :503, :533, :613` — the four gate sites, exactly as enumerated
- `extensions/fusion/index.ts:554` — flag forwarded as the editor factory's 8th argument
- `extensions/fusion/index.ts` `session_shutdown` — untouched by the diff, as the plan requires; every unpatch self-guards (`droid-patches.ts:107, :210, :290`), so an ungated teardown after a skin-off session is a no-op
- Test files match the specified test bodies verbatim, including the `setConfigPath()` resets in both `afterEach` hooks

#### Deviations from Plan:

None. The implementation is a faithful realization of the plan, including every Step-5 plan-review resolution.

#### Pattern Conformance:

- ✓ Config field handling, notify format/severity, completion wiring, test-file structure and the module-state setter seam all follow established codebase conventions
- Minor observation: `resolveDroidSkin` (`commands.ts:126-131`) hardcodes the `"on"` / `"off"` literals instead of resolving through `DROID_SKIN_ARGS`, whereas `resolveFooterMode` (`commands.ts:100-105`) resolves by membership in `FOOTER_MODES` — acceptable variation, not a deviation; the plan specified this body verbatim and a two-value domain makes drift cheap to catch
- Minor observation: `createFusionEditor`'s JSDoc (`editor.ts:114-130`) was not extended for the new 8th parameter, though `applyFusionSkin`'s was (`editor.ts:163-168`) — acceptable variation, not a deviation
- Minor observation: the `/fusion-droid` handler re-reads config from disk where `/fusion` and `/fusion-sound` read session state — acceptable variation, not a deviation; it is the plan's ratified deviation and is commented in place (`index.ts:285-288`)

### Manual Testing Required:

1. Notify wording:
   - [ ] `/fusion-droid off` notifies `restart pi to apply` (not `next session`)
2. Skin off, after restarting pi:
   - [ ] Tool calls render as Pi's native cards
   - [ ] Assistant messages have no `⛬` gutter and no user gutter
   - [ ] The composer is Pi's native editor with the model/effort row floating above it (meta / top rule / text / bottom rule, no chevron)
   - [ ] The fusiontui footer still renders
   - [ ] Pi's own spinner appears while the agent works
3. Skin on, after restarting pi:
   - [ ] The transcript is visually indistinguishable from today's skin
4. Invalid persisted value:
   - [ ] `{"droidSkin": "off"}` in `~/.pi/fusiontui.json` produces exactly one `invalid droidSkin config; using default` warning at session start, with the skin on

### Recommendations:

- Ready to commit — implementation is complete and validated.
- Optional follow-up, not blocking: derive `resolveDroidSkin`'s branches from `DROID_SKIN_ARGS` and extend the `createFusionEditor` JSDoc with the 8th parameter.
- The `.rpiv/artifacts/` directories are untracked; decide whether they belong in the same commit or stay local.
