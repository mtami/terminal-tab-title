# terminal-tab-title

Names the terminal tab your coding agent runs in. Works with **Claude Code, Codex, Cursor, Gemini CLI
and opencode**, plus any agent that can run a shell command.

Your first prompt of a session is turned into a 2–4 word title such as `CSV Export Button`, and the tab
the agent is running in gets that name. Only that tab is renamed, never whichever tab happens to be
focused, so ten agents in ten tabs stay easy to tell apart.

## Install

Pick whichever fits. They all use the same script.

**Any agent, as a skill** ([skills.sh](https://skills.sh)): the agent can rename its tab when you ask,
and can set up automatic naming for you:

```sh
npx skills add mtami/terminal-tab-title
```

**Automatic naming from the first prompt** (a prompt hook per agent):

```sh
npx terminal-tab-title install codex cursor gemini opencode   # or: install all
```

| Agent | What gets installed | Then |
| --- | --- | --- |
| Codex | `UserPromptSubmit` hook in `~/.codex/hooks.json` | Run `/hooks` once to review and trust it |
| Cursor (editor agent and `cursor-agent`) | `beforeSubmitPrompt` hook in `~/.cursor/hooks.json` | Restart Cursor |
| Gemini CLI | `BeforeAgent` hook in `~/.gemini/settings.json` | Check `/hooks` shows it enabled |
| opencode | plugin in `~/.config/opencode/plugins/terminal-tab-title.js` | Restart opencode |
| Claude Code | use the plugin below | – |

The installer copies the script to `~/.local/share/terminal-tab-title/`. It merges its hook into the
existing config, keeps a `.bak` of the old file, and never rewrites a file it can't parse.
`npx terminal-tab-title uninstall <agent>` removes the hook.

**Claude Code plugin** (names the tab with Haiku and adds `/tab-title`):

```
/plugin install terminal-tab-title --marketplace mtami/terminal-tab-title
```

## Commands

```sh
tab-title set "Release Notes" --agent codex   # rename this tab now
tab-title detect --agent cursor              # show which method this tab would use
tab-title install <agent...|all>             # automatic naming
tab-title uninstall <agent...|all>
```

(`npx terminal-tab-title …` works without installing anything.)

## How titles are made

When no model is configured, a keyword heuristic makes the title. It needs no network:
`can you add a delete button to my exports` → `Add Delete Button Exports`.

If a model is available, it writes a better title. The first one that applies wins:

| Setting | Uses |
| --- | --- |
| `TAB_TITLE_LLM=off` | Heuristic only, nothing leaves your machine |
| `TAB_TITLE_COMMAND="claude -p --model haiku"` | Any command that reads the prompt on stdin and prints a title |
| `ANTHROPIC_API_KEY` | `claude-haiku-5-5` |
| `OPENAI_API_KEY` | `gpt-5-nano` |

`TAB_TITLE_MODEL` overrides the model. **With an API key set, the first prompt of each session is sent
to that provider** to make the title. Set `TAB_TITLE_LLM=off` if you'd rather it weren't.

Naming runs in a detached background process, so it never holds up your prompt. Results and errors go
to a log file whose path `tab-title detect` prints.

## Supported terminals

Multiplexers are checked first, because they own the tab you see and the outer terminal's variables
leak into them.

| Where the agent runs | How the tab is renamed | Needs |
| --- | --- | --- |
| tmux (also byobu) | `tmux rename-window -t $TMUX_PANE` (also turns off `automatic-rename` for that window) | – |
| zellij ≥ 0.44 | `zellij action list-panes --json` → `rename-tab --tab-id` | Older zellij can only rename the focused tab, so it is skipped |
| GNU screen | `screen -S $STY -p $WINDOW -X title` | – |
| herdr | `herdr tab rename $HERDR_TAB_ID` | – |
| WezTerm | `wezterm cli set-tab-title --pane-id $WEZTERM_PANE` | Under WSL, forward `WEZTERM_PANE` through `WSLENV` |
| kitty | `kitten @ --to $KITTY_LISTEN_ON set-tab-title --match window_id:…` | `allow_remote_control socket-only` and `listen_on unix:@kitty` in `kitty.conf` |
| Konsole | D-Bus `setTabTitleFormat` (`qdbus6`/`qdbus`) | – |
| ConEmu / cmder | `ConEmuC -GuiMacro Rename 0 …` | – |
| iTerm2, Terminal.app, Windows Terminal, Ghostty, VS Code, GNOME Terminal, Warp, Alacritty, … | OSC title escape sequence written to the agent's terminal (OSC 1 on macOS terminals, OSC 30 on Konsole, OSC 0 elsewhere) | See below |

### OSC terminals and agents that set their own title

Claude Code, Codex and Gemini CLI write their own terminal title, which would overwrite an OSC title
straight away. In a plain OSC terminal, terminal-tab-title therefore leaves the title to the agent
unless you turn the agent's title off:

| Agent | Turn its own title off with |
| --- | --- |
| Claude Code | `{ "env": { "CLAUDE_CODE_DISABLE_TERMINAL_TITLE": "1" } }` in `~/.claude/settings.json` |
| Codex | Codex's `/title` command, then `TAB_TITLE_OSC=1` |
| Gemini CLI | `"ui": { "hideWindowTitle": true }` in `~/.gemini/settings.json` |

Cursor and opencode get the OSC title by default. `TAB_TITLE_OSC=1` or `0` forces it on or off for
any agent. Multiplexers and the scriptable terminals above don't have this problem.

Some terminals need a setting before they show application titles. Windows Terminal profiles need
`suppressApplicationTitle` left off, and VS Code needs `${sequence}` in `terminal.integrated.tabs.title`.
The OSC write needs `ps`, so on native Windows (outside WSL) only the command-based terminals work.

## What has been verified

- **Claude Code plugin** on Linux (WSL2, Ubuntu): tmux 3.6, screen 4.09, herdr 0.8, kitty 0.48 (remote
  control over a socket), zellij 0.45, and the OSC path, each against the real program. tmux and the
  OSC path were also checked end to end in a live Claude Code session.
- **Hook CLI:** unit tests cover every agent's payload, reply format and config merge. End-to-end tests
  run the built script as each agent's hook would, against a stub multiplexer.
- **Not yet verified live:** the Codex, Cursor, Gemini CLI and opencode hooks are built from each
  agent's hook documentation and haven't been run inside those agents yet. The same goes for WezTerm,
  Konsole, ConEmu, macOS and native Windows.

Reports and PRs are welcome.

## Development

```sh
bun run build   # bundles src/ into skills/terminal-tab-title/scripts/tab-title.mjs (committed, so skills.sh installs work)
bun run test    # CLI tests; the Claude Code plugin's tests in tests/*.test.ts run under Claude Code's plugin test kit
```

`hooks/backends.ts` holds the terminal detection, and both the Claude Code plugin (`hooks/register.ts`)
and the CLI (`src/`) use it.

## License

MIT
