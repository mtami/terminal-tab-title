// Turns a first prompt into a 2-4 word tab title: a cheap model when one is configured,
// otherwise a keyword heuristic that needs no network.

import { spawn } from 'node:child_process'

import { cleanLabel } from '../hooks/backends'

export const SYSTEM =
  'You name terminal tabs. Reply with a 2-4 word title (Title Case, no quotes, ' +
  'no trailing punctuation) summarising the task in the user message. Reply with the title only.'

const LLM_TIMEOUT_MS = 15000

// Words that carry no topic: politeness, pronouns, articles and glue.
const FILLER = new Set(
  (
    'a an the and or but so to of in on at by for from into onto with without about as is are was were be been ' +
    'am do does did done can could would should will shall may might must please pls kindly hey hi hello ok okay ' +
    'thanks thank you your yours i im me my mine we us our ours it its this that these those there here then now ' +
    'just also some any all very really maybe let lets want wanna need needs like help try trying going gonna ' +
    'make sure what why how when where which who whom whose if else not no yes up out over again still too ' +
    'currently basically actually quickly something anything everything thing things stuff'
  ).split(' '),
)

const MAX_WORDS = 4

function titleCase(word: string): string {
  // Keep words that already carry deliberate casing or symbols: CSV, iOS, Next.js, OAuth2.
  if (word !== word.toLowerCase()) return word

  return word[0]!.toUpperCase() + word.slice(1)
}

export function heuristicTitle(prompt: string): string {
  const firstLine = prompt.split('\n').find(line => line.trim() !== '') ?? ''
  const words = firstLine.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}+#._\/-]*/gu) ?? []
  const picked: string[] = []
  for (const raw of words) {
    const word = raw.replace(/[._\/-]+$/, '')
    const bare = word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
    if (bare === '' || FILLER.has(bare)) continue
    picked.push(titleCase(word))
    if (picked.length === MAX_WORDS) break
  }

  return cleanLabel(picked.join(' '))
}

export type LlmChoice = 'off' | 'anthropic' | 'openai' | 'command'

type TitleEnv = {
  TAB_TITLE_LLM?: string
  TAB_TITLE_COMMAND?: string
  TAB_TITLE_MODEL?: string
  ANTHROPIC_API_KEY?: string
  OPENAI_API_KEY?: string
}

export function llmChoice(env: TitleEnv): LlmChoice {
  const chosen = env.TAB_TITLE_LLM?.toLowerCase()
  if (chosen === 'off' || chosen === 'anthropic' || chosen === 'openai' || chosen === 'command') return chosen
  if (env.TAB_TITLE_COMMAND) return 'command'
  if (env.ANTHROPIC_API_KEY) return 'anthropic'
  if (env.OPENAI_API_KEY) return 'openai'

  return 'off'
}

async function askAnthropic(env: TitleEnv, prompt: string): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY ?? '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: env.TAB_TITLE_MODEL || 'claude-haiku-5-5',
      max_tokens: 30,
      system: SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Anthropic API ${response.status}`)
  const body = (await response.json()) as { content?: { type: string; text?: string }[] }

  return body.content?.find(block => block.type === 'text')?.text ?? ''
}

async function askOpenAi(env: TitleEnv, prompt: string): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY ?? ''}` },
    body: JSON.stringify({
      model: env.TAB_TITLE_MODEL || 'gpt-5-nano',
      reasoning_effort: 'minimal',
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`OpenAI API ${response.status}`)
  const body = (await response.json()) as { choices?: { message?: { content?: string } }[] }

  return body.choices?.[0]?.message?.content ?? ''
}

// A user-supplied command (e.g. `claude -p --model haiku`) gets the instructions and prompt on stdin.
// TAB_TITLE_INNER stops that command's own agent hooks from naming the tab again.
function askCommand(env: TitleEnv, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', env.TAB_TITLE_COMMAND ?? ''], {
      env: { ...process.env, TAB_TITLE_INNER: '1' },
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: LLM_TIMEOUT_MS,
    })
    let out = ''
    child.stdout.on('data', chunk => (out += chunk))
    child.on('error', reject)
    child.on('close', code => (code === 0 ? resolve(out) : reject(new Error(`title command exited ${code}`))))
    child.stdin.end(`${SYSTEM}\n\nUser message:\n${prompt}\n`)
  })
}

export async function makeTitle(prompt: string, env: TitleEnv): Promise<{ title: string; source: string }> {
  const text = prompt.slice(0, 4000)
  const choice = llmChoice(env)
  if (choice !== 'off') {
    const ask = choice === 'anthropic' ? askAnthropic : choice === 'openai' ? askOpenAi : askCommand
    const title = cleanLabel(await ask(env, text).catch(() => ''))
    if (title) return { title, source: choice }
  }

  return { title: heuristicTitle(text), source: 'heuristic' }
}
