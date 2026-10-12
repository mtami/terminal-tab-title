// Works out how to rename the tab this process runs in, from its environment alone.
// Pure: no `$`, so every terminal's detection is covered by plain tests.

export type Env = {
  HERDR_TAB_ID?: string
  HERDR_BIN_PATH?: string
  TMUX?: string
  TMUX_PANE?: string
  ZELLIJ?: string
  ZELLIJ_PANE_ID?: string
  STY?: string
  WINDOW?: string
  WEZTERM_PANE?: string
  KITTY_WINDOW_ID?: string
  KITTY_LISTEN_ON?: string
  KONSOLE_DBUS_SERVICE?: string
  KONSOLE_DBUS_SESSION?: string
  ConEmuPID?: string
  TERM_PROGRAM?: string
  TERM?: string
  WT_SESSION?: string
  WSL_DISTRO_NAME?: string
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE?: string
}

// One way to rename the tab; the runner tries a plan's attempts in order until one succeeds.
export type Attempt =
  | { backend: string; run: string[] }
  | { backend: 'zellij'; zellijPane: number }
  | { backend: string; osc: string }

export type Plan = { attempts: Attempt[]; note?: string }

const ESC = '\u001b'
const BEL = '\u0007'

export function cleanLabel(raw: string): string {
  return (raw.split('\n')[0] ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/["'`*_#%]/g, '')
    .replace(/[.:;!?]+$/, '')
    .trim()
    .slice(0, 32)
    .trim()
}

export function oscSequence(code: 0 | 1 | 2 | 30, label: string): string {
  return `${ESC}]${code};${label}${BEL}`
}

// OSC 1 is the tab (not window) title on macOS terminals; Konsole's tab title is OSC 30.
function oscCodeFor(env: Env): 0 | 1 | 30 {
  if (env.TERM_PROGRAM === 'iTerm.app' || env.TERM_PROGRAM === 'Apple_Terminal') return 1
  if (env.KONSOLE_DBUS_SESSION) return 30
  return 0
}

function oscName(env: Env): string {
  if (env.WT_SESSION) return 'windows-terminal'
  if (env.TERM_PROGRAM) return env.TERM_PROGRAM.toLowerCase()
  return 'osc'
}

export function isOn(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false'
}

// Whether an OSC title would last in this agent, and what to say when it wouldn't.
export type OscPolicy = { isAllowed: boolean; note: string }

const CLAUDE_OSC: (env: Env) => OscPolicy = env => ({
  isAllowed: isOn(env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE),
  note: 'Claude Code already sets this terminal’s title; set CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 to let this plugin name it instead',
})

export function plan(env: Env, label: string, osc: OscPolicy = CLAUDE_OSC(env)): Plan {
  // Multiplexers first: they own the tab the person sees, and the outer terminal's variables leak into them.
  if (env.HERDR_TAB_ID) {
    return { attempts: [{ backend: 'herdr', run: [env.HERDR_BIN_PATH || 'herdr', 'tab', 'rename', env.HERDR_TAB_ID, label] }] }
  }
  if (env.TMUX && env.TMUX_PANE) {
    // rename-window also turns automatic-rename off for that window, so the name sticks.
    return { attempts: [{ backend: 'tmux', run: ['tmux', 'rename-window', '-t', env.TMUX_PANE, label] }] }
  }
  if (env.ZELLIJ !== undefined && env.ZELLIJ_PANE_ID && /^\d+$/.test(env.ZELLIJ_PANE_ID)) {
    return { attempts: [{ backend: 'zellij', zellijPane: Number(env.ZELLIJ_PANE_ID) }] }
  }
  if (env.STY) {
    return { attempts: [{ backend: 'screen', run: ['screen', '-S', env.STY, '-p', env.WINDOW || '0', '-X', 'title', label] }] }
  }

  const attempts: Attempt[] = []
  if (env.WEZTERM_PANE) {
    const wezterm = env.WSL_DISTRO_NAME ? 'wezterm.exe' : 'wezterm'
    attempts.push({ backend: 'wezterm', run: [wezterm, 'cli', 'set-tab-title', '--pane-id', env.WEZTERM_PANE, label] })
  }
  if (env.KITTY_WINDOW_ID && env.KITTY_LISTEN_ON) {
    const match = `window_id:${env.KITTY_WINDOW_ID}`
    attempts.push({ backend: 'kitty', run: ['kitten', '@', '--to', env.KITTY_LISTEN_ON, 'set-tab-title', '--match', match, label] })
    attempts.push({ backend: 'kitty', run: ['kitty', '@', '--to', env.KITTY_LISTEN_ON, 'set-tab-title', '--match', match, label] })
  }
  if (env.KONSOLE_DBUS_SERVICE && env.KONSOLE_DBUS_SESSION) {
    for (const qdbus of ['qdbus6', 'qdbus']) {
      const target = [qdbus, env.KONSOLE_DBUS_SERVICE, env.KONSOLE_DBUS_SESSION, 'org.kde.konsole.Session.setTabTitleFormat']
      attempts.push({ backend: 'konsole', run: [...target, '0', label] })
    }
  }
  if (env.ConEmuPID) {
    attempts.push({ backend: 'conemu', run: ['ConEmuC', '-GuiMacro', 'Rename', '0', label] })
  }

  // Agents that write their own OSC title would overwrite ours, so it only lasts once the agent stops.
  if (osc.isAllowed) {
    attempts.push({ backend: oscName(env), osc: oscSequence(oscCodeFor(env), label) })
    return { attempts }
  }

  return { attempts, note: attempts.length > 0 ? undefined : osc.note }
}

type ZellijPane = { id?: unknown; is_plugin?: unknown; tab_id?: unknown }

// `zellij action list-panes --json --tab` (0.44+): plugin and terminal panes share ids, so skip plugins.
export function zellijTabId(listJson: string, paneId: number): number | undefined {
  let panes: unknown
  try {
    panes = JSON.parse(listJson)
  } catch {
    return undefined
  }
  if (!Array.isArray(panes)) return undefined
  const pane = (panes as ZellijPane[]).find(one => one.id === paneId && one.is_plugin === false)

  return typeof pane?.tab_id === 'number' ? pane.tab_id : undefined
}

// Children of Claude Code have no controlling tty, so walk up to the first ancestor that has one
// (Claude Code itself) and write the sequence to that device. POSIX sh + ps: Linux, macOS, WSL.
export const OSC_WRITER = [
  'p=$PPID',
  'while [ -n "$p" ] && [ "$p" -gt 1 ]; do',
  '  t=$(ps -o tty= -p "$p" 2>/dev/null | tr -d " ")',
  '  case "$t" in',
  '    ""|"?"|"??") p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d " ") ;;',
  '    *) printf "%s" "$1" > "/dev/$t"; exit $? ;;',
  '  esac',
  'done',
  'exit 3',
].join('\n')
