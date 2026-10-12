#!/usr/bin/env node

// src/cli.ts
import { spawn as spawn2 } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync as mkdirSync2, openSync, rmSync as rmSync2, statSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join as join3 } from "node:path";
import { fileURLToPath } from "node:url";

// hooks/backends.ts
var ESC = "\x1B";
var BEL = "\x07";
function cleanLabel(raw) {
  return (raw.split(`
`)[0] ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/["'`*_#%]/g, "").replace(/[.:;!?]+$/, "").trim().slice(0, 32).trim();
}
function oscSequence(code, label) {
  return `${ESC}]${code};${label}${BEL}`;
}
function oscCodeFor(env) {
  if (env.TERM_PROGRAM === "iTerm.app" || env.TERM_PROGRAM === "Apple_Terminal")
    return 1;
  if (env.KONSOLE_DBUS_SESSION)
    return 30;
  return 0;
}
function oscName(env) {
  if (env.WT_SESSION)
    return "windows-terminal";
  if (env.TERM_PROGRAM)
    return env.TERM_PROGRAM.toLowerCase();
  return "osc";
}
function isOn(value) {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}
var CLAUDE_OSC = (env) => ({
  isAllowed: isOn(env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE),
  note: "Claude Code already sets this terminal’s title; set CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 to let this plugin name it instead"
});
function plan(env, label, osc = CLAUDE_OSC(env)) {
  if (env.HERDR_TAB_ID) {
    return { attempts: [{ backend: "herdr", run: [env.HERDR_BIN_PATH || "herdr", "tab", "rename", env.HERDR_TAB_ID, label] }] };
  }
  if (env.TMUX && env.TMUX_PANE) {
    return { attempts: [{ backend: "tmux", run: ["tmux", "rename-window", "-t", env.TMUX_PANE, label] }] };
  }
  if (env.ZELLIJ !== undefined && env.ZELLIJ_PANE_ID && /^\d+$/.test(env.ZELLIJ_PANE_ID)) {
    return { attempts: [{ backend: "zellij", zellijPane: Number(env.ZELLIJ_PANE_ID) }] };
  }
  if (env.STY) {
    return { attempts: [{ backend: "screen", run: ["screen", "-S", env.STY, "-p", env.WINDOW || "0", "-X", "title", label] }] };
  }
  const attempts = [];
  if (env.WEZTERM_PANE) {
    const wezterm = env.WSL_DISTRO_NAME ? "wezterm.exe" : "wezterm";
    attempts.push({ backend: "wezterm", run: [wezterm, "cli", "set-tab-title", "--pane-id", env.WEZTERM_PANE, label] });
  }
  if (env.KITTY_WINDOW_ID && env.KITTY_LISTEN_ON) {
    const match = `window_id:${env.KITTY_WINDOW_ID}`;
    attempts.push({ backend: "kitty", run: ["kitten", "@", "--to", env.KITTY_LISTEN_ON, "set-tab-title", "--match", match, label] });
    attempts.push({ backend: "kitty", run: ["kitty", "@", "--to", env.KITTY_LISTEN_ON, "set-tab-title", "--match", match, label] });
  }
  if (env.KONSOLE_DBUS_SERVICE && env.KONSOLE_DBUS_SESSION) {
    for (const qdbus of ["qdbus6", "qdbus"]) {
      const target = [qdbus, env.KONSOLE_DBUS_SERVICE, env.KONSOLE_DBUS_SESSION, "org.kde.konsole.Session.setTabTitleFormat"];
      attempts.push({ backend: "konsole", run: [...target, "0", label] });
    }
  }
  if (env.ConEmuPID) {
    attempts.push({ backend: "conemu", run: ["ConEmuC", "-GuiMacro", "Rename", "0", label] });
  }
  if (osc.isAllowed) {
    attempts.push({ backend: oscName(env), osc: oscSequence(oscCodeFor(env), label) });
    return { attempts };
  }
  return { attempts, note: attempts.length > 0 ? undefined : osc.note };
}
function zellijTabId(listJson, paneId) {
  let panes;
  try {
    panes = JSON.parse(listJson);
  } catch {
    return;
  }
  if (!Array.isArray(panes))
    return;
  const pane = panes.find((one) => one.id === paneId && one.is_plugin === false);
  return typeof pane?.tab_id === "number" ? pane.tab_id : undefined;
}
var OSC_WRITER = [
  "p=$PPID",
  'while [ -n "$p" ] && [ "$p" -gt 1 ]; do',
  '  t=$(ps -o tty= -p "$p" 2>/dev/null | tr -d " ")',
  '  case "$t" in',
  '    ""|"?"|"??") p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d " ") ;;',
  '    *) printf "%s" "$1" > "/dev/$t"; exit $? ;;',
  "  esac",
  "done",
  "exit 3"
].join(`
`);

// src/agents.ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
var AGENTS = ["claude", "codex", "cursor", "gemini", "opencode"];
function isAgent(value) {
  return AGENTS.includes(value ?? "");
}
function parseHookInput(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { prompt: "" };
  }
  const prompt = typeof data.prompt === "string" ? data.prompt : "";
  const id = data.session_id ?? data.conversation_id ?? data.sessionId;
  return { prompt, sessionId: typeof id === "string" && id !== "" ? id : undefined };
}
function hookReply(agent) {
  if (agent === "cursor")
    return '{"continue":true}';
  if (agent === "gemini")
    return "{}";
  return "";
}
function detectAgent(env) {
  if (env.CLAUDECODE)
    return "claude";
  if (env.CODEX_THREAD_ID || env.CODEX_SANDBOX || env.CODEX_MANAGED_BY_NPM)
    return "codex";
  if (env.GEMINI_CLI)
    return "gemini";
  if (env.OPENCODE)
    return "opencode";
  if (env.CURSOR_AGENT || env.CURSOR_TRACE_ID)
    return "cursor";
  return;
}
function geminiHidesTitle() {
  const file = join(homedir(), ".gemini", "settings.json");
  if (!existsSync(file))
    return false;
  try {
    const settings = JSON.parse(readFileSync(file, "utf8"));
    return settings.ui?.hideWindowTitle === true;
  } catch {
    return false;
  }
}
function oscPolicy(agent, env) {
  const forced = env.TAB_TITLE_OSC;
  if (forced !== undefined && forced !== "") {
    return { isAllowed: isOn(forced), note: "TAB_TITLE_OSC is off, and no multiplexer or scriptable terminal was found" };
  }
  if (agent === "claude") {
    return {
      isAllowed: isOn(env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE),
      note: "Claude Code already sets this terminal’s title; set CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 to let terminal-tab-title name it instead"
    };
  }
  if (agent === "codex") {
    return {
      isAllowed: false,
      note: "Codex already sets this terminal’s title; turn that off with Codex’s /title command and set TAB_TITLE_OSC=1 to let terminal-tab-title name it instead"
    };
  }
  if (agent === "gemini") {
    return {
      isAllowed: geminiHidesTitle(),
      note: 'Gemini CLI already sets this terminal’s title; set "ui": { "hideWindowTitle": true } in ~/.gemini/settings.json to let terminal-tab-title name it instead'
    };
  }
  return { isAllowed: true, note: "" };
}

// src/install.ts
import { copyFileSync, chmodSync, existsSync as existsSync2, mkdirSync, readFileSync as readFileSync2, rmSync, writeFileSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname, join as join2 } from "node:path";
var MARKER = "terminal-tab-title";
function dataDir(env = process.env) {
  if (process.platform === "win32")
    return join2(env.LOCALAPPDATA || join2(homedir2(), "AppData", "Local"), MARKER);
  return join2(env.XDG_DATA_HOME || join2(homedir2(), ".local", "share"), MARKER);
}
function installScript(source) {
  const target = join2(dataDir(), "tab-title.mjs");
  mkdirSync(dirname(target), { recursive: true });
  if (source !== target)
    copyFileSync(source, target);
  chmodSync(target, 493);
  return target;
}
var quote = (path) => `"${path.replace(/"/g, "\\\"")}"`;
function hookCommand(script, agent) {
  return `${quote(process.execPath)} ${quote(script)} hook --agent ${agent}`;
}
var isOurs = (hook) => typeof hook?.command === "string" && hook.command.includes(MARKER);
function readJson(file) {
  if (!existsSync2(file))
    return {};
  const text = readFileSync2(file, "utf8");
  if (text.trim() === "")
    return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${file} is not plain JSON (comments?), so it was left alone; add the hook by hand (see README)`);
  }
}
function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync2(file))
    copyFileSync(file, `${file}.bak`);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}
`);
}
function setGrouped(config, event, hook) {
  const hooks = config.hooks ??= {};
  const groups = (hooks[event] ?? []).map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((one) => !isOurs(one)) })).filter((group) => group.hooks.length > 0);
  if (hook)
    groups.push({ hooks: [hook] });
  if (groups.length > 0)
    hooks[event] = groups;
  else
    delete hooks[event];
  return config;
}
function setFlat(config, event, hook) {
  config.version ??= 1;
  const hooks = config.hooks ??= {};
  const list = (hooks[event] ?? []).filter((one) => !isOurs(one));
  if (hook)
    list.push(hook);
  if (list.length > 0)
    hooks[event] = list;
  else
    delete hooks[event];
  return config;
}
function opencodePlugin(script) {
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
`;
}
function configFile(agent, { home }) {
  switch (agent) {
    case "codex":
      return join2(process.env.CODEX_HOME || join2(home, ".codex"), "hooks.json");
    case "cursor":
      return join2(home, ".cursor", "hooks.json");
    case "gemini":
      return join2(home, ".gemini", "settings.json");
    case "opencode":
      return join2(process.env.XDG_CONFIG_HOME || join2(home, ".config"), "opencode", "plugins", `${MARKER}.js`);
    case "claude":
      return join2(home, ".claude", "settings.json");
  }
}
function install(agent, script, paths = { home: homedir2() }) {
  const file = configFile(agent, paths);
  const command = hookCommand(script, agent);
  switch (agent) {
    case "claude":
      return [
        "Claude Code: install the plugin instead of a hook (it names tabs with Haiku and adds /tab-title):",
        `  claude plugin marketplace add mtami/${MARKER}`,
        `  claude plugin install ${MARKER}@${MARKER}`
      ].join(`
`);
    case "codex":
      writeJson(file, setGrouped(readJson(file), "UserPromptSubmit", { type: "command", command }));
      return `Codex: added a UserPromptSubmit hook to ${file}. Run /hooks in Codex once to review and trust it.`;
    case "cursor":
      writeJson(file, setFlat(readJson(file), "beforeSubmitPrompt", { command, timeout: 10 }));
      return `Cursor: added a beforeSubmitPrompt hook to ${file}. Restart Cursor to load it.`;
    case "gemini":
      writeJson(file, setGrouped(readJson(file), "BeforeAgent", { type: "command", command, name: MARKER, timeout: 1e4 }));
      return `Gemini CLI: added a BeforeAgent hook to ${file}. Check /hooks in Gemini CLI shows it enabled.`;
    case "opencode":
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, opencodePlugin(script));
      return `opencode: wrote the plugin ${file}. Restart opencode to load it.`;
  }
}
function uninstall(agent, paths = { home: homedir2() }) {
  const file = configFile(agent, paths);
  switch (agent) {
    case "claude":
      return `Claude Code: run  claude plugin uninstall ${MARKER}@${MARKER}`;
    case "codex":
    case "gemini":
      if (!existsSync2(file))
        return `${agent}: nothing to remove.`;
      writeJson(file, setGrouped(readJson(file), agent === "codex" ? "UserPromptSubmit" : "BeforeAgent", undefined));
      return `${agent}: removed the hook from ${file}.`;
    case "cursor":
      if (!existsSync2(file))
        return "cursor: nothing to remove.";
      writeJson(file, setFlat(readJson(file), "beforeSubmitPrompt", undefined));
      return `cursor: removed the hook from ${file}.`;
    case "opencode":
      if (!existsSync2(file))
        return "opencode: nothing to remove.";
      rmSync(file);
      return `opencode: removed ${file}.`;
  }
}

// src/rename.ts
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync as writeFileSync2 } from "node:fs";
var TIMEOUT_MS = 5000;
function run(argv) {
  const ran = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
  return { exitCode: ran.status ?? 1, stdout: ran.stdout ?? "" };
}
function findTty(startPid = process.pid) {
  if (process.platform === "win32")
    return;
  let pid = startPid;
  for (let depth = 0;depth < 64 && pid > 1; depth += 1) {
    let out;
    try {
      out = execFileSync("ps", ["-o", "tty=,ppid=", "-p", String(pid)], { encoding: "utf8", timeout: TIMEOUT_MS }).trim();
    } catch {
      return;
    }
    const [tty, ppid] = out.split(/\s+/);
    if (tty && tty !== "?" && tty !== "??" && tty !== "-")
      return `/dev/${tty}`;
    pid = Number(ppid);
    if (!Number.isInteger(pid))
      return;
  }
  return;
}
function tryAttempt(attempt, label, tty) {
  if ("run" in attempt)
    return run(attempt.run).exitCode === 0;
  if ("zellijPane" in attempt) {
    const listed = run(["zellij", "action", "list-panes", "--json", "--tab"]);
    const tabId = listed.exitCode === 0 ? zellijTabId(listed.stdout, attempt.zellijPane) : undefined;
    if (tabId === undefined)
      return false;
    return run(["zellij", "action", "rename-tab", "--tab-id", String(tabId), label]).exitCode === 0;
  }
  const device = tty();
  if (!device)
    return false;
  writeFileSync2(device, attempt.osc);
  return true;
}
function planFor(agent, label, env = process.env) {
  return plan(env, label, oscPolicy(agent, env));
}
function renameTab(agent, label, options = {}) {
  const { attempts, note } = planFor(agent, label);
  let device = options.tty;
  const tty = () => device ??= findTty();
  const tried = [];
  for (const attempt of attempts) {
    let isDone = false;
    try {
      isDone = tryAttempt(attempt, label, tty);
    } catch {
      isDone = false;
    }
    if (isDone)
      return { backend: attempt.backend };
    tried.push(attempt.backend);
  }
  return { reason: note || (tried.length > 0 ? `${[...new Set(tried)].join(", ")} refused it` : "no supported terminal found") };
}

// src/title.ts
import { spawn } from "node:child_process";
var SYSTEM = "You name terminal tabs. Reply with a 2-4 word title (Title Case, no quotes, " + "no trailing punctuation) summarising the task in the user message. Reply with the title only.";
var LLM_TIMEOUT_MS = 15000;
var FILLER = new Set(("a an the and or but so to of in on at by for from into onto with without about as is are was were be been " + "am do does did done can could would should will shall may might must please pls kindly hey hi hello ok okay " + "thanks thank you your yours i im me my mine we us our ours it its this that these those there here then now " + "just also some any all very really maybe let lets want wanna need needs like help try trying going gonna " + "make sure what why how when where which who whom whose if else not no yes up out over again still too " + "currently basically actually quickly something anything everything thing things stuff").split(" "));
var MAX_WORDS = 4;
function titleCase(word) {
  if (word !== word.toLowerCase())
    return word;
  return word[0].toUpperCase() + word.slice(1);
}
function heuristicTitle(prompt) {
  const firstLine = prompt.split(`
`).find((line) => line.trim() !== "") ?? "";
  const words = firstLine.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, " ").match(/[\p{L}\p{N}][\p{L}\p{N}+#._\/-]*/gu) ?? [];
  const picked = [];
  for (const raw of words) {
    const word = raw.replace(/[._\/-]+$/, "");
    const bare = word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    if (bare === "" || FILLER.has(bare))
      continue;
    picked.push(titleCase(word));
    if (picked.length === MAX_WORDS)
      break;
  }
  return cleanLabel(picked.join(" "));
}
function llmChoice(env) {
  const chosen = env.TAB_TITLE_LLM?.toLowerCase();
  if (chosen === "off" || chosen === "anthropic" || chosen === "openai" || chosen === "command")
    return chosen;
  if (env.TAB_TITLE_COMMAND)
    return "command";
  if (env.ANTHROPIC_API_KEY)
    return "anthropic";
  if (env.OPENAI_API_KEY)
    return "openai";
  return "off";
}
async function askAnthropic(env, prompt) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: env.TAB_TITLE_MODEL || "claude-haiku-5-5",
      max_tokens: 30,
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }]
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS)
  });
  if (!response.ok)
    throw new Error(`Anthropic API ${response.status}`);
  const body = await response.json();
  return body.content?.find((block) => block.type === "text")?.text ?? "";
}
async function askOpenAi(env, prompt) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY ?? ""}` },
    body: JSON.stringify({
      model: env.TAB_TITLE_MODEL || "gpt-5-nano",
      reasoning_effort: "minimal",
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: prompt }
      ]
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS)
  });
  if (!response.ok)
    throw new Error(`OpenAI API ${response.status}`);
  const body = await response.json();
  return body.choices?.[0]?.message?.content ?? "";
}
function askCommand(env, prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", env.TAB_TITLE_COMMAND ?? ""], {
      env: { ...process.env, TAB_TITLE_INNER: "1" },
      stdio: ["pipe", "pipe", "ignore"],
      timeout: LLM_TIMEOUT_MS
    });
    let out = "";
    child.stdout.on("data", (chunk) => out += chunk);
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(`title command exited ${code}`)));
    child.stdin.end(`${SYSTEM}

User message:
${prompt}
`);
  });
}
async function makeTitle(prompt, env) {
  const text = prompt.slice(0, 4000);
  const choice = llmChoice(env);
  if (choice !== "off") {
    const ask = choice === "anthropic" ? askAnthropic : choice === "openai" ? askOpenAi : askCommand;
    const title = cleanLabel(await ask(env, text).catch(() => ""));
    if (title)
      return { title, source: choice };
  }
  return { title: heuristicTitle(text), source: "heuristic" };
}

// src/cli.ts
var VERSION = "0.3.0";
var HELP = `tab-title ${VERSION}: name the terminal tab your coding agent runs in

Usage:
  tab-title set <name> [--agent <agent>]   Rename this tab now
  tab-title detect [--agent <agent>]       Show how this tab would be renamed
  tab-title install <agent...|all>         Name tabs automatically from each session's first prompt
  tab-title uninstall <agent...|all>       Remove those hooks
  tab-title hook --agent <agent>           (called by the agent's prompt hook, JSON on stdin)

Agents: ${AGENTS.join(", ")}

Titles come from a keyword heuristic, or a cheap model when TAB_TITLE_LLM / ANTHROPIC_API_KEY /
OPENAI_API_KEY / TAB_TITLE_COMMAND is set. TAB_TITLE_LLM=off keeps prompts on this machine.`;
function stateDir() {
  let user = "user";
  try {
    user = String(userInfo().uid >= 0 ? userInfo().uid : userInfo().username);
  } catch {}
  const dir = join3(tmpdir(), `terminal-tab-title-${user}`);
  mkdirSync2(dir, { recursive: true, mode: 448 });
  return dir;
}
function log(line) {
  try {
    const file = join3(stateDir(), "log");
    try {
      if (statSync(file).size > 1e5)
        rmSync2(file);
    } catch {}
    appendFileSync(file, `${new Date().toISOString()} ${line}
`);
  } catch {}
}
function claimSession(agent, sessionId) {
  const key = createHash("sha256").update(`${agent}:${sessionId}`).digest("hex").slice(0, 24);
  const file = join3(stateDir(), key);
  try {
    closeSync(openSync(file, "wx"));
    return file;
  } catch {
    return;
  }
}
function readStdin() {
  if (process.stdin.isTTY)
    return Promise.resolve("");
  return new Promise((resolve) => {
    let data = "";
    const done = () => resolve(data);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", done);
    process.stdin.on("error", done);
    setTimeout(done, 2000).unref();
  });
}
function parseArgs(argv) {
  const args = { positional: [] };
  for (let index = 0;index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--agent" || arg === "--tty" || arg === "--state") {
      args[arg.slice(2)] = argv[++index];
    } else if (arg.startsWith("--agent=")) {
      args.agent = arg.slice("--agent=".length);
    } else {
      args.positional.push(arg);
    }
  }
  return args;
}
function agentFrom(args) {
  if (args.agent !== undefined && !isAgent(args.agent))
    throw new Error(`unknown agent "${args.agent}" (use ${AGENTS.join(", ")})`);
  return isAgent(args.agent) ? args.agent : detectAgent(process.env);
}
async function hook(args) {
  const agent = agentFrom(args) ?? "claude";
  try {
    await claimAndName(agent);
  } finally {
    const reply = hookReply(agent);
    if (reply)
      process.stdout.write(`${reply}
`);
  }
}
async function claimAndName(agent) {
  if (process.env.TAB_TITLE_INNER)
    return;
  const { prompt, sessionId } = parseHookInput(await readStdin());
  const text = prompt.trim();
  if (text === "" || text.startsWith("/"))
    return;
  const state = claimSession(agent, sessionId ?? `pid-${process.ppid}`);
  if (!state)
    return;
  const needsTty = planFor(agent, "x").attempts.some((attempt) => ("osc" in attempt));
  const tty = needsTty ? findTty() : undefined;
  const childArgs = [process.argv[1], "_name", "--agent", agent, "--state", state, ...tty ? ["--tty", tty] : []];
  const child = spawn2(process.execPath, childArgs, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, TAB_TITLE_PROMPT: text.slice(0, 4000) }
  });
  child.on("error", () => rmSync2(state, { force: true }));
  child.unref();
}
async function nameInBackground(args) {
  const agent = agentFrom(args);
  const prompt = process.env.TAB_TITLE_PROMPT ?? "";
  const { title, source } = await makeTitle(prompt, process.env);
  if (!title) {
    if (args.state)
      rmSync2(args.state, { force: true });
    log(`${agent}: no title from "${prompt.slice(0, 60)}"`);
    return;
  }
  const result = renameTab(agent, title, { tty: args.tty });
  log(`${agent}: "${title}" (${source}) → ${result.backend ?? `not renamed: ${result.reason}`}`);
}
function set(args) {
  const label = cleanLabel(args.positional.slice(1).join(" "));
  if (!label) {
    console.error("Usage: tab-title set <name>");
    return 2;
  }
  const result = renameTab(agentFrom(args), label);
  if (result.backend) {
    console.log(`Tab renamed to “${label}” via ${result.backend}.`);
    return 0;
  }
  console.error(`Could not rename the tab: ${result.reason}.`);
  return 1;
}
function detect(args) {
  const agent = agentFrom(args);
  const { attempts, note } = planFor(agent, "Example");
  const backends = [...new Set(attempts.map((one) => one.backend))];
  console.log(`Agent: ${agent ?? "unknown (pass --agent)"}`);
  console.log(backends.length > 0 ? `Would rename via ${backends.join(" → ")}.` : `${note || "No supported terminal found"}.`);
  console.log(`Log: ${join3(stateDir(), "log")}`);
  return 0;
}
function agentsFrom(names) {
  if (names.length === 0)
    throw new Error(`name the agents: ${AGENTS.join(", ")}, or all`);
  if (names.includes("all"))
    return [...AGENTS];
  for (const name of names)
    if (!isAgent(name))
      throw new Error(`unknown agent "${name}" (use ${AGENTS.join(", ")}, or all)`);
  return names;
}
function runInstall(args, isRemoving) {
  const agents = agentsFrom(args.positional.slice(1));
  const script = isRemoving ? "" : installScript(fileURLToPath(import.meta.url));
  let code = 0;
  for (const agent of agents) {
    try {
      console.log(isRemoving ? uninstall(agent) : install(agent, script));
    } catch (error) {
      console.error(`${agent}: ${error.message}`);
      code = 1;
    }
  }
  if (!isRemoving)
    console.log(`
Installed ${script}. Check a tab with: tab-title detect --agent <agent>`);
  return code;
}
async function main(argv) {
  const args = parseArgs(argv);
  const command = args.positional[0];
  switch (command) {
    case "hook":
      await hook(args);
      return 0;
    case "_name":
      await nameInBackground(args);
      return 0;
    case "set":
      return set(args);
    case "detect":
      return detect(args);
    case "install":
      return runInstall(args, false);
    case "uninstall":
      return runInstall(args, true);
    case "--version":
    case "-v":
      console.log(VERSION);
      return 0;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    default:
      console.error(`Unknown command "${command}".

${HELP}`);
      return 2;
  }
}
main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}, (error) => {
  if (process.argv[2] === "hook" || process.argv[2] === "_name") {
    log(`error: ${error.message}`);
    process.exitCode = 0;
    return;
  }
  console.error(`tab-title: ${error.message}`);
  process.exitCode = 1;
});
export {
  VERSION
};
