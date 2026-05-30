import { createInterface } from 'node:readline';
import { emitKeypressEvents } from 'node:readline';
import { Transform } from 'node:stream';
import { stdin as input, stdout as output } from 'node:process';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { buildAgentSystemPrompt, buildLimitedAgentResponse } from '../agent/graph.js';
import { handleSlashCommand } from '../commands/slash.js';
import { formatMcpStatus } from '../core/mcp.js';

marked.use(markedTerminal());
// marked-terminal's text renderer extracts token.text (raw string) instead of
// calling parseInline(token.tokens), so inline Markdown inside list items is
// silently dropped. Patch it to call parseInline when tokens are available.
marked.use({
  useNewRenderer: true,
  renderer: {
    text(token) {
      if (typeof token === 'object' && token.tokens) {
        return this.parser.parseInline(token.tokens);
      }
      return token.text ?? String(token);
    },
  },
});

function createSession() {
  return {
    workspace: null,
    workspacePath: null,
    wikirc: null,
    wikircConfig: null,
    language: null,
    mcp: null,
    commands: ['help', 'version', 'exit', 'workspaces', 'use', 'config', 'status'],
    llm: null,
  };
}

function promptFor(session) {
  return session.workspace ? `${session.workspace}> ` : 'donna> ';
}

function slashCompletions(session) {
  return session.commands.map((command) => `/${command}`).sort();
}

function commonPrefix(values) {
  if (values.length === 0) return '';
  let prefix = values[0];
  for (const value of values.slice(1)) {
    while (!value.startsWith(prefix) && prefix) {
      prefix = prefix.slice(0, -1);
    }
  }
  return prefix;
}

function completeSlashCommand(inputBuffer, session) {
  if (!inputBuffer.startsWith('/')) return null;
  const parts = inputBuffer.split(/\s+/);
  if (parts.length > 1 && parts[0] && !inputBuffer.endsWith(' ')) return null;

  const current = parts[0];
  const matches = slashCompletions(session).filter((command) => command.startsWith(current));
  if (matches.length === 0) return { inputBuffer, message: `No command matches ${current}` };
  if (matches.length === 1) return { inputBuffer: `${matches[0]} `, message: null };

  const prefix = commonPrefix(matches);
  return {
    inputBuffer: prefix.length > current.length ? prefix : inputBuffer,
    message: `Commands: ${matches.join('  ')}`,
  };
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function stripHtml(value) {
  return String(value)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?(script|style|iframe|object|embed|svg|math)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?[^>]+>/g, '');
}

function truncateAnsi(value, maxWidth) {
  let visible = 0;
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '\u001b') {
      const match = value.slice(index).match(/^\u001b\[[0-9;]*m/);
      if (match) {
        out += match[0];
        index += match[0].length - 1;
        continue;
      }
    }
    if (visible >= maxWidth) break;
    out += value[index];
    visible += 1;
  }
  return out;
}

const styles = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  magenta: '\u001b[35m',
  dim: '\u001b[2m',
  cyan: '\u001b[36m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
  orange: '\u001b[38;5;208m',
  gray: '\u001b[90m',
  blue: '\u001b[34m',
  inverse: '\u001b[7m',
};

function colorizeStatus(text) {
  return marked(stripHtml(text)).trimEnd()
    .replaceAll('●', `${styles.green}●${styles.reset}`)
    .replaceAll('○', `${styles.gray}○${styles.reset}`)
    .replace(/\b(configured|ready|enabled|reinitialized|loaded)\b/g, `${styles.green}$1${styles.reset}`)
    .replace(/\b(missing|limited|disabled|not loaded|not found)\b/g, `${styles.yellow}$1${styles.reset}`);
}

function formatMcpStatusForPanel(mcpStatus) {
  const entries = Object.entries(mcpStatus ?? {});
  if (entries.length === 0) return [`${styles.red}●${styles.reset} none`];
  return entries.map(([name, value]) => {
    const color =
      value.status === 'connected'
        ? styles.green
        : value.status === 'configured'
          ? styles.orange
          : styles.red;
    return `${color}●${styles.reset} ${name}${value.detail ? ` ${value.detail}` : ''}`;
  });
}

function splitAtVisibleWidth(str, width) {
  let visible = 0;
  let index = 0;
  while (index < str.length && visible < width) {
    if (str[index] === '\u001b') {
      const m = str.slice(index).match(/^\u001b\[[0-9;]*m/);
      if (m) { index += m[0].length; continue; }
    }
    visible += 1;
    index += 1;
  }
  return [str.slice(0, index), str.slice(index)];
}

function wrapLine(line, width) {
  const cleanWidth = Math.max(10, width);
  const out = [];
  let rest = line;
  while (stripAnsi(rest).length > cleanWidth) {
    const [head, tail] = splitAtVisibleWidth(rest, cleanWidth);
    out.push(head);
    rest = tail;
  }
  out.push(rest);
  return out;
}

function wrapText(text, width) {
  return String(text)
    .split('\n')
    .flatMap((line) => wrapLine(line, width));
}

function donnaBanner(columns) {
  const compact = ['Donna'];
  const full = [
    '██████╗  ██████╗ ███╗   ██╗███╗   ██╗ █████╗',
    '██╔══██╗██╔═══██╗████╗  ██║████╗  ██║██╔══██╗',
    '██║  ██║██║   ██║██╔██╗ ██║██╔██╗ ██║███████║',
    '██║  ██║██║   ██║██║╚██╗██║██║╚██╗██║██╔══██║',
    '██████╔╝╚██████╔╝██║ ╚████║██║ ╚████║██║  ██║',
    '╚═════╝  ╚═════╝ ╚═╝  ╚═══╝╚═╝  ╚═══╝╚═╝  ╚═╝',
  ];
  const lines = columns >= 56 ? full : compact;
  return lines.map((line) => line.slice(0, columns));
}

function donnaBannerWithMcp(columns, session) {
  const banner = donnaBanner(columns);
  if (banner.length === 1 || columns < 72) {
    return banner.map((line) => `${styles.bold}${styles.magenta}${line}${styles.reset}`);
  }

  const panelWidth = Math.min(28, Math.max(22, Math.floor(columns * 0.32)));
  const bannerWidth = columns - panelWidth - 3;
  const mcpLines = ['', 'MCP', ...formatMcpStatusForPanel(session.mcp)];
  const lineCount = Math.max(banner.length, mcpLines.length);
  const lines = [];

  for (let index = 0; index < lineCount; index += 1) {
    const leftRaw = (banner[index] ?? '').slice(0, bannerWidth).padEnd(bannerWidth, ' ');
    const left = `${styles.bold}${styles.magenta}${leftRaw}${styles.reset}`;
    const rightRaw = truncateAnsi(mcpLines[index] ?? '', panelWidth);
    const right = `${rightRaw}${' '.repeat(Math.max(0, panelWidth - stripAnsi(rightRaw).length))}`;
    lines.push(`${left}   ${right}`);
  }

  return lines;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function renderScreen({ packageJson, session, messages, inputBuffer, busy = false, spinnerFrame = 0, scrollOffset = 0 }) {
  const columns = output.columns || 100;
  const rows = output.rows || 30;
  const banner = donnaBannerWithMcp(columns, session);
  const bottomPadding = 3;
  const middleHeight = Math.max(5, rows - banner.length - 4 - bottomPadding);
  lastMiddleHeight = middleHeight;
  const prompt = promptFor(session);
  const title = '';
  const context = [
    `wiki-manager ${packageJson.version}`,
    session.workspace ? session.workspace : 'no workspace',
    session.wikirc?.profile ? session.wikirc.profile : 'no wikirc',
    session.language ? session.language : 'no language',
    session.llm ? 'llm ready' : 'llm limited',
  ].join('  ');
  const header = `${title}${' '.repeat(Math.max(0, columns - stripAnsi(title).length - context.length))}${context}`;
  const divider = '─'.repeat(columns);

  const bodyLines = messages.flatMap((message, index) => {
    const label =
      message.role === 'user'
        ? `${styles.cyan}You${styles.reset}`
        : message.role === 'command'
          ? `${styles.gray}Shell${styles.reset}`
          : `${styles.green}Donna${styles.reset}`;
    const content = message.role === 'user' ? message.content : colorizeStatus(message.content);
    const lines = wrapText(`${label}: ${content}`, columns);
    return index === 0 ? lines : ['', ...lines];
  });
  lastBodyLineCount = bodyLines.length;
  const clampedOffset = Math.min(scrollOffset, Math.max(0, bodyLines.length - middleHeight));
  const visibleBody = clampedOffset === 0
    ? bodyLines.slice(-middleHeight)
    : bodyLines.slice(
        Math.max(0, bodyLines.length - middleHeight - clampedOffset),
        bodyLines.length - clampedOffset,
      );
  while (visibleBody.length < middleHeight) visibleBody.unshift('');

  const linesAbove = Math.max(0, bodyLines.length - middleHeight - clampedOffset);
  const hint = linesAbove > 0 ? ` ↑ ${linesAbove} more — scroll or PgUp ` : '';
  const topDivider = hint
    ? `${styles.gray}${hint}${'─'.repeat(Math.max(0, columns - hint.length))}${styles.reset}`
    : divider;

  const spinner = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
  const inputLine = busy
    ? `${styles.cyan}${spinner}${styles.reset} ${styles.dim}Donna is thinking…${styles.reset}`
    : `${prompt}${inputBuffer}`;

  output.write('\u001b[?25l');
  output.write('\u001b[H\u001b[2J');
  output.write(`${header.slice(0, columns).padEnd(columns, ' ')}\n`);
  output.write('\n');
  if (banner.length > 1) {
    output.write(`${banner.map((line) => line.padEnd(columns, ' ')).join('\n')}\n`);
  }
  output.write(`${topDivider}\n`);
  output.write(`${visibleBody.join('\n')}\n`);
  output.write('\n');
  output.write(`${divider}\n`);
  const clippedInputLine = inputLine.slice(0, columns);
  output.write(clippedInputLine);
  output.write('\n');
  output.write('\u001b[1A');
  output.write(`\u001b[${stripAnsi(clippedInputLine).length + 1}G`);
  output.write('\u001b[?25h');
}

async function runLine(line, { agent, packageJson, session, messages, onUpdate }) {
  const trimmed = stripHtml(line).trim();
  if (!trimmed) return { exit: false };

  if (trimmed.startsWith('/')) {
    const result = handleSlashCommand(trimmed, { packageJson, session });
    if (result.output) messages.push({ role: 'command', content: result.output });
    return { exit: Boolean(result.exit) };
  }

  messages.push({ role: 'user', content: trimmed });
  if (session.llm?.stream) {
    const donnaMessage = { role: 'donna', content: '' };
    messages.push(donnaMessage);
    onUpdate?.();
    try {
      for await (const delta of session.llm.stream({
        system: buildAgentSystemPrompt({ input: trimmed, session }),
        input: trimmed,
      })) {
        donnaMessage.content += delta;
        onUpdate?.();
      }
      if (!donnaMessage.content.trim()) {
        donnaMessage.content = buildLimitedAgentResponse(
          { input: trimmed, session },
          'LLM stream ended without content',
        );
      }
      onUpdate?.();
      return { exit: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      donnaMessage.content = buildLimitedAgentResponse(
        { input: trimmed, session },
        `LLM indisponible: ${message}`,
      );
      onUpdate?.();
      return { exit: false };
    }
  }

  const result = await agent.invoke({ input: trimmed, session });
  messages.push({ role: 'donna', content: result.response });
  return { exit: false };
}

async function runPipeShell({ agent, packageJson, session }) {
  const rl = createInterface({ input, output, prompt: promptFor(session) });
  console.log(`Donna  wiki-manager ${packageJson.version}  non-interactive`);
  console.log('─'.repeat(80));
  console.log('Agent-first shell active. Type /help for commands, /exit to quit.');
  rl.prompt();

  try {
    for await (const rawLine of rl) {
      const messages = [];
      const result = await runLine(rawLine, { agent, packageJson, session, messages });
      for (const message of messages) console.log(message.content);
      if (result.exit) break;
      rl.setPrompt(promptFor(session));
      rl.prompt();
    }
  } finally {
    rl.close();
  }
}

let lastBodyLineCount = 0;
let lastMiddleHeight = 5;

async function runTuiShell({ agent, packageJson, session }) {
  const messages = [
    {
      role: 'donna',
      content: 'Orchestrator agent ready. Commands start with /. Chat stays at the bottom.',
    },
  ];
  let inputBuffer = '';
  const inputHistory = [];
  let historyIndex = null;
  let busy = false;
  let spinnerFrame = 0;
  let spinnerInterval = null;
  let scrollOffset = 0;
  let done = false;
  let processing = Promise.resolve();
  let finish;
  const finished = new Promise((resolve) => {
    finish = resolve;
  });

  input.setRawMode(true);
  input.resume();
  output.write('\u001b[?1049h');
  output.write('\u001b[?1000h\u001b[?1006h');

  const rerender = () => renderScreen({ packageJson, session, messages, inputBuffer, busy, spinnerFrame, scrollOffset });

  const mouseFilter = new Transform({
    transform(chunk, _enc, cb) {
      const str = chunk.toString('utf8');
      const filtered = str.replace(/\u001b\[<(\d+);\d+;\d+[Mm]/g, (_, btnStr) => {
        const btn = parseInt(btnStr, 10);
        if (btn === 64) {
          scrollOffset = Math.min(scrollOffset + 3, Math.max(0, lastBodyLineCount - lastMiddleHeight));
          setImmediate(rerender);
        } else if (btn === 65) {
          scrollOffset = Math.max(0, scrollOffset - 3);
          setImmediate(rerender);
        }
        return '';
      });
      if (filtered.length > 0) cb(null, Buffer.from(filtered, 'utf8'));
      else cb();
    },
  });
  input.pipe(mouseFilter);
  emitKeypressEvents(mouseFilter);

  const onResize = () => rerender();
  output.on('resize', onResize);
  rerender();

  const handleKeypress = async (str, key) => {
    if (done) return;


    if (key?.ctrl && key.name === 'c') {
      done = true;
      finish();
      return;
    }
    if (key?.name === 'return' || str === '\n' || str === '\r') {
      const line = inputBuffer;
      inputBuffer = '';
      if (line.trim()) {
        inputHistory.push(line);
      }
      historyIndex = null;
      scrollOffset = 0;
      busy = true;
      spinnerFrame = 0;
      spinnerInterval = setInterval(() => {
        spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
        rerender();
      }, 80);
      rerender();
      const result = await runLine(line, { agent, packageJson, session, messages, onUpdate: rerender });
      clearInterval(spinnerInterval);
      spinnerInterval = null;
      busy = false;
      scrollOffset = 0;
      done = result.exit;
      rerender();
      if (done) finish();
      return;
    }
    if (key?.name === 'up') {
      if (inputHistory.length > 0) {
        historyIndex = historyIndex === null ? inputHistory.length - 1 : Math.max(0, historyIndex - 1);
        inputBuffer = inputHistory[historyIndex] ?? '';
        rerender();
      }
      return;
    }
    if (key?.name === 'down') {
      if (historyIndex !== null) {
        historyIndex += 1;
        if (historyIndex >= inputHistory.length) {
          historyIndex = null;
          inputBuffer = '';
        } else {
          inputBuffer = inputHistory[historyIndex] ?? '';
        }
        rerender();
      }
      return;
    }
    if (key?.name === 'backspace') {
      inputBuffer = inputBuffer.slice(0, -1);
      historyIndex = null;
      rerender();
      return;
    }
    if (key?.name === 'tab') {
      const completion = completeSlashCommand(inputBuffer, session);
      if (completion) {
        inputBuffer = completion.inputBuffer;
        historyIndex = null;
        if (completion.message) messages.push({ role: 'command', content: completion.message });
        rerender();
      }
      return;
    }
    if (key?.name === 'escape') {
      inputBuffer = '';
      historyIndex = null;
      rerender();
      return;
    }
    if (key?.name === 'pageup') {
      scrollOffset = Math.min(
        scrollOffset + Math.max(1, lastMiddleHeight - 2),
        Math.max(0, lastBodyLineCount - lastMiddleHeight),
      );
      rerender();
      return;
    }
    if (key?.name === 'pagedown') {
      scrollOffset = Math.max(0, scrollOffset - Math.max(1, lastMiddleHeight - 2));
      rerender();
      return;
    }
    if (str && !key?.ctrl && !key?.meta) {
      inputBuffer += str;
      historyIndex = null;
      rerender();
    }
  };

  const onKeypress = (str, key) => {
    processing = processing.then(() => handleKeypress(str, key));
  };

  mouseFilter.on('keypress', onKeypress);

  try {
    await finished;
    await processing;
  } finally {
    mouseFilter.off('keypress', onKeypress);
    output.off('resize', onResize);
    input.unpipe(mouseFilter);
    mouseFilter.destroy();
    input.setRawMode(false);
    input.pause();
    output.write('\u001b[?1000l\u001b[?1006l');
    output.write('\u001b[?25h\u001b[H\u001b[2J\u001b[?1049l');
  }
}

export async function runShell({ agent, packageJson }) {
  const session = createSession();
  if (!input.isTTY || !output.isTTY) {
    await runPipeShell({ agent, packageJson, session });
    return;
  }
  await runTuiShell({ agent, packageJson, session });
}
