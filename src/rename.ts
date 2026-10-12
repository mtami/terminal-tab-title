// Runs a rename plan from a plain Node process: the same backends as the Claude Code plugin,
// with child_process in place of the plugin's process API.

import { execFileSync, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

import { plan, zellijTabId } from '../hooks/backends'
import type { Attempt, Env } from '../hooks/backends'
import { oscPolicy } from './agents'
import type { Agent } from './agents'

const TIMEOUT_MS = 5000

function run(argv: string[]): { exitCode: number; stdout: string } {
  const ran = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8', timeout: TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] })

  return { exitCode: ran.status ?? 1, stdout: ran.stdout ?? '' }
}

// Hooks often run without a controlling tty, so walk up to the first ancestor that has one
// (the agent itself) and write the sequence to that device. Must run before detaching from the agent.
export function findTty(startPid: number = process.pid): string | undefined {
  if (process.platform === 'win32') return undefined
  let pid = startPid
  for (let depth = 0; depth < 64 && pid > 1; depth += 1) {
    let out: string
    try {
      out = execFileSync('ps', ['-o', 'tty=,ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: TIMEOUT_MS }).trim()
    } catch {
      return undefined
    }
    const [tty, ppid] = out.split(/\s+/)
    if (tty && tty !== '?' && tty !== '??' && tty !== '-') return `/dev/${tty}`
    pid = Number(ppid)
    if (!Number.isInteger(pid)) return undefined
  }

  return undefined
}

function tryAttempt(attempt: Attempt, label: string, tty: () => string | undefined): boolean {
  if ('run' in attempt) return run(attempt.run).exitCode === 0
  if ('zellijPane' in attempt) {
    const listed = run(['zellij', 'action', 'list-panes', '--json', '--tab'])
    // Before 0.44 there is no list-panes and rename-tab only hits the focused tab: leave it alone.
    const tabId = listed.exitCode === 0 ? zellijTabId(listed.stdout, attempt.zellijPane) : undefined
    if (tabId === undefined) return false

    return run(['zellij', 'action', 'rename-tab', '--tab-id', String(tabId), label]).exitCode === 0
  }
  const device = tty()
  if (!device) return false
  writeFileSync(device, attempt.osc)

  return true
}

export function planFor(agent: Agent | undefined, label: string, env: NodeJS.ProcessEnv = process.env) {
  return plan(env as Env, label, oscPolicy(agent, env as Env))
}

// Resolves the backend that renamed the tab, or why none did.
export function renameTab(
  agent: Agent | undefined,
  label: string,
  options: { tty?: string } = {},
): { backend?: string; reason?: string } {
  const { attempts, note } = planFor(agent, label)
  let device = options.tty
  const tty = () => (device ??= findTty())
  const tried: string[] = []
  for (const attempt of attempts) {
    let isDone = false
    try {
      isDone = tryAttempt(attempt, label, tty)
    } catch {
      isDone = false
    }
    if (isDone) return { backend: attempt.backend }
    tried.push(attempt.backend)
  }

  return { reason: note || (tried.length > 0 ? `${[...new Set(tried)].join(', ')} refused it` : 'no supported terminal found') }
}
