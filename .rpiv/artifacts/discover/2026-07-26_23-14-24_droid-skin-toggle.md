---
date: 2026-07-26T23:14:24-0300
author: Gabriel Aguiar
commit: 2d62b78
branch: main
repository: pi-fusiontui
topic: "droidSkin toggle — disable the droid transcript skin, keep footer + model/effort row"
tags: [intent, frd, config, droid-skin, editor, commands]
status: ready
last_updated: 2026-07-26T23:14:24-0300
last_updated_by: Gabriel Aguiar
---

# FRD: droidSkin toggle — disable the droid transcript skin, keep footer + model/effort row

## Summary
Add a persisted boolean `droidSkin` (default `true`) to `~/.pi/fusiontui.json`, flipped by a new `/fusion-droid on|off` command, read once at `session_start`. When `false`, fusiontui skips the droid transcript skin — tool cards, the assistant-icon/user-gutter monkey patches, and the editor's droid status line/shimmer — while keeping the fusiontui footer and the top model/effort row.

## Problem & Intent
The developer's framing: *"Quero o pi puro, só com o footer do fusiontui."* The droid skin is an all-or-nothing visual takeover today — tool cards, the `⛬` assistant icon, the user gutter and the skinned editor are installed unconditionally at `session_start` (`extensions/fusion/index.ts:452-468`). There is no way to fall back to pi's native transcript rendering while still keeping the parts of fusiontui the developer actually wants: the footer and the model/effort line.

## Goals
- One boolean setting turns off the entire droid *visual* skin in one shot.
- pi's native transcript rendering (tool output, assistant messages, user messages) comes back untouched.
- The fusiontui footer keeps working exactly as today.
- The top model/effort row (`metaRow`) survives with the skin off.
- The setting is discoverable from inside the TUI, not only by hand-editing JSON.

## Non-Goals
- Granular per-piece flags (separate toggles for cards / icon / editor) — explicitly rejected in favour of one flag.
- Live mid-session toggling without a restart.
- Turning off sounds, scroll-lock, git or usage rows — those are separate features with their own controls (`/fusion-sound`).
- Building a test harness for `index.ts` (681 lines, currently untested).

## Functional Requirements
1. The system SHALL persist a boolean field `droidSkin` in `~/.pi/fusiontui.json`, defaulting to `true` when absent.
2. The system SHALL warn (via the existing `onWarning` path, `config.ts:77-79`) when `droidSkin` is present but not a boolean, and fall back to the default.
3. The system SHALL read `droidSkin` once during `session_start` (`index.ts:436-468`); later file edits SHALL NOT take effect until the next session.
4. When `droidSkin` is `false`, the system SHALL NOT call `installDroidTools` (`index.ts:468`), so pi's built-in tool cards render.
5. When `droidSkin` is `false`, the system SHALL NOT call `patchAssistantIcon`, `patchUserGutter` or `patchToolFallbacks` (`index.ts:452-454`, `index.ts:572`), so the `⛬` icon and user gutter stay native.
6. When `droidSkin` is `false`, the fusion editor SHALL still be installed but SHALL emit only `metaRow` (`editor.ts:236-248`) — no `statusLine` (`editor.ts:213-232`) and no shimmer.
7. When `droidSkin` is `false`, the system SHALL NOT call `ctx.ui.setWorkingVisible(false)` (`index.ts:481`), so pi's native working spinner is shown.
8. The system SHALL register a `/fusion-droid on|off` command that persists the value via `saveConfig({ droidSkin })` and notifies the user that a restart is required.
9. `/fusion-droid` SHALL offer argument completions for `on` / `off`, mirroring `getArgumentCompletions` in `index.ts:261-272`.
10. When `droidSkin` is `false`, footer, sounds, scroll-lock, git and usage behaviour SHALL be unchanged.

## Non-Functional Requirements
- **Performance**: no specific constraint; the off path strictly does less work than today (fewer prototype patches, no shimmer ticker).
- **Security**: none beyond the existing config write path — atomic temp-file write + `chmod` + `rename` (`config.ts:99-124`) must be reused as-is, including unknown-key preservation (`config.ts:103`).
- **UX / Accessibility**: the notify message must state plainly that the change applies on the next session. With the skin off the terminal shows pi's native rendering plus fusiontui's footer and metaRow — no half-skinned state.
- **Reliability**: an invalid or corrupt `droidSkin` value must never break startup; it degrades to the default (`true`) with a warning, per the existing `loadConfigFrom` contract.

## Constraints & Assumptions
- **No unregister API for tools.** `installDroidTools` registers same-name overrides once per process (`index.ts:460-461`, `droid-cards.ts:260-283`) and nothing ever unregisters them. This is what forces the read-at-start / restart-to-change model.
- **The model/effort row is inside the editor skin.** `metaRow` is emitted from the skinned editor's render (`editor.ts:252-253`, `editor.ts:340-343`) and reads `state.modelLabel` / `state.effortLabel` (`index.ts:276-279`, wired at `index.ts:505-509`). Keeping it means keeping the editor wrapper installed.
- **The footer is skin-independent.** `renderFooterRows` uses pi's theme, not the DROID palette (`footer.ts:110`, no `DROID` references in `footer-rows.ts`), so it needs no changes.
- **The palette must still sync.** `metaRow` colours come from `DROID.*`, so `setPaletteThemeProvider` / `syncPalette` (`index.ts:450`, `droid-palette.ts:43-46`) must stay live even with the skin off.
- **No boolean field exists in the config yet.** All current fields are enums or sound strings (`config.ts:33-43`), so a boolean validator is new.
- Assumption: the foreign-editor capture path (`index.ts:487-510`, `editor.ts:141-160`) is unaffected — it only captures, never destroys, another extension's factory.

## Acceptance Criteria
- [ ] `bun test tests/config.test.ts` exits 0 with new cases: `droidSkin` defaults to `true` when absent; a non-boolean value warns via `onWarning` and falls back to `true`; `true`/`false` round-trip through `saveConfigTo` → `loadConfigFrom`.
- [ ] `bun test tests/commands.test.ts` exits 0 with new cases covering the `/fusion-droid` argument parse: `on` → `true`, `off` → `false`, invalid/empty input handled per the existing `resolveFooterMode` pattern (`commands.ts:107-112`).
- [ ] `bun test` (whole suite) exits 0.
- [ ] Running `/fusion-droid off` in the TUI prints a notify containing the new value and a restart hint, and `cat ~/.pi/fusiontui.json` shows `"droidSkin": false` with all pre-existing keys preserved.
- [ ] After restarting pi with `"droidSkin": false`: tool calls render as pi's native cards (no 3-space indented `↳` droid rows), assistant messages have no `⛬` gutter icon, the fusiontui footer still renders, the top model/effort row still renders, and pi's native working spinner appears while the agent runs.
- [ ] After restarting with `"droidSkin": true` (or the key removed), behaviour is byte-identical to today's skin.

## Recommended Approach
Add `droidSkin: boolean` to `FusionConfig` / `DEFAULT_CONFIG` with an `isBoolean` guard in `extensions/fusion/config.ts`, register `/fusion-droid` in `extensions/fusion/index.ts` alongside `/fusion` using `saveConfig` + `ctx.ui.notify`, and gate the `session_start` install block (`index.ts:452-481`) on the loaded flag — skipping `installDroidTools`, the three `patch*` calls (including the `agent_start` re-assert at `index.ts:572`) and `setWorkingVisible(false)`, while still installing the fusion editor in a metaRow-only mode driven by a flag threaded into `createFusionEditor` (`editor.ts:141-160`, `applyFusionSkin` at `editor.ts:166-250`).

## Decisions

### Single flag, not granular per-piece flags
**Question**: Liga/desliga simples (uma flag mata todo o skin) ou granular (flags separadas pra cards, ícone, editor)?
**Recommended**: Liga/desliga simples.
**Chosen**: Liga/desliga simples — one `droidSkin` boolean.
**Rationale**: Fewer states to reason about and test; the developer's intent is a single "pi puro" mode, not a mix-and-match.

### Read at session_start, restart to apply
**Question**: Pre-resolved from codebase evidence — confirmed in Step 4. Tool cards are registered once per process with no unregister API, so `droidSkin` can only be honoured at `session_start`. Keep that?
**Recommended**: Yes — read at start, changing it requires a restart.
**Chosen**: Yes.
**Rationale**: evidence: `extensions/fusion/index.ts:460-468` + `extensions/fusion/droid-cards.ts:260-283` (no unregister counterpart) + confirmed.

### Native pi spinner returns when the skin is off
**Question**: Pre-resolved from codebase evidence — confirmed in Step 4. The skin hides pi's loader via `setWorkingVisible(false)` because it draws its own status line; with the skin off the native spinner comes back. Confirm?
**Recommended**: Yes — let the native spinner return.
**Chosen**: Yes.
**Rationale**: evidence: `extensions/fusion/index.ts:481` (suppression) + `extensions/fusion/editor.ts:213-232` (the status line it replaces) + confirmed; without it there would be no working indicator at all.

### Keep the editor wrapper in metaRow-only mode
**Question**: The model/effort row lives inside the skinned editor (`editor.ts:236-248`) and is only drawn by it (`editor.ts:252-253`, `editor.ts:340-343`). Disabling `editor.ts` kills that line. How to resolve — keep the wrapper with metaRow only, move model/effort into the footer, or drop the line?
**Recommended**: Keep the editor wrapper, emit only metaRow.
**Chosen**: Keep the editor wrapper, emit only metaRow.
**Rationale**: `applyFusionSkin` patches only the instance, not prototypes (`editor.ts:166-250`), so a metaRow-only mode is a small, contained change; moving the row into the footer would mean new footer layout work.

### New `/fusion-droid on|off` command
**Question**: Como virar a flag — novo comando `/fusion-droid on|off`, ou só editar o JSON à mão?
**Recommended**: New `/fusion-droid on|off` command.
**Chosen**: New `/fusion-droid on|off` command.
**Rationale**: Matches the established `fusion-<topic>` command family (`index.ts:169`, `:239`, `:247`, `:254`) and keeps the setting discoverable in-TUI.

### Sounds and other features stay on
**Question**: Com `droidSkin: false`, o que continua ligado?
**Recommended**: Footer + metaRow + sounds + git/usage stay; only the droid visuals go.
**Chosen**: Footer + metaRow + sounds + git/usage stay.
**Rationale**: Sound already has its own control (`/fusion-sound off`); bundling it into `droidSkin` would conflate two unrelated concerns.

### Test scope: config + command parsing only
**Question**: Qual nível de teste como critério de aceite — config + comando, ou também um teste do gate no `index.ts`?
**Recommended**: Config + command.
**Chosen**: Config + command.
**Rationale**: Mirrors the existing `tests/config.test.ts` tmpdir pattern (`config.test.ts:18-25`); `index.ts` has no test harness today and building one is out of scope.

## Open Questions
None — every branch was decided during the interview.

## Suggested Follow-ups
- `installDroidTools` has no unregister counterpart, which is the sole reason this setting cannot be toggled live — `extensions/fusion/index.ts:460-468`, `extensions/fusion/droid-cards.ts:260-283`.
- `extensions/fusion/index.ts` is 681 lines with no test coverage; the `session_start` install block would benefit from a harness — `extensions/fusion/index.ts:436-520`.
- The `reclaimEditor` re-assert timers (`index.ts:515-518`, `:573`, `:612`, `:645`) exist to fight other extensions for the editor slot; worth revisiting whether they are still needed under a metaRow-only mode.

## References
- Input: free-text request — `adicionar setting droidSkin (bool, default true) em ~/.pi/fusiontui.json`
- `extensions/fusion/index.ts`, `extensions/fusion/config.ts`, `extensions/fusion/commands.ts`, `extensions/fusion/editor.ts`, `extensions/fusion/droid-cards.ts`, `extensions/fusion/droid-patches.ts`, `extensions/fusion/footer.ts`, `extensions/fusion/state.ts`
- `tests/config.test.ts`, `tests/commands.test.ts`
