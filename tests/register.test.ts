import { expect, mock, test } from 'claude-code/testing'

const answer = (text: string) => () =>
  ({ value: { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1 } } }) as never
const exit = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '' } }) as never

test('first typed prompt renames the herdr tab once', async ($, on) => {
  const runs: string[][] = []
  on('prompt.submit', ($, e) => ({ text: e.text }) as never)
  mock.env(on, { HERDR_TAB_ID: 'w1:t9', HERDR_BIN_PATH: '/bin/herdr' })
  on('model.complete', answer('Export History Delete'))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    return exit(0)
  })

  await $.prompt.submit({ text: 'add a delete button to my exports', asUser: true })
  await $.prompt.submit({ text: 'second prompt', asUser: true })
  await new Promise(r => setTimeout(r, 0))

  expect(runs).toEqual([['/bin/herdr', 'tab', 'rename', 'w1:t9', 'Export History Delete']])
})

test('zellij renames the tab its pane is in, found through list-panes', async ($, on) => {
  const runs: string[][] = []
  on('prompt.submit', ($, e) => ({ text: e.text }) as never)
  mock.env(on, { ZELLIJ: '0', ZELLIJ_PANE_ID: '0' })
  on('model.complete', answer('Fix Login Bug'))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    const panes = [{ id: 0, is_plugin: true, tab_id: 0 }, { id: 0, is_plugin: false, tab_id: 3 }]
    return e.argv.includes('list-panes') ? exit(0, JSON.stringify(panes)) : exit(0)
  })

  await $.prompt.submit({ text: 'fix the login bug', asUser: true })
  await new Promise(r => setTimeout(r, 0))

  expect(runs[1]).toEqual(['zellij', 'action', 'rename-tab', '--tab-id', '3', 'Fix Login Bug'])
})

test('kitty without remote control falls through to the OSC title when Claude Code leaves it', async ($, on) => {
  const runs: string[][] = []
  on('prompt.submit', ($, e) => ({ text: e.text }) as never)
  mock.env(on, { KITTY_WINDOW_ID: '1', KITTY_LISTEN_ON: 'unix:@k', CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1', TERM_PROGRAM: 'kitty' })
  on('model.complete', answer('Docs Cleanup'))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    return exit(e.argv[0] === 'sh' ? 0 : 1)
  })

  await $.prompt.submit({ text: 'clean the docs', asUser: true })
  await new Promise(r => setTimeout(r, 0))

  expect(runs.map(argv => argv[0])).toEqual(['kitten', 'kitty', 'sh'])
  expect(runs[2]?.at(-1)).toBe('\u001b]0;Docs Cleanup\u0007')
})

test('slash commands never name the tab', async ($, on) => {
  let calls = 0
  on('prompt.submit', ($, e) => ({ text: e.text }) as never)
  mock.env(on, { HERDR_TAB_ID: 'w1:t9' })
  on('model.complete', () => {
    calls += 1
    return answer('X')()
  })
  on('process.run', () => exit(0))

  await $.prompt.submit({ text: '/clear', asUser: true })

  expect(calls).toBe(0)
})
