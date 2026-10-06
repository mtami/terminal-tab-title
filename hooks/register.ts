import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

import { OSC_WRITER, cleanLabel, plan, zellijTabId } from './backends'
import type { Attempt, Env } from './backends'

const isNamed = atom({ plugin: 'terminal-tab-title', key: 'isNamed' } as const, false)

const SYSTEM =
  'You name terminal tabs. Reply with a 2-4 word title (Title Case, no quotes, ' +
  'no trailing punctuation) summarising the task in the user message. Reply with the title only.'

const TIMEOUT = { timeoutMs: 5000 }

// The engine stamps every session prompt; an unstamped one (the test kit) counts as typed.
function isFromPerson(origin: PromptOrigin | undefined): boolean {
  return (
    origin === undefined ||
    origin.kind === 'composer' ||
    origin.kind === 'bridge' ||
    (origin.kind === 'plugin' && 'asUser' in origin && origin.asUser === true)
  )
}

async function readEnv($: EngineInterface): Promise<Env> {
  const [
    HERDR_TAB_ID, HERDR_BIN_PATH, TMUX, TMUX_PANE, ZELLIJ, ZELLIJ_PANE_ID, STY, WINDOW,
    WEZTERM_PANE, KITTY_WINDOW_ID, KITTY_LISTEN_ON, KONSOLE_DBUS_SERVICE, KONSOLE_DBUS_SESSION,
    ConEmuPID, TERM_PROGRAM, TERM, WT_SESSION, WSL_DISTRO_NAME, CLAUDE_CODE_DISABLE_TERMINAL_TITLE,
  ] = await Promise.all([
    $.env.get('HERDR_TAB_ID'), $.env.get('HERDR_BIN_PATH'), $.env.get('TMUX'), $.env.get('TMUX_PANE'),
    $.env.get('ZELLIJ'), $.env.get('ZELLIJ_PANE_ID'), $.env.get('STY'), $.env.get('WINDOW'),
    $.env.get('WEZTERM_PANE'), $.env.get('KITTY_WINDOW_ID'), $.env.get('KITTY_LISTEN_ON'),
    $.env.get('KONSOLE_DBUS_SERVICE'), $.env.get('KONSOLE_DBUS_SESSION'), $.env.get('ConEmuPID'),
    $.env.get('TERM_PROGRAM'), $.env.get('TERM'), $.env.get('WT_SESSION'), $.env.get('WSL_DISTRO_NAME'),
    $.env.get('CLAUDE_CODE_DISABLE_TERMINAL_TITLE'),
  ])

  return {
    HERDR_TAB_ID, HERDR_BIN_PATH, TMUX, TMUX_PANE, ZELLIJ, ZELLIJ_PANE_ID, STY, WINDOW,
    WEZTERM_PANE, KITTY_WINDOW_ID, KITTY_LISTEN_ON, KONSOLE_DBUS_SERVICE, KONSOLE_DBUS_SESSION,
    ConEmuPID, TERM_PROGRAM, TERM, WT_SESSION, WSL_DISTRO_NAME, CLAUDE_CODE_DISABLE_TERMINAL_TITLE,
  }
}

async function tryAttempt($: EngineInterface, attempt: Attempt, label: string): Promise<boolean> {
  if ('run' in attempt) {
    const ran = await $.process.run(attempt.run, TIMEOUT)

    return ran.exitCode === 0
  }
  if ('zellijPane' in attempt) {
    const listed = await $.process.run(['zellij', 'action', 'list-panes', '--json', '--tab'], TIMEOUT)
    // Before 0.44 there is no list-panes and rename-tab only hits the focused tab: leave it alone.
    const tabId = listed.exitCode === 0 ? zellijTabId(listed.stdout, attempt.zellijPane) : undefined
    if (tabId === undefined) return false
    const ran = await $.process.run(['zellij', 'action', 'rename-tab', '--tab-id', String(tabId), label], TIMEOUT)

    return ran.exitCode === 0
  }
  const ran = await $.process.run(['sh', '-c', OSC_WRITER, 'terminal-tab-title', attempt.osc], TIMEOUT)

  return ran.exitCode === 0
}

// Resolves the backend that renamed the tab, or why none did.
async function renameTab($: EngineInterface, label: string): Promise<{ backend?: string; reason?: string }> {
  const { attempts, note } = plan(await readEnv($), label)
  const tried: string[] = []
  for (const attempt of attempts) {
    const isDone = await tryAttempt($, attempt, label).catch(() => false)
    if (isDone) return { backend: attempt.backend }
    tried.push(attempt.backend)
  }

  return { reason: note ?? (tried.length > 0 ? `${[...new Set(tried)].join(', ')} refused it` : 'no supported terminal found') }
}

async function nameFromPrompt($: EngineInterface, text: string): Promise<void> {
  const reply = await $.model.complete({ model: 'haiku', system: SYSTEM, prompt: text.slice(0, 4000), maxTokens: 30 })
  const label = reply.isAnswered ? cleanLabel(reply.text) : ''
  if (!label) {
    await update($, isNamed, () => false)
    return
  }

  const result = await renameTab($, label)
  if (!result.backend) {
    // Nothing here to rename; stay quiet and don't ask the model again this session.
    $.ui.log(`Could not rename the tab: ${result.reason}.`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tab-title',
      description: 'Rename this terminal tab (/tab-title <name>), or show how it would be renamed',
    })

    return next(e)
  })

  on('command.run', { command: 'tab-title' }, async ($, e) => {
    const label = cleanLabel(e.args)
    if (!label) {
      const { attempts, note } = plan(await readEnv($), 'Example')
      const backends = [...new Set(attempts.map(one => one.backend))]

      return { text: backends.length > 0 ? `Would rename via ${backends.join(' → ')}.` : `${note ?? 'No supported terminal found'}.` }
    }

    await update($, isNamed, () => true)
    const result = await renameTab($, label)

    return { text: result.backend ? `Tab renamed to “${label}” via ${result.backend}.` : `Could not rename the tab: ${result.reason}.` }
  })

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)

    const text = e.text.trim()
    const isCandidate = isFromPerson(e.origin) && text !== '' && !text.startsWith('/')
    if (!isCandidate || (await read($, isNamed))) return result

    await update($, isNamed, () => true)
    nameFromPrompt($, text).catch(() => update($, isNamed, () => false))

    return result
  }).catch(($, e, next) => next(e))
}
