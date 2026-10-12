import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { plan } from '../../hooks/backends'
import { hookReply, oscPolicy, parseHookInput } from '../../src/agents'
import { install, opencodePlugin, uninstall } from '../../src/install'
import { heuristicTitle, llmChoice } from '../../src/title'

describe('heuristicTitle', () => {
  test('drops filler and keeps the topic', () => {
    expect(heuristicTitle('can you add a delete button to my exports')).toBe('Add Delete Button Exports')
    expect(heuristicTitle('fix the login bug')).toBe('Fix Login Bug')
    expect(heuristicTitle('Please migrate the CSV parser to Next.js')).toBe('Migrate CSV Parser Next.js')
  })

  test('uses the first non-empty line and survives odd input', () => {
    expect(heuristicTitle('\n\n  refactor auth\nmore detail here')).toBe('Refactor Auth')
    expect(heuristicTitle('???')).toBe('')
    expect(heuristicTitle('see https://example.com/x for the spec')).toBe('See Spec')
  })
})

test('llmChoice prefers an explicit choice, then a command, then API keys', () => {
  expect(llmChoice({})).toBe('off')
  expect(llmChoice({ OPENAI_API_KEY: 'k' })).toBe('openai')
  expect(llmChoice({ OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' })).toBe('anthropic')
  expect(llmChoice({ ANTHROPIC_API_KEY: 'k', TAB_TITLE_COMMAND: 'x' })).toBe('command')
  expect(llmChoice({ ANTHROPIC_API_KEY: 'k', TAB_TITLE_LLM: 'off' })).toBe('off')
})

test('parseHookInput reads every agent’s payload', () => {
  expect(parseHookInput('{"session_id":"s1","prompt":"hi"}')).toEqual({ prompt: 'hi', sessionId: 's1' })
  expect(parseHookInput('{"conversation_id":"c1","prompt":"hi"}')).toEqual({ prompt: 'hi', sessionId: 'c1' })
  expect(parseHookInput('nope')).toEqual({ prompt: '' })
})

test('hookReply is silent where stdout becomes model context', () => {
  expect(hookReply('claude')).toBe('')
  expect(hookReply('codex')).toBe('')
  expect(hookReply('cursor')).toBe('{"continue":true}')
  expect(hookReply('gemini')).toBe('{}')
})

describe('oscPolicy', () => {
  const ghostty = { TERM_PROGRAM: 'ghostty' }

  test('agents that write their own title leave OSC alone', () => {
    expect(plan(ghostty, 'X', oscPolicy('codex', ghostty)).attempts).toEqual([])
    expect(plan(ghostty, 'X', oscPolicy('claude', ghostty)).note).toContain('CLAUDE_CODE_DISABLE_TERMINAL_TITLE')
  })

  test('other agents use OSC, and TAB_TITLE_OSC overrides either way', () => {
    expect(plan(ghostty, 'X', oscPolicy('cursor', ghostty)).attempts).toEqual([{ backend: 'ghostty', osc: '\u001b]0;X\u0007' }])
    const forcedOn = { ...ghostty, TAB_TITLE_OSC: '1' }
    expect(plan(forcedOn, 'X', oscPolicy('codex', forcedOn)).attempts).toHaveLength(1)
    const forcedOff = { ...ghostty, TAB_TITLE_OSC: '0' }
    expect(plan(forcedOff, 'X', oscPolicy('cursor', forcedOff)).attempts).toEqual([])
  })

  test('the default policy is still Claude Code’s', () => {
    expect(plan(ghostty, 'X').attempts).toEqual([])
  })
})

describe('install', () => {
  const home = () => mkdtempSync(join(tmpdir(), 'ttt-home-'))
  const script = '/data/terminal-tab-title/tab-title.mjs'
  delete process.env.CODEX_HOME
  delete process.env.XDG_CONFIG_HOME

  test('codex keeps other hooks, replaces its own, and uninstalls cleanly', () => {
    const dir = home()
    const file = join(dir, '.codex', 'hooks.json')
    install('codex', script, { home: dir })
    const other = { hooks: [{ type: 'command', command: 'echo other' }] }
    const config = JSON.parse(readFileSync(file, 'utf8'))
    config.hooks.UserPromptSubmit.unshift(other)
    writeFileSync(file, JSON.stringify(config))

    install('codex', script, { home: dir })
    const groups = JSON.parse(readFileSync(file, 'utf8')).hooks.UserPromptSubmit
    expect(groups).toHaveLength(2)
    expect(groups[1].hooks[0].command).toContain('hook --agent codex')

    uninstall('codex', { home: dir })
    expect(JSON.parse(readFileSync(file, 'utf8')).hooks.UserPromptSubmit).toEqual([other])
  })

  test('cursor uses a versioned flat list', () => {
    const dir = home()
    install('cursor', script, { home: dir })
    const config = JSON.parse(readFileSync(join(dir, '.cursor', 'hooks.json'), 'utf8'))
    expect(config.version).toBe(1)
    expect(config.hooks.beforeSubmitPrompt[0].command).toContain('hook --agent cursor')
  })

  test('gemini merges into settings.json without touching other settings', () => {
    const dir = home()
    const file = join(dir, '.gemini', 'settings.json')
    install('gemini', script, { home: dir })
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), theme: 'Dracula' }))
    install('gemini', script, { home: dir })
    const settings = JSON.parse(readFileSync(file, 'utf8'))
    expect(settings.theme).toBe('Dracula')
    expect(settings.hooks.BeforeAgent).toHaveLength(1)
  })

  test('refuses to rewrite a file it cannot parse', () => {
    const dir = home()
    const file = join(dir, '.cursor', 'hooks.json')
    install('cursor', script, { home: dir })
    writeFileSync(file, '{ // comment\n}')
    expect(() => install('cursor', script, { home: dir })).toThrow('left alone')
    expect(readFileSync(file, 'utf8')).toBe('{ // comment\n}')
  })

  test('the opencode plugin is valid JavaScript naming the script', async () => {
    const dir = home()
    const file = join(dir, 'plugin.mjs')
    writeFileSync(file, opencodePlugin(script))
    const module = await import(file)
    const hooks = await module.TerminalTabTitle({})
    expect(typeof hooks['chat.message']).toBe('function')
    expect(readFileSync(file, 'utf8')).toContain(JSON.stringify(script))
  })
})
