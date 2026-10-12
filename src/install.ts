// Adds (or removes) the terminal-tab-title hook in each agent's own config file.
// Edits are merges: other hooks and settings are kept, and the old file is saved as <file>.bak.

import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Agent } from './agents'

export const MARKER = 'terminal-tab-title'

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32') return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), MARKER)

  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), MARKER)
}

// The script is copied to a stable place, so hooks keep working after an npx cache or skill folder goes away.
export function installScript(source: string): string {
  const target = join(dataDir(), 'tab-title.mjs')
  mkdirSync(dirname(target), { recursive: true })
  if (source !== target) copyFileSync(source, target)
  chmodSync(target, 0o755)

  return target
}

const quote = (path: string) => `"${path.replace(/"/g, '\\"')}"`

export function hookCommand(script: string, agent: Agent): string {
  return `${quote(process.execPath)} ${quote(script)} hook --agent ${agent}`
}

type Json = Record<string, any>

const isOurs = (hook: unknown) => typeof (hook as Json)?.command === 'string' && (hook as Json).command.includes(MARKER)

function readJson(file: string): Json {
  if (!existsSync(file)) return {}
  const text = readFileSync(file, 'utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text) as Json
  } catch {
    throw new Error(`${file} is not plain JSON (comments?), so it was left alone; add the hook by hand (see README)`)
  }
}

function writeJson(file: string, data: Json): void {
  mkdirSync(dirname(file), { recursive: true })
  if (existsSync(file)) copyFileSync(file, `${file}.bak`)
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
}

// Codex and Gemini CLI nest hooks in groups: { hooks: { Event: [{ hooks: [{ type, command }] }] } }.
function setGrouped(config: Json, event: string, hook: Json | undefined): Json {
  const hooks = (config.hooks ??= {}) as Json
  const groups = ((hooks[event] ?? []) as Json[])
    .map(group => ({ ...group, hooks: ((group.hooks ?? []) as Json[]).filter(one => !isOurs(one)) }))
    .filter(group => group.hooks.length > 0)
  if (hook) groups.push({ hooks: [hook] })
  if (groups.length > 0) hooks[event] = groups
  else delete hooks[event]

  return config
}

// Cursor keeps a flat list per event: { version: 1, hooks: { event: [{ command }] } }.
function setFlat(config: Json, event: string, hook: Json | undefined): Json {
  config.version ??= 1
  const hooks = (config.hooks ??= {}) as Json
  const list = ((hooks[event] ?? []) as Json[]).filter(one => !isOurs(one))
  if (hook) list.push(hook)
  if (list.length > 0) hooks[event] = list
  else delete hooks[event]

  return config
}

export function opencodePlugin(script: string): string {
  return `// Installed by ${MARKER}: names the terminal tab from the first prompt of each opencode run.
// Remove with: npx ${MARKER} uninstall opencode
import { spawn } from 'node:child_process'

const NODE = ${JSON.stringify(process.execPath)}
const SCRIPT = ${JSON.stringify(script)}

export const TerminalTabTitle = async () => {
  let isNamed = false

  return {
    'chat.message': async (input, output) => {
      if (isNamed || process.env.TAB_TITLE_INNER) return
      const prompt = (output?.parts ?? [])
        .filter(part => part.type === 'text' && !part.synthetic)
        .map(part => part.text)
        .join('\\n')
        .trim()
      if (!prompt) return
      isNamed = true
      try {
        const child = spawn(NODE, [SCRIPT, 'hook', '--agent', 'opencode'], { stdio: ['pipe', 'ignore', 'ignore'] })
        child.on('error', () => {})
        child.stdin.on('error', () => {})
        child.stdin.end(JSON.stringify({ session_id: 'opencode-' + process.pid, prompt }))
      } catch {}
    },
  }
}
`
}

export type Paths = { home: string }

export function configFile(agent: Agent, { home }: Paths): string {
  switch (agent) {
    case 'codex':
      return join(process.env.CODEX_HOME || join(home, '.codex'), 'hooks.json')
    case 'cursor':
      return join(home, '.cursor', 'hooks.json')
    case 'gemini':
      return join(home, '.gemini', 'settings.json')
    case 'opencode':
      return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode', 'plugins', `${MARKER}.js`)
    case 'claude':
      return join(home, '.claude', 'settings.json')
  }
}

// Returns what was done, for the person running the installer.
export function install(agent: Agent, script: string, paths: Paths = { home: homedir() }): string {
  const file = configFile(agent, paths)
  const command = hookCommand(script, agent)
  switch (agent) {
    case 'claude':
      return [
        'Claude Code: install the plugin instead of a hook (it names tabs with Haiku and adds /tab-title):',
        `  claude plugin marketplace add mtami/${MARKER}`,
        `  claude plugin install ${MARKER}@${MARKER}`,
      ].join('\n')
    case 'codex':
      writeJson(file, setGrouped(readJson(file), 'UserPromptSubmit', { type: 'command', command }))
      return `Codex: added a UserPromptSubmit hook to ${file}. Run /hooks in Codex once to review and trust it.`
    case 'cursor':
      writeJson(file, setFlat(readJson(file), 'beforeSubmitPrompt', { command, timeout: 10 }))
      return `Cursor: added a beforeSubmitPrompt hook to ${file}. Restart Cursor to load it.`
    case 'gemini':
      writeJson(file, setGrouped(readJson(file), 'BeforeAgent', { type: 'command', command, name: MARKER, timeout: 10000 }))
      return `Gemini CLI: added a BeforeAgent hook to ${file}. Check /hooks in Gemini CLI shows it enabled.`
    case 'opencode':
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, opencodePlugin(script))
      return `opencode: wrote the plugin ${file}. Restart opencode to load it.`
  }
}

export function uninstall(agent: Agent, paths: Paths = { home: homedir() }): string {
  const file = configFile(agent, paths)
  switch (agent) {
    case 'claude':
      return `Claude Code: run  claude plugin uninstall ${MARKER}@${MARKER}`
    case 'codex':
    case 'gemini':
      if (!existsSync(file)) return `${agent}: nothing to remove.`
      writeJson(file, setGrouped(readJson(file), agent === 'codex' ? 'UserPromptSubmit' : 'BeforeAgent', undefined))
      return `${agent}: removed the hook from ${file}.`
    case 'cursor':
      if (!existsSync(file)) return 'cursor: nothing to remove.'
      writeJson(file, setFlat(readJson(file), 'beforeSubmitPrompt', undefined))
      return `cursor: removed the hook from ${file}.`
    case 'opencode':
      if (!existsSync(file)) return 'opencode: nothing to remove.'
      rmSync(file)
      return `opencode: removed ${file}.`
  }
}
