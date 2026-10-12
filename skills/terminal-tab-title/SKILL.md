---
name: terminal-tab-title
description: Rename the terminal tab this coding agent runs in (tmux, zellij, screen, herdr, WezTerm, kitty, Konsole, ConEmu, iTerm2, Terminal.app, Windows Terminal, Ghostty and other OSC terminals), or set up automatic tab naming from each session's first prompt. Use when the user asks to name, rename or label the terminal/tab/window, wants tabs named automatically, or asks which terminal method would be used.
---

# terminal-tab-title

Names the terminal tab that *this agent* is running in. It never touches whichever tab happens to be focused.
The bundled script `scripts/tab-title.mjs` (Node 18+, no dependencies) does the work. Run it with `node`, using the path relative to this skill's directory.

Always pass `--agent` with the agent you are: `claude`, `codex`, `cursor`, `gemini` or `opencode`. If you are none of these, leave it out.

## Rename the tab now

Pick a 2–4 word Title Case name that summarises the current task (for example `CSV Export Button`), unless the user gave one:

```sh
node <skill-dir>/scripts/tab-title.mjs set "CSV Export Button" --agent <agent>
```

It prints which method renamed the tab, or why it couldn't. If it says the agent already sets the terminal's title, tell the user which setting the message names. Don't change their settings yourself.

## Check what would happen

```sh
node <skill-dir>/scripts/tab-title.mjs detect --agent <agent>
```

## Name tabs automatically (one-time setup)

Only do this when the user asks for it. It installs a prompt hook so every new session names its tab from the first prompt, with no tool call needed:

```sh
node <skill-dir>/scripts/tab-title.mjs install <agent>    # or: codex cursor gemini opencode / all
```

This copies the script to `~/.local/share/terminal-tab-title/`. It then merges a hook into that agent's config (`~/.codex/hooks.json`, `~/.cursor/hooks.json`, `~/.gemini/settings.json`, or an opencode plugin) and keeps a `.bak` of the old file. For Claude Code it prints the plugin install commands instead. Relay any follow-up step the output names, such as trusting the hook with `/hooks` in Codex or restarting Cursor. `uninstall <agent>` removes the hook.

Titles come from a keyword heuristic. If `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set, a small model writes them instead, and the first prompt is sent to that provider. `TAB_TITLE_LLM=off` keeps prompts local, and `TAB_TITLE_COMMAND` can name any command that reads the prompt on stdin. Mention this when you set it up.
