# Pi setup

Personal [Pi](https://pi.dev/) package based on
[`davis7dotsh/my-pi-setup`](https://github.com/davis7dotsh/my-pi-setup).

## Installation

Install a reviewed release globally:

```sh
pi install git:github.com/sudokvn/pi-setup@v0.5.1
```

Pi manages the checkout and runtime dependencies. Do not clone this repository
over `~/.pi/agent`. Installed tags stay pinned until explicitly updated.
The package does not deploy personal or global agent instructions.

Install these executables on `PATH` for the features you use:

| Feature                 | Requirements                                  |
| ----------------------- | --------------------------------------------- |
| File search             | `fd` (or `fdfind`), `rg` and `fzf` 0.35+      |
| PDF reading             | Poppler (`pdfinfo` and `pdftotext`)           |
| Claude subagents        | Claude Code, authenticated with `claude auth` |
| Codex subagents         | Codex CLI, authenticated with `codex login`   |

## Included tools and commands

- Dashboard with per-response runtime, VCS status and changed-file views,
  preferring JJ over Git.
- One-line tool rows with the status, call, duration and, on failure, the last
  error line. Running rows show a spinner and elapsed seconds in the accent
  color; finished rows turn grey with ✓ or ✗. `codemode` rows show their call
  count and cost instead of the script. Press Ctrl+O, or click a row, to show
  the full call and output.
- Herdr-aware `ask-user`, background terminals and `fd`/`rg`/`fuzzy-find` file search.
- `read-pdf` for local files and public PDF URLs, using Poppler rather than OCR.
- Web search, page fetching and Developer Index search, described below.
- Pi, Claude Code and Codex subagents, with companion skills for subagents and
  background terminals. Open their panels with `/subagents` or Ctrl+Shift+S,
  and `/ps` or Ctrl+Shift+B.
- `/undo` rewinds the latest user turn and restores its text to the editor.
  The old branch remains in `/tree`. It requires an idle agent and does not undo
  files or other side effects.
- Quote the agent's latest answer into your prompt: type `>` on an empty line
  to pick a paragraph, list item or code block from a framed panel above the
  editor. It takes vim-style keys: `j`/`k`, `g`/`G` and Ctrl+D/Ctrl+U move,
  `/` filters, Enter inserts, `q` or Esc closes. Ctrl+Q or `/quote` quotes
  the whole answer. Type `> ` with a space to write a quote yourself. The `>`
  picker is skipped if another extension replaces Pi's editor.
- Alt+V pastes the clipboard's text as a fenced code block, on its own
  paragraph. The fence outgrows any backticks inside the text. It reads the
  clipboard with `pbpaste` on macOS and `wl-paste`, `xclip` or `xsel` on Linux.
- `/jj` browses Jujutsu history with diffs and runs describe, sign, new, edit,
  squash, abandon, undo, bookmark and push on the selected revision. Push
  shows jj's dry run and pushes only after confirmation.
- Mouse selections in fullscreen mode copy wrapped text without the line
  breaks Pi adds at the screen edge. Lists, quotes, tables and code keep their
  lines. This patches a private Pi method; if Pi changes it, copying falls back
  to Pi's behavior.
- `/recap` summarizes the current task, progress and next step in at most 40 words.
- A CLIProxyAPI provider for GPT and Claude models behind a CPA server, with
  WebSocket continuation for GPT. It stays off until `cliproxyapi.json` exists;
  see [its README](extensions/cliproxyapi-provider/README.md). `/proxy`
  shows a short summary, `/proxy models` shows model details and `/proxy refresh`
  updates the catalog.

To use an included theme, set `"theme"` to `"github-dark-default"`,
`"dark-mini"` or `"nightside-ember"` in `~/.pi/agent/settings.json`.
`nightside-ember` is the Heylogix terminal theme with amber as the agent colour:
pure black, no editor frame, tool blocks on navy, red only for errors. `dark-mini` is Pi's `dark` theme
without backgrounds behind user messages and tool calls, and with one editor
border color for every thinking level. Reasoning blocks are prefixed with
_Thinking:_; user messages have no added transcript marker.

## Web tools

No credentials are required. Results are untrusted source material, not
instructions. Inline output is sanitized and limited to 16KB or 400 lines;
truncated output includes a file path for reading the rest. Expand tool cards
with Ctrl+O to see their content.

### Search

`web-search` uses anonymous Exa MCP with Firecrawl fallback for recognized
transient failures, rate limits and unavailable pages. Authentication, billing,
validation and cancellation failures never trigger fallback. Empty results are
valid. Requests do not use configured API keys.

Results contain source URLs and excerpts, not synthesized answers. Domain and
recency filters are supported. Set `provider: "exa"` or `provider: "firecrawl"`
for an explicit request with automatic fallback disabled.

### Page fetching and privacy

`web-fetch` reads public HTTP(S) pages directly from this machine. It validates
DNS and redirects, blocks private destinations and sends no cookies or
credentials. HTML becomes readable text; JavaScript does not run. Downloads are
limited to 5 MiB, with a default timeout of 30 seconds.

Eligible local failures show a short note and automatically send the URL to
anonymous Exa MCP, including in headless runs. Firecrawl fallback is automatic
for transient failures, temporary rate limits and unavailable pages. If Exa
reports a quota or billing limit, Pi asks before trying Firecrawl for that
request. Declining, dismissing or running headless stops that quota fallback.
If Firecrawl also fails, the request stops. No paid access or configured API
keys are used. Hosted providers control their own redirects and browser behavior.
Unsafe URLs, authentication failures and other terminal local errors never
trigger hosted recovery.

For a separate explicit `web-fetch-hosted` tool, set `PI_WEB_HOSTED_FETCH=1` in
the process environment before starting Pi. Like automatic recovery, it sends
URLs to third parties. Never use it to bypass a declined quota fallback.
This setting is not needed for automatic recovery.

### Developer Index

`developer-search` searches library docs, upstream issues, merged pull requests
and READMEs through Firecrawl's Developer Index. Scope queries with `types`,
`repos` or `sources`; coverage reports identify degraded or unavailable indexes.

Only this tool reads optional `FIRECRAWL_API_KEY`, first from the process
environment, then from `~/.pi/agent/.env`. A configured key uses account limits.
See [`.env.example`](.env.example). Never commit credentials.

## Subagents

Use `subagent-spawn` with a release-pinned profile, or `subagent-spawn-direct`
when requesting a particular harness or model. Profiles have no automatic model
fallback. Direct runs need their role and constraints in the prompt.

Up to four runs can be active. Finished runs never post into the conversation
or start a turn. The footer counts them as ready or failed until the agent
collects them with `subagent-wait` or `subagent-check`. To clear them yourself,
press `c` (selected run) or `C` (all runs) in `/subagents`; the runs stay
available there. Recovery artifacts are stored under
`~/.pi/agent/state/subagents/` and restored only for the same parent session.
Interrupted runs require explicit `subagent-resume`; they never restart
automatically. See [Subagents architecture](extensions/subagents/docs/design-plan.md)
for profiles, guidance loading and recovery behavior.

### Subagents in Herdr

In a Herdr terminal, Pi publishes each run as an OSC 7501 status record of its
own terminal, so herdr-core keeps the runs under the Pi that started them. A
record holds the run id, the harness, the run's name and its state, never
prompts, output or errors. By-the-way questions appear as "by the way". Like
the footer, the records cover running runs and settled runs that are not yet
collected. Pi's own status is left as it is. Nothing is written outside a
herdr-core terminal or in print, JSON and RPC modes. `PI_PROGRAM_STATUS=0`
turns the records off along with Pi's own reports. `hc get <t> --json` shows
them under `records`.

Herdr's stock Agents sidebar does not show these runs, because they do not
have their own `hc` terminals. The experimental
`pi-agents-experiment` mod is a copy of Herdr 0.1.14's Agents mod that adds
them to the tree under their parent Pi, next to native child terminals and with
the same status symbols (an `error` record shows as needing you). Clicking a run
opens a read-only view of its assistant output and current tools. Use
`/subagents` in Pi to send instructions or cancel a run. See
[`UPSTREAM.md`](herdr/mods/pi-agents-experiment/UPSTREAM.md) for what changed
from the stock mod and how the output view reads it.

The experiment runs in its own layout, so Herdr's shipped layouts and mods stay
untouched. To set it up, run these commands from the root of a pi-setup
checkout or of the installed package under `~/.pi/agent/git/`:

1. Copy the mod into Herdr's mods folder and check it:

   ```sh
   home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
   mkdir -p "$home/mods"
   cp -R herdr/mods/pi-agents-experiment "$home/mods/"
   herdr-app check "$home/mods/pi-agents-experiment"
   ```

2. Clone the main layout. Herdr switches to the clone:

   ```sh
   herdr-app do layout.clone '{"name":"main","as":"pi-subagents-experiment"}'
   ```

3. In `$home/layouts/pi-subagents-experiment.json`, change the Agents block's
   `"mod": "agents"` to `"mod": "pi-agents-experiment"`. Change nothing else.
   Herdr applies the edit live.

To return to the stock layout, run `herdr-app do layout.switch --name main`.
After updating this package, copy the mod folder again. Herdr updates its own
Agents mod, not this copy.

Known limit: when Pi releases the terminal for Ctrl+Z, the external editor or a
TUI mode switch, it clears every status record of the terminal and restores
only its own. Each row stays hidden until its own run's name, state or
collection changes, or until the parent starts its next agent run, which sends
all rows again. Output and tool activity inside a run do not bring rows back.

## Development

Use pnpm and edit this source repository, not an installed package checkout.
Before releasing, run:

```sh
pnpm test
pnpm check
pnpm format:check
pnpm pack --dry-run
```

`pnpm test:cli` additionally runs the CLIProxyAPI provider from a
runtime-only package under the installed `pi` binary.

See [AGENTS.md](AGENTS.md) for repository and release guidelines.
