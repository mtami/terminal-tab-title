import { describe, expect, test } from 'claude-code/testing'

import { cleanLabel, oscSequence, plan, zellijTabId } from '../hooks/backends'
import type { Attempt } from '../hooks/backends'

const L = 'Export History Delete'
const argvs = (attempts: Attempt[]) => attempts.map(one => ('run' in one ? one.run : one))

describe('plan', () => {
  test('herdr wins over the terminal it runs inside', async () => {
    const { attempts } = plan({ HERDR_TAB_ID: 'w1:t2', HERDR_BIN_PATH: '/h/herdr', TERM_PROGRAM: 'WezTerm', WEZTERM_PANE: '3' }, L)
    expect(argvs(attempts)).toEqual([['/h/herdr', 'tab', 'rename', 'w1:t2', L]])
  })

  test('tmux targets the window holding its own pane', async () => {
    const { attempts } = plan({ TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%7', TERM_PROGRAM: 'iTerm.app' }, L)
    expect(argvs(attempts)).toEqual([['tmux', 'rename-window', '-t', '%7', L]])
  })

  test('zellij looks its pane up by id', async () => {
    expect(plan({ ZELLIJ: '0', ZELLIJ_PANE_ID: '4' }, L).attempts).toEqual([{ backend: 'zellij', zellijPane: 4 }])
  })

  test('screen names its own window', async () => {
    const { attempts } = plan({ STY: '123.pts-0.host', WINDOW: '2' }, L)
    expect(argvs(attempts)).toEqual([['screen', '-S', '123.pts-0.host', '-p', '2', '-X', 'title', L]])
  })

  test('wezterm uses its pane id, and wezterm.exe under WSL', async () => {
    expect(argvs(plan({ WEZTERM_PANE: '5' }, L).attempts)[0]).toEqual(['wezterm', 'cli', 'set-tab-title', '--pane-id', '5', L])
    expect(argvs(plan({ WEZTERM_PANE: '5', WSL_DISTRO_NAME: 'Ubuntu' }, L).attempts)[0]?.[0]).toBe('wezterm.exe')
  })

  test('kitty matches its own window over the socket, never the active tab', async () => {
    const { attempts } = plan({ KITTY_WINDOW_ID: '1', KITTY_LISTEN_ON: 'unix:@k' }, L)
    expect(argvs(attempts)[0]).toEqual(['kitten', '@', '--to', 'unix:@k', 'set-tab-title', '--match', 'window_id:1', L])
    expect(plan({ KITTY_WINDOW_ID: '1' }, L).attempts).toEqual([])
  })

  test('konsole goes through D-Bus, then OSC 30 once Claude Code leaves the title', async () => {
    const env = { KONSOLE_DBUS_SERVICE: ':1.5', KONSOLE_DBUS_SESSION: '/Sessions/1', CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' }
    const { attempts } = plan(env, L)
    expect(attempts.map(one => one.backend)).toEqual(['konsole', 'konsole', 'osc'])
    expect(attempts[2]).toEqual({ backend: 'osc', osc: oscSequence(30, L) })
  })

  test('OSC terminals only when Claude Code no longer writes the title', async () => {
    const off = plan({ TERM_PROGRAM: 'ghostty' }, L)
    expect(off.attempts).toEqual([])
    expect(off.note).toContain('CLAUDE_CODE_DISABLE_TERMINAL_TITLE')

    expect(plan({ TERM_PROGRAM: 'iTerm.app', CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' }, L).attempts).toEqual([
      { backend: 'iterm.app', osc: `\u001b]1;${L}\u0007` },
    ])
    expect(plan({ WT_SESSION: 'guid', CLAUDE_CODE_DISABLE_TERMINAL_TITLE: 'true' }, L).attempts).toEqual([
      { backend: 'windows-terminal', osc: `\u001b]0;${L}\u0007` },
    ])
    expect(plan({ WT_SESSION: 'guid', CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '0' }, L).attempts).toEqual([])
  })
})

test('cleanLabel keeps one safe short line', async () => {
  expect(cleanLabel('"Export History Delete."\nextra')).toBe(L)
  expect(cleanLabel('Bad\u001b]0;evil\u0007 Title')).toBe('Bad]0;evil Title')
  expect(cleanLabel('A Very Long Title That Goes On And On Forever').length).toBeLessThanOrEqual(32)
})

test('zellijTabId skips plugin panes that share the id', async () => {
  const list = JSON.stringify([
    { id: 0, is_plugin: true, tab_id: 9 },
    { id: 0, is_plugin: false, tab_id: 2 },
  ])
  expect(zellijTabId(list, 0)).toBe(2)
  expect(zellijTabId(list, 1)).toBeUndefined()
  expect(zellijTabId('not json', 0)).toBeUndefined()
})
