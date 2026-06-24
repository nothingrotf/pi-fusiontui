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

## Layout

```
                                              Opus 4.8 (High)     ← editor meta row (Droid style)
╭──────────────────────────────────────────────────────────────╮
│ › Review the changes in my current branch                      │
╰──────────────────────────────────────────────────────────────╯
  ~/pi-fusiontui   main [!2 ↑1]              ctx 42%/200k  ·  $0.452   ← footer line 1
 Claude  5h ━━────────  3% 4h2m    wk ━━━─────── 12% 1d23h            ← footer line 2
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
| `footer.ts`   | `ctx.ui.setFooter` component (2 lines: info + usage bars)        |
| `editor.ts`   | `CustomEditor` subclass adding the Droid `model (effort)` row    |
| `git.ts`      | `git status --porcelain=2 --branch` parser                      |
| `usage.ts`    | Subscription 5h/weekly usage fetchers (Anthropic, Codex)         |
| `format.ts`   | Token/cost/model/effort/reset formatters                        |
| `theme.ts`    | Safe `theme.fg` + colored progress bars                         |

Key Pi extension APIs used:

- `ctx.ui.setFooter(factory)` — custom statusline; `footerData.onBranchChange()`
- `ctx.ui.setEditorComponent(factory)` — custom input box (`extends CustomEditor`)
- `ctx.getContextUsage()` — `{ tokens, contextWindow, percent }`
- `ctx.model` — `{ id, provider, contextWindow, reasoning }`
- `pi.getThinkingLevel()` — current effort
- `ctx.sessionManager.getEntries()` — per-message `usage.cost.total`
- events: `session_start`, `model_select`, `thinking_level_select`,
  `message_end`, `agent_end`, `tool_execution_end`, `session_compact`,
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
