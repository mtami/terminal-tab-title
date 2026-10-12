// What differs between coding agents: how a hook hears about the prompt, what it must print back,
// and whether the agent writes its own terminal title (which would overwrite an OSC one).

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { isOn } from '../hooks/backends'
import type { Env, OscPolicy } from '../hooks/backends'

export const AGENTS = ['claude', 'codex', 'cursor', 'gemini', 'opencode'] as const
export type Agent = (typeof AGENTS)[number]

export function isAgent(value: string | undefined): value is Agent {
  return (AGENTS as readonly string[]).includes(value ?? '')
}

export type HookInput = { prompt: string; sessionId?: string }

// Claude Code, Codex, Gemini CLI: { session_id, prompt }. Cursor: { conversation_id, prompt }.
// The opencode plugin this tool installs sends { session_id, prompt } too.
export function parseHookInput(raw: string): HookInput {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { prompt: '' }
  }
  const prompt = typeof data.prompt === 'string' ? data.prompt : ''
  const id = data.session_id ?? data.conversation_id ?? data.sessionId

  return { prompt, sessionId: typeof id === 'string' && id !== '' ? id : undefined }
}

// What the hook prints so the agent carries on unchanged. Claude Code and Codex turn stdout into
// model context, so they get nothing; Cursor and Gemini CLI expect a JSON reply.
export function hookReply(agent: Agent): string {
  if (agent === 'cursor') return '{"continue":true}'
  if (agent === 'gemini') return '{}'

  return ''
}

// Best guess at the agent running a shell command, for `tab-title set` without --agent.
export function detectAgent(env: NodeJS.ProcessEnv): Agent | undefined {
  if (env.CLAUDECODE) return 'claude'
  if (env.CODEX_THREAD_ID || env.CODEX_SANDBOX || env.CODEX_MANAGED_BY_NPM) return 'codex'
  if (env.GEMINI_CLI) return 'gemini'
  if (env.OPENCODE) return 'opencode'
  if (env.CURSOR_AGENT || env.CURSOR_TRACE_ID) return 'cursor'

  return undefined
}

function geminiHidesTitle(): boolean {
  const file = join(homedir(), '.gemini', 'settings.json')
  if (!existsSync(file)) return false
  try {
    const settings = JSON.parse(readFileSync(file, 'utf8')) as { ui?: { hideWindowTitle?: unknown } }
    return settings.ui?.hideWindowTitle === true
  } catch {
    return false
  }
}

// TAB_TITLE_OSC=1 forces the OSC title on, TAB_TITLE_OSC=0 forces it off.
export function oscPolicy(agent: Agent | undefined, env: Env & { TAB_TITLE_OSC?: string }): OscPolicy {
  const forced = env.TAB_TITLE_OSC
  if (forced !== undefined && forced !== '') {
    return { isAllowed: isOn(forced), note: 'TAB_TITLE_OSC is off, and no multiplexer or scriptable terminal was found' }
  }
  if (agent === 'claude') {
    return {
      isAllowed: isOn(env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE),
      note: 'Claude Code already sets this terminal’s title; set CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 to let terminal-tab-title name it instead',
    }
  }
  if (agent === 'codex') {
    return {
      isAllowed: false,
      note: 'Codex already sets this terminal’s title; turn that off with Codex’s /title command and set TAB_TITLE_OSC=1 to let terminal-tab-title name it instead',
    }
  }
  if (agent === 'gemini') {
    return {
      isAllowed: geminiHidesTitle(),
      note: 'Gemini CLI already sets this terminal’s title; set "ui": { "hideWindowTitle": true } in ~/.gemini/settings.json to let terminal-tab-title name it instead',
    }
  }

  return { isAllowed: true, note: '' }
}
