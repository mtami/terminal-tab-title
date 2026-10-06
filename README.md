# terminal-tab-title

Names the terminal tab Claude Code runs in. On your first prompt of a session, a quick Haiku call
turns it into a 2–4 word title such as `CSV Export Button`, and the plugin renames the tab Claude is
running in. It renames only that tab, never whichever tab happens to be focused.

`/tab-title <name>` sets the name yourself. `/tab-title` with no argument shows which method it
would use in the current terminal.

## Supported terminals

The plugin checks multiplexers first, because they own the tab you see and the outer terminal's
variables leak into them.

| Where Claude runs | How the tab is renamed | Needs |
| --- | --- | --- |
| tmux (also byobu) | `tmux rename-window -t $TMUX_PANE` (also turns off `automatic-rename` for that window) | – |
| zellij ≥ 0.44 | `zellij action list-panes --json` → `rename-tab --tab-id` | Older zellij can only rename the focused tab, so the plugin skips it |
| GNU screen | `screen -S $STY -p $WINDOW -X title` | – |
| herdr | `herdr tab rename $HERDR_TAB_ID` | – |
| WezTerm | `wezterm cli set-tab-title --pane-id $WEZTERM_PANE` | Under WSL, forward `WEZTERM_PANE` through `WSLENV` |
| kitty | `kitten @ --to $KITTY_LISTEN_ON set-tab-title --match window_id:…` | `allow_remote_control socket-only` and `listen_on unix:@kitty` in `kitty.conf` |
| Konsole | D-Bus `setTabTitleFormat` (`qdbus6`/`qdbus`) | – |
| ConEmu / cmder | `ConEmuC -GuiMacro Rename 0 …` | – |
| iTerm2, Terminal.app, Windows Terminal, Ghostty, VS Code, GNOME Terminal, Warp, Alacritty, … | OSC title escape sequence (OSC 1 on macOS terminals, OSC 30 on Konsole, OSC 0 elsewhere) | `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` (see below) |

### About OSC terminals

Claude Code already writes its own auto-generated topic title into the terminal title. For terminals
that show that title on the tab, you get a tab title without this plugin. The plugin's OSC write would
be overwritten anyway, so the plugin leaves those terminals alone by default. To have this plugin name
the tab instead, turn Claude Code's title off in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_DISABLE_TERMINAL_TITLE": "1" } }
```

Some terminals need their own setting before they show application titles: Windows Terminal profiles
need `suppressApplicationTitle` left off, and VS Code needs `${sequence}` in
`terminal.integrated.tabs.title`. The OSC write needs `sh` and `ps`, so on native Windows (outside
WSL) only the command-based terminals above work.

## Install

```
/plugin install terminal-tab-title --marketplace mtami/terminal-tab-title
```

Or from your shell:

```
claude plugin marketplace add mtami/terminal-tab-title
claude plugin install terminal-tab-title@terminal-tab-title
```

## What has been verified

On Linux (WSL2, Ubuntu): tmux 3.6, screen 4.09, herdr 0.8, kitty 0.48 (remote control over a socket),
zellij 0.45 (`list-panes` + `rename-tab --tab-id`), and the OSC path, each against the real program.
tmux and the OSC path were also checked end to end in a live Claude Code session. WezTerm, Konsole,
ConEmu, macOS and native Windows are implemented from each tool's documentation and covered by unit
tests, but haven't been run against the real terminal yet. Reports are welcome.

## License

MIT
