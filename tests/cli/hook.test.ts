// Runs the built script the way an agent's hook would, against a stub herdr that records its argv.

import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, '../../skills/terminal-tab-title/scripts/tab-title.mjs')

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'ttt-e2e-'))
  const record = join(dir, 'renames')
  const herdr = join(dir, 'herdr')
  writeFileSync(herdr, `#!/bin/sh\necho "$@" >> "${record}"\n`)
  chmodSync(herdr, 0o755)
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    TMPDIR: dir,
    HERDR_TAB_ID: 'w1:t2',
    HERDR_BIN_PATH: herdr,
    TAB_TITLE_LLM: 'off',
  }

  return { record, env }
}

function hook(agent: string, payload: object, env: Record<string, string | undefined>) {
  return spawnSync('node', [SCRIPT, 'hook', '--agent', agent], { input: JSON.stringify(payload), env, encoding: 'utf8' })
}

async function waitFor(file: string): Promise<string> {
  for (let tries = 0; tries < 50 && !existsSync(file); tries += 1) await new Promise(r => setTimeout(r, 50))
  await new Promise(r => setTimeout(r, 100))

  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

test('first prompt of a session renames the tab once, and Cursor gets its reply', async () => {
  const { record, env } = sandbox()
  const first = hook('cursor', { conversation_id: 'c1', prompt: 'fix the flaky login test' }, env)
  expect(first.status).toBe(0)
  expect(first.stdout.trim()).toBe('{"continue":true}')

  hook('cursor', { conversation_id: 'c1', prompt: 'now update the docs' }, env)
  expect(await waitFor(record)).toBe('tab rename w1:t2 Fix Flaky Login Test\n')
})

test('slash commands are skipped and Claude Code / Codex hooks stay silent', async () => {
  const { record, env } = sandbox()
  const skipped = hook('codex', { session_id: 's1', prompt: '/status' }, env)
  expect(skipped.stdout).toBe('')

  const named = hook('codex', { session_id: 's1', prompt: 'add retries to the uploader' }, env)
  expect(named.stdout).toBe('')
  expect(await waitFor(record)).toBe('tab rename w1:t2 Add Retries Uploader\n')
})

test('a hook started by a title command does nothing', async () => {
  const { record, env } = sandbox()
  const inner = hook('gemini', { session_id: 's1', prompt: 'anything' }, { ...env, TAB_TITLE_INNER: '1' })
  expect(inner.stdout.trim()).toBe('{}')
  expect(await waitFor(record)).toBe('')
})

test('set renames straight away and reports the backend', () => {
  const { record, env } = sandbox()
  const ran = spawnSync('node', [SCRIPT, 'set', 'My', 'Task', '--agent', 'codex'], { env, encoding: 'utf8' })
  expect(ran.stdout).toContain('via herdr')
  expect(readFileSync(record, 'utf8')).toBe('tab rename w1:t2 My Task\n')
})
