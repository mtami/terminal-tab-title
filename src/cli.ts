// tab-title: names the terminal tab a coding agent runs in.
// Hook flow: the agent's prompt hook pipes JSON in, this claims the session, hands the slow part
// (model call + rename) to a detached child, and returns at once so the prompt is never held up.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, mkdirSync, openSync, rmSync, statSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { cleanLabel } from '../hooks/backends'
import { AGENTS, detectAgent, hookReply, isAgent, parseHookInput } from './agents'
import type { Agent } from './agents'
import { install, installScript, uninstall } from './install'
import { findTty, planFor, renameTab } from './rename'
import { makeTitle } from './title'

export const VERSION = '0.3.0'

const HELP = `tab-title ${VERSION}: name the terminal tab your coding agent runs in

Usage:
  tab-title set <name> [--agent <agent>]   Rename this tab now
  tab-title detect [--agent <agent>]       Show how this tab would be renamed
  tab-title install <agent...|all>         Name tabs automatically from each session's first prompt
  tab-title uninstall <agent...|all>       Remove those hooks
  tab-title hook --agent <agent>           (called by the agent's prompt hook, JSON on stdin)

Agents: ${AGENTS.join(', ')}

Titles come from a keyword heuristic, or a cheap model when TAB_TITLE_LLM / ANTHROPIC_API_KEY /
OPENAI_API_KEY / TAB_TITLE_COMMAND is set. TAB_TITLE_LLM=off keeps prompts on this machine.`

function stateDir(): string {
  let user = 'user'
  try {
    user = String(userInfo().uid >= 0 ? userInfo().uid : userInfo().username)
  } catch {}
  const dir = join(tmpdir(), `terminal-tab-title-${user}`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })

  return dir
}

function log(line: string): void {
  try {
    const file = join(stateDir(), 'log')
    try {
      if (statSync(file).size > 100_000) rmSync(file)
    } catch {}
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

// Only the first prompt of a session names the tab: the session's state file is created exclusively.
function claimSession(agent: Agent, sessionId: string): string | undefined {
  const key = createHash('sha256').update(`${agent}:${sessionId}`).digest('hex').slice(0, 24)
  const file = join(stateDir(), key)
  try {
    closeSync(openSync(file, 'wx'))
    return file
  } catch {
    return undefined
  }
}

function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('')

  return new Promise(resolve => {
    let data = ''
    const done = () => resolve(data)
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => (data += chunk))
    process.stdin.on('end', done)
    process.stdin.on('error', done)
    setTimeout(done, 2000).unref()
  })
}

type Args = { positional: string[]; agent?: string; tty?: string; state?: string }

function parseArgs(argv: string[]): Args {
  const args: Args = { positional: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--agent' || arg === '--tty' || arg === '--state') {
      args[arg.slice(2) as 'agent' | 'tty' | 'state'] = argv[++index]
    } else if (arg.startsWith('--agent=')) {
      args.agent = arg.slice('--agent='.length)
    } else {
      args.positional.push(arg)
    }
  }

  return args
}

function agentFrom(args: Args): Agent | undefined {
  if (args.agent !== undefined && !isAgent(args.agent)) throw new Error(`unknown agent "${args.agent}" (use ${AGENTS.join(', ')})`)

  return isAgent(args.agent) ? args.agent : detectAgent(process.env)
}

async function hook(args: Args): Promise<void> {
  const agent = agentFrom(args) ?? 'claude'
  try {
    await claimAndName(agent)
  } finally {
    const reply = hookReply(agent)
    if (reply) process.stdout.write(`${reply}\n`)
  }
}

async function claimAndName(agent: Agent): Promise<void> {
  // A model CLI started by TAB_TITLE_COMMAND runs its own hooks; it must not rename the tab again.
  if (process.env.TAB_TITLE_INNER) return

  const { prompt, sessionId } = parseHookInput(await readStdin())
  const text = prompt.trim()
  if (text === '' || text.startsWith('/')) return

  const state = claimSession(agent, sessionId ?? `pid-${process.ppid}`)
  if (!state) return

  // The OSC path finds the terminal by walking up to the agent, so look it up while still its child.
  const needsTty = planFor(agent, 'x').attempts.some(attempt => 'osc' in attempt)
  const tty = needsTty ? findTty() : undefined

  const childArgs = [process.argv[1]!, '_name', '--agent', agent, '--state', state, ...(tty ? ['--tty', tty] : [])]
  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, TAB_TITLE_PROMPT: text.slice(0, 4000) },
  })
  child.on('error', () => rmSync(state, { force: true }))
  child.unref()
}

async function nameInBackground(args: Args): Promise<void> {
  const agent = agentFrom(args)
  const prompt = process.env.TAB_TITLE_PROMPT ?? ''
  const { title, source } = await makeTitle(prompt, process.env)
  if (!title) {
    // Let the next prompt try again.
    if (args.state) rmSync(args.state, { force: true })
    log(`${agent}: no title from "${prompt.slice(0, 60)}"`)
    return
  }
  const result = renameTab(agent, title, { tty: args.tty })
  log(`${agent}: "${title}" (${source}) → ${result.backend ?? `not renamed: ${result.reason}`}`)
}

function set(args: Args): number {
  const label = cleanLabel(args.positional.slice(1).join(' '))
  if (!label) {
    console.error('Usage: tab-title set <name>')
    return 2
  }
  const result = renameTab(agentFrom(args), label)
  if (result.backend) {
    console.log(`Tab renamed to “${label}” via ${result.backend}.`)
    return 0
  }
  console.error(`Could not rename the tab: ${result.reason}.`)

  return 1
}

function detect(args: Args): number {
  const agent = agentFrom(args)
  const { attempts, note } = planFor(agent, 'Example')
  const backends = [...new Set(attempts.map(one => one.backend))]
  console.log(`Agent: ${agent ?? 'unknown (pass --agent)'}`)
  console.log(backends.length > 0 ? `Would rename via ${backends.join(' → ')}.` : `${note || 'No supported terminal found'}.`)
  console.log(`Log: ${join(stateDir(), 'log')}`)

  return 0
}

function agentsFrom(names: string[]): Agent[] {
  if (names.length === 0) throw new Error(`name the agents: ${AGENTS.join(', ')}, or all`)
  if (names.includes('all')) return [...AGENTS]
  for (const name of names) if (!isAgent(name)) throw new Error(`unknown agent "${name}" (use ${AGENTS.join(', ')}, or all)`)

  return names as Agent[]
}

function runInstall(args: Args, isRemoving: boolean): number {
  const agents = agentsFrom(args.positional.slice(1))
  const script = isRemoving ? '' : installScript(fileURLToPath(import.meta.url))
  let code = 0
  for (const agent of agents) {
    try {
      console.log(isRemoving ? uninstall(agent) : install(agent, script))
    } catch (error) {
      console.error(`${agent}: ${(error as Error).message}`)
      code = 1
    }
  }
  if (!isRemoving) console.log(`\nInstalled ${script}. Check a tab with: tab-title detect --agent <agent>`)

  return code
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  const command = args.positional[0]
  switch (command) {
    case 'hook':
      await hook(args)
      return 0
    case '_name':
      await nameInBackground(args)
      return 0
    case 'set':
      return set(args)
    case 'detect':
      return detect(args)
    case 'install':
      return runInstall(args, false)
    case 'uninstall':
      return runInstall(args, true)
    case '--version':
    case '-v':
      console.log(VERSION)
      return 0
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP)
      return 0
    default:
      console.error(`Unknown command "${command}".\n\n${HELP}`)
      return 2
  }
}

main(process.argv.slice(2)).then(
  code => {
    process.exitCode = code
  },
  error => {
    // A hook must never break the agent: report and exit cleanly.
    if (process.argv[2] === 'hook' || process.argv[2] === '_name') {
      log(`error: ${(error as Error).message}`)
      process.exitCode = 0
      return
    }
    console.error(`tab-title: ${(error as Error).message}`)
    process.exitCode = 1
  },
)
