# pi-fusiontui

A custom Pi TUI extension that fuses the **Droid** editor aesthetic with the
**Grok / zentui** statusline, plus live subscription usage.

It shows everything in one place:

| Requested        | Where it shows        | Source                                            |
| ---------------- | --------------------- | ------------------------------------------------- |
| folder           | footer line 1 (left)  | `ctx.cwd`                                          |
| branch + status  | footer line 1 (left)  | `git status --porcelain=2 --branch`               |
| context window   | footer line 1 (right) | `ctx.getContextUsage()` + `ctx.model.contextWindow` |
| price            | footer line 1 (right) | sum of `assistant.usage.cost.total`               |
| model            | editor meta row       | `ctx.model.id` (prettified)                       |
| effort           | editor meta row       | `pi.getThinkingLevel()`                            |
| 5h usage + reset | footer line 2         | `GET api.anthropic.com/api/oauth/usage` `five_hour`|
| week usage + reset | footer line 2       | same endpoint, `seven_day`                         |

## Footer modes

Run `/fusion <mode>` to switch the footer layout (bare `/fusion` cycles). The
choice persists across sessions in `~/.pi/fusiontui.json`.

| Mode       | Shows                                                         |
| ---------- | ------------------------------------------------------------ |
| `full`     | everything; wraps to a second line when the terminal is tight (default) |
| `minimal`  | folder + branch on the left, `ctx` on the right; always one line |
| `adaptive` | renders `full`, but collapses to `minimal` instead of wrapping to two lines |

## Sound notifications

Faithful port of Droid's notification engine, including **both** of Droid's
trigger events: a **completion** sound when the agent finishes its turn, and an
**awaiting-input** sound when the agent asks *you* something (an
`ask_user_question`-style tool opens). Two sounds are bundled (extracted from
Droid): **FX-OK01** (soft success bloop, completion default) and **FX-ACK01**
(tactile ripple, awaiting-input default — same as Droid). Settings persist in
`~/.pi/fusiontui.json`.

```bash
/fusion-sound                 # interactive picker (completion sound)
/fusion-sound fx-ack01        # set the completion sound (previews it)
/fusion-sound ask fx-ok01     # set the awaiting-input sound (`ask` alone = picker)
/fusion-sound bell            # classic terminal bell (BEL)
/fusion-sound off             # disable
/fusion-sound /path/to.wav    # custom sound file
/fusion-sound focus unfocused # only ping when you're away from the terminal
/fusion-sound test            # preview the current sound
```

| Setting | Values | Default |
| ------- | ------ | ------- |
| `completionSound` | `off` \| `bell` \| `fx-ok01` \| `fx-ack01` \| `/abs/path.wav` | `fx-ok01` |
| `awaitingInputSound` | same values | `fx-ack01` |
| `soundFocusMode`  | `always` \| `focused` \| `unfocused` | `always` |

Droid also silences sounds inside subagents (`getDepth() > 0`); Pi subagents
run headless (`ctx.hasUI === false`), so fusiontui gets the same behavior for
free.

**How it works (macOS-first, cross-platform).** Playback shells out to the OS
audio player with a 2s timeout, degrading to the terminal bell on any failure:

| OS | Player |
| -- | ------ |
| macOS | `afplay` |
| Linux | `paplay` → `aplay -q` → `ffplay` (first found) |
| Windows | PowerShell `Media.SoundPlayer` |

`soundFocusMode` uses terminal focus-reporting (`\x1b[?1004h`): `unfocused` only
plays when you've tabbed away — enabled lazily and torn down on exit. On macOS
this works out of the box (`afplay` ships with the OS; iTerm2 / Terminal.app /
kitty / WezTerm all support focus reporting).

## Layout

```
                                              Opus 4.8 (High)     ← editor meta row (Droid style)
╭──────────────────────────────────────────────────────────────╮
│ › Review the changes in my current branch                      │
╰──────────────────────────────────────────────────────────────╯
  ~/pi-fusiontui   main [!2 ↑1]              ctx 42%/200k  ·  $0.452   ← footer line 1
 Claude  5h ━━────────  3% 4h2m    wk ━━━─────── 12% 1d23h            ← footer line 2
```

The composer **border color encodes the agent activity** (Droid encodes its
mode the same way): accent when idle, dim while the agent is working, warning
when the agent is **awaiting your input**. While streaming, the working row
reads `Thinking… / Generating… / Executing <tool>… · ctx N%` (Droid's
`⠋ Thinking… · context: 12%` analog).

## Droid transcript skin

The chat transcript replicates Droid's main-chat rendering 1:1 (traced from
the droid 0.158.0 bundle — components `InR`/`KgT`/`XkH`, the `factory-dark`
palette, and the verbatim `toolDisplay.*` strings):

```
 ⛬ I'll add a token-bucket limiter…        ← assistant icon ⛬ bold #d75f00 (Droid uT.primary)

   Read .../gateway/middleware.ts           ← bold #d7875f name + #b2b2b2 params, 3-space indent
    ↳ 50 lines read.                        ← muted #767676 summary, " (error)" in #d75f5f

   Execute npm test
    ↳ showing last 5/12 lines
    …output tail…

   Edit .../fusion/editor.ts
    ↳ Succeeded. File edited.
    @@ -1,2 +1,2 @@                          ← Droid diff colors (#5fff5f/#ff5f5f/#5fafd7)
```

* **Tool cards** — Pi's built-in `read`/`bash`/`edit`/`write`/`grep`/`find`/`ls`
  are re-registered under the same names with Droid display names
  (Read/Execute/Edit/Create/Grep/Glob/LS), `renderShell: "self"` and custom
  `renderCall`/`renderResult`; **execution delegates to the genuine built-in
  definitions** (`createReadToolDefinition` & co., exported by Pi).
  Registration happens at `session_start`, and any name already owned by
  another extension (e.g. `pi-diff`'s edit/write, `pi-fff`'s grep/find) is
  **skipped with a notice** — that extension keeps its execution behavior and
  no load-time conflict occurs; the transcript skin still applies its deliberate
  global Droid presentation policy to the resulting card.
* **Skin precedence** — Fusion intentionally owns the transcript presentation:
  custom/MCP tool renderers are normalized to the Droid fallback card, while
  same-name execution definitions owned by other extensions are never replaced.
  This is a product decision, not an interoperability fallback.
* **User messages** — Droid's prompt block: a 1-column `#d75f00` gutter bar +
  the message on a `#262626` block with text starting at column 3, no vertical
  padding (patches `UserMessageComponent.prototype.render`, OSC 133 prompt
  marks preserved, restored on shutdown).
* **Interrupt & error notices** — Pi's `Operation aborted` renders as Droid's
  verbatim `⎿ Interrupted` marker (`ayH`, muted `#767676`); `Error: …` lines
  get Droid's `●` notice bullet in `#d75f5f`. Interrupt-only turns show no
  assistant icon (Droid behavior).
* **Live status** — Pi's loader row can scroll into terminal scrollback
  mid-stream and persist (`⠋ Thinking…` lines between turns); Droid never
  commits status lines. The loader is hidden (`setWorkingVisible(false)`) and
  the spinner + `Thinking… · ctx N%` render above the composer instead.
* **Anti-corruption** — pi-tui's differ bakes stale rows into terminal
  scrollback when a repaint grows the frame past the viewport (duplicated
  lines, torn box borders after model switches). Two defenses: the editor
  keeps a **constant height** (status + meta rows are always reserved, blank
  when inactive), and a **forced full redraw** (`tui.requestRender(true)` —
  pi's own recovery path, reprints the whole session buffer) runs after
  `agent_end`, `model_select`, `thinking_level_select`, and compaction.
* **Scroll lock** — PageUp (or a reported mouse-wheel-up event) pauses all
  transcript renders while you read older output; PageDown/End resumes with a
  single redraw. `/fusion-hold` and `/fusion-follow` explicitly pause/resume
  when a terminal keeps mouse-wheel scrolling in its own scrollback instead of
  reporting it to the app.
* **Colors** are resolved from your **active Pi theme** (accent, toolTitle,
  diffs, borders…), so the skin follows whatever theme you select — e.g. the
  bundled `evangelion-dark`. When a token can't be resolved it falls back to
  the traced Droid `factory-dark` hex, so the default look is unchanged.
* **Paths** are `~`-abbreviated and capped at the last 3 segments (Droid `ht9`).
* **Assistant icon** patches `AssistantMessageComponent.prototype.render`
  (restored on shutdown).
* **Shimmer** — while a call is executing, the tool name animates with Droid's
  exact shimmer wave (port of `Cg1`/`yt9`): shared 50 ms ticker, 20-tick sweep,
  wave width `max(3, ⌊len × 0.6⌋)`, cosine falloff × 0.7, lerping the theme's
  `muted` toward `rgb(230,230,230)`, bold — frame-verified byte-identical to
  the droid formula. On completion the name latches to the theme's `toolTitle`;
  the ticker is ref-counted and stops itself when nothing animates.

## Themes

The package bundles two [Neon Genesis Evangelion](https://github.com/Oneptica/Zed-Theme-Evangelion)-inspired
theme variants (Unit-01 purple, LCL orange, NERV aesthetics), ported from the
Zed theme by Oneptica:

* `evangelion-dark` — Unit-01 purples on a deep `#0d0d14` night, neon-green
  success/diff-added, LCL-orange headings and warnings.
* `evangelion-light` — the same palette re-tuned for light terminals.

Select one via `/settings` → Theme, or in `settings.json`:

```json
{ "theme": "evangelion-dark" }
```

## Install

```bash
pi install git:github.com/nothingrotf/pi-fusiontui
# or, for local development:
pi install ./ -l
```

> [!IMPORTANT]
> Only one extension can own the footer/editor at a time (last loaded wins).
> If you also run `@ogulcancelik/pi-minimal-footer` or `pi-zentui`, disable them:
> `pi uninstall npm:@ogulcancelik/pi-minimal-footer`.

## Usage windows by provider

`fetchUsageForProvider()` maps the active model provider to its usage API:

- `anthropic` → `https://api.anthropic.com/api/oauth/usage` (`five_hour`, `seven_day`)
- `openai-codex` → `https://chatgpt.com/backend-api/wham/usage` (primary/secondary window)

Tokens are read from `~/.pi/agent/auth.json`. Add more providers by extending
that switch (see `@ogulcancelik/pi-minimal-footer` for Copilot/Gemini/Kimi/MiniMax).

## Architecture (reverse-engineered from pi-zentui)

| File          | Role                                                              |
| ------------- | ---------------------------------------------------------------- |
| `index.ts`    | Wires events → state → `setFooter` / `setEditorComponent`        |
| `state.ts`    | Mutable `FusionState` the renderers read from                    |
| `footer.ts`   | `ctx.ui.setFooter` component (stable one-line adaptive/minimal or two-line full) |
| `editor.ts`   | `CustomEditor` subclass: state-colored bubble + `model (effort)` row |
| `droid.ts`    | Droid transcript skin: tool-card overrides + assistant icon + palette |
| `git.ts`      | `git status --porcelain=2 --branch` parser                      |
| `usage.ts`    | Subscription 5h/weekly usage fetchers (Anthropic, Codex)         |
| `format.ts`   | Token/cost/model/effort/reset formatters                        |
| `theme.ts`    | Safe `theme.fg` + colored progress bars                         |
| `config.ts`   | Footer mode (`full`/`minimal`/`adaptive`) + persistence         |

Key Pi extension APIs used:

- `ctx.ui.setFooter(factory)` — custom statusline; `footerData.onBranchChange()`
- `ctx.ui.setEditorComponent(factory)` — custom input box (`extends CustomEditor`)
- `ctx.ui.setWorkingMessage(text)` — Droid-style `Thinking…/Executing…` labels
- `ctx.getContextUsage()` — `{ tokens, contextWindow, percent }`
- `ctx.model` — `{ id, provider, contextWindow, reasoning }`
- `pi.getThinkingLevel()` — current effort
- `ctx.sessionManager.getEntries()` — per-message `usage.cost.total`
- events: `session_start`, `model_select`, `thinking_level_select`,
  `agent_start`, `turn_start`, `message_start`, `message_end`, `agent_end`,
  `tool_execution_start`, `tool_execution_end`, `session_compact`,
  `session_shutdown`

## Contributing

Commits follow [Conventional Commits](https://www.conventionalcommits.org) and
are enforced by [commitlint](https://commitlint.js.org) via a Husky `commit-msg`
hook.

```
<type>(<scope>): <subject>
```

- **types**: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`
- **scopes**: `editor`, `footer`, `usage`, `git`, `format`, `theme`, `state`, `config`, `deps`, `release`

Example: `feat(editor): align autocomplete under the input`

Enable the hook locally:

```bash
npm install   # runs "prepare" → installs the Husky hook
```
