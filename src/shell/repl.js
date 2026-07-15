import { createInterface } from 'node:readline';
import { emitKeypressEvents } from 'node:readline';
import { Transform } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { stdin as input, stdout as output } from 'node:process';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { buildAgentSystemPrompt, formatLlmUnavailableMessage, isDonnaReadTool } from '../agent/graph.js';
import { handleSlashCommand } from '../commands/slash.js';
import { serviceDescription, serviceNames as composeServiceNames } from '../core/compose.js';
import { extractActivity, parseJsonText, sessionActivities } from '../core/activity.js';
import { syncActivitiesToPlan } from '../core/plan.js';
import { buildLlmTools, callMcpTool, formatMcpToolResult, parseToolCallName, resolveToolCallName } from '../core/mcp.js';
import { runBoundedToolLoop } from '../core/toolLoop.js';
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { listSkills } from '../core/skills.js';
import { listWikircProfiles } from '../core/wikirc.js';
import { listWorkspaces } from '../core/workspaces.js';
import { fetchRuntimeState, postRuntimeApprove, postRuntimeCancel, postRuntimeControl, postRuntimeRun, postRuntimeShutdown, streamRuntimeEvents } from '../runtime/client.js';
import { versionWithBuild } from '../core/buildInfo.js';

// Code blocks: marked-terminal's default paints a dense background block
// glued to the surrounding text. Indent the content, keep a plain style and
// guarantee a blank line before/after so fenced blocks breathe in the chat.
const CODE_INDENT = '  ';
const CODE_TINT = '\u001b[38;5;152m'; // soft blue-grey, readable on dark bg
const CODE_RESET = '\u001b[0m';
marked.use(markedTerminal({
  code: (code) => `\n${String(code).split('\n').map((line) => `${CODE_INDENT}${CODE_TINT}${line}${CODE_RESET}`).join('\n')}\n`,
}));
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
    table(token) {
      const cols = output.columns || 100;
      const numCols = token.header.length || 1;
      const colWidth = Math.max(6, Math.floor((cols - 1 - numCols * 3) / numCols));
      const parseCell = (cell) => {
        if (!cell) return '';
        if (cell.tokens) return stripAnsi(this.parser.parseInline(cell.tokens)).replace(/\s+/g, ' ').trim();
        return String(cell.text ?? cell ?? '').trim();
      };
      return renderTerminalTable(token, parseCell, colWidth);
    },
  },
});

const GLOBAL_CONVERSATION_KEY = '__global__';
const LEGACY_DONNA_ROLE = 'do' + 't';
const LOWER_DETAIL_ROWS = 8;
const COMPLETION_PANEL_ROWS = 5;
const LOWER_PANEL_SEPARATOR_ROWS = 1;
const LOWER_PANEL_ROWS = LOWER_PANEL_SEPARATOR_ROWS + LOWER_DETAIL_ROWS;
const BOTTOM_PADDING_ROWS = 3;
const MOUSE_SELECTION_RESUME_MS = 5000;
const COMMAND_COMPLETION_DESCRIPTIONS = {
  '/help': 'Show shell commands.',
  '/version': 'Print the wiki-manager version.',
  '/exit': 'Exit the shell.',
  '/workspace': 'List, create, or delete workspaces.',
  '/new': 'Open the setup wizard in the interactive TUI.',
  '/use': 'Load a workspace and its default config.',
  '/config': 'Inspect or switch .wikirc.yaml profiles.',
  '/status': 'Show the current workspace and session state.',
  '/services': 'List workspace Docker Compose services.',
  '/start': 'Start one service or the workspace service set.',
  '/stop': 'Stop one service or the workspace service set.',
  '/logs': 'Show recent logs for a service.',
  '/mcp': 'Inspect or call workspace MCP servers.',
  '/wiki': 'Run llm-wiki commands for the active workspace.',
  '/skills': 'List workspace skills.',
  '/upload': 'Upload a document — /upload <path>',
  '/uploads': 'List or clean uploaded documents.',
  '/clear': 'Clear the conversation screen.',
  '/chat': 'Switch free text to direct LLM chat without tools.',
  '/agent': 'Switch free text to the LangGraph agent with tools.',
  '/openui': 'Open the workspace web UI in the browser.',
  '/run': 'Inspect, cancel, kill runtime runs, or start a capability run.',
  '/approve': 'Approve a pending runtime run or tool.',
};

const SUBCOMMAND_COMPLETION_DESCRIPTIONS = {
  '/config:list': 'List .wikirc.yaml profiles.',
  '/config:status': 'Show the active wikirc profile.',
  '/config:use': 'Reload session config from a profile.',
  '/config:edit': 'Edit one .wikirc.yaml profile.',
  '/mcp:call': 'Call one MCP tool with optional JSON.',
  '/mcp:endpoints': 'Show MCP URLs and token presence.',
  '/mcp:status': 'Show MCP connection status.',
  '/mcp:tools': 'Show discovered MCP tools.',
  '/upload:convert': 'Convert one stored upload or all pending uploads.',
  '/uploads:clean': 'Clean old stored document uploads.',
  '/uploads:list': 'List uploaded documents.',
  '/run:status': 'Show runtime run status.',
  '/run:cancel': 'Cancel the active runtime run.',
  '/run:kill': 'Hard-kill runtime run(s).',
  '/queue': 'Inspect or cancel queued MCP jobs.',
  '/queue:cancel': 'Cancel a queued or running queue item.',
  '/queue:clear': 'Clear finished queue items.',
  '/workspace:init': 'Low-level workspace creation.',
  '/workspace:list': 'List configured workspaces.',
  '/workspace:delete': 'Delete one workspace after confirmation.',
  '/wiki:run': 'Use the low-level llm-wiki CLI fallback.',
  '/skills:edit': 'Edit one workspace skill file.',
  '/skills:list': 'List workspace skills.',
  '/skills:run': 'Prepare one skill for guided execution.',
  '/skills:show': 'Show one workspace skill.',
};

export function runtimeUnavailableReason(runtime) {
  if (runtime?.url) return null;
  const reason = runtime?.error ?? runtime?.unavailableReason ?? runtime?.reason ?? null;
  return reason ? String(reason) : 'runtime introuvable';
}

export function runtimeUnavailableAgentMessage(runtime) {
  const reason = runtimeUnavailableReason(runtime);
  return reason ? `⚠ Runtime indisponible : ${reason} — /agent désactivé, /chat reste possible` : null;
}

export function runtimeStatusLine(runtime, session) {
  if (runtime?.url) return `runtime: connected (${session?.workspace ?? 'no workspace'})`;
  const reason = runtimeUnavailableReason(runtime);
  if (reason) return `runtime: disconnected: ${reason}`;
  return 'runtime: off';
}

export function recordRuntimeUnavailableAgentInput(session, line, runtime) {
  const message = runtimeUnavailableAgentMessage(runtime);
  conversationMessages(session).push({ role: 'user', content: line });
  conversationMessages(session).push({ role: 'command', content: message ?? 'Runtime indisponible.' });
  return message;
}

export function createSession() {
  return {
    workspace: null,
    workspacePath: null,
    workspaceEnvFile: null,
    wikirc: null,
    wikircConfig: null,
    language: null,
    mcp: null,
    commands: ['help', 'version', 'exit', 'workspace', 'new', 'use', 'config', 'status', 'services', 'start', 'stop', 'logs', 'mcp', 'wiki', 'skills', 'upload', 'uploads', 'clear', 'chat', 'agent', 'openui', 'run', 'cancel', 'queue', 'approve'],
    chatMode: true,
    llm: null,
    activities: {},
    jobQueue: [],
    productionActivity: null,
    headlessPlan: null,
    conversations: { [GLOBAL_CONVERSATION_KEY]: [] },
  };
}

export function conversationKey(session) {
  return session.workspace || GLOBAL_CONVERSATION_KEY;
}

export function conversationMessages(session) {
  const key = conversationKey(session);
  session.conversations ??= { [GLOBAL_CONVERSATION_KEY]: [] };
  session.conversations[key] ??= [];
  return session.conversations[key];
}

function initialLegacyWelcomeMessage() {
  return [
    'Orchestrator agent ready.',
    '',
    'Load a workspace with `/use <workspace>`, then chat or use commands.',
    'Type `/help` for all commands.',
  ].join('\n');
}

export function promptFor(session) {
  return session.workspace ? `${session.workspace}> ` : 'donna > ';
}

function slashCompletions(session) {
  return session.commands.map((command) => `/${command}`).sort();
}

function tokenCompletions(inputBuffer, values) {
  const lastSpace = inputBuffer.lastIndexOf(' ');
  const prefix = inputBuffer.slice(lastSpace + 1);
  const base = inputBuffer.slice(0, lastSpace + 1);
  const matches = values.filter((value) => value.startsWith(prefix));
  if (matches.length === 0) return { inputBuffer };
  if (matches.length === 1) return { inputBuffer: `${base}${matches[0]} ` };
  const shared = commonPrefix(matches);
  if (shared.length > prefix.length) return { inputBuffer: `${base}${shared}` };
  // Completing an argument (base contains a space): select the first match.
  // Completing the command itself (no space yet): leave unchanged so the user can keep typing.
  if (lastSpace >= 0) return { inputBuffer: `${base}${matches[0]} ` };
  return { inputBuffer };
}

function mcpNames(session) {
  return Object.entries(session.mcp ?? {})
    .filter(([, value]) => value.status === 'connected' || value.status === 'configured')
    .map(([name]) => name)
    .sort();
}

function mcpToolNames(session, serverName) {
  return (session.mcp?.[serverName]?.tools ?? [])
    .map((tool) => tool.name)
    .sort();
}

function workspaceNames() {
  return listWorkspaces().map((workspace) => workspace.name).sort();
}

function wikircProfileNames(session) {
  return session.workspacePath
    ? listWikircProfiles(session.workspacePath).map((profile) => profile.name).sort()
    : [];
}

function serviceNames() {
  return composeServiceNames();
}

function skillNames(session) {
  return listSkills(session).map((skill) => skill.name).sort();
}

function completionValuesFor(parts, inputBuffer, session) {
  const command = parts[0];
  const completingNewToken = inputBuffer.endsWith(' ');
  const tokenIndex = completingNewToken ? parts.length : parts.length - 1;
  const previousToken = completingNewToken ? parts.at(-1) : parts.at(-2);

  if (tokenIndex === 0) return slashCompletions(session);
  if (command === '/new' && tokenIndex === 1) return [];
  if (command === '/use' && tokenIndex === 1) return workspaceNames();
  if (command === '/use' && tokenIndex === 2) return [];
  if (command === '/config' && tokenIndex === 1) return ['edit', 'list', 'status', 'use'];
  if (command === '/config' && (previousToken === 'use' || previousToken === 'edit')) return wikircProfileNames(session);
  if (command === '/mcp' && tokenIndex === 1) return ['call', 'endpoints', 'status', 'tools'];
  if (command === '/mcp' && previousToken === 'tools') return mcpNames(session);
  if (command === '/mcp' && previousToken === 'call') return mcpNames(session);
  if (command === '/mcp' && parts[1] === 'call' && tokenIndex === 3) return mcpToolNames(session, parts[2]);
  if (command === '/upload' && tokenIndex === 1) return ['convert'];
  if (command === '/upload' && parts[1] === 'convert' && tokenIndex === 2) return ['pending'];
  if (command === '/uploads' && tokenIndex === 1) return ['clean', 'list'];
  if (command === '/uploads' && previousToken === 'clean') return ['--older-than'];
  if (command === '/run' && tokenIndex === 1) return ['status', 'cancel', 'kill', 'capability'];
  if (command === '/queue' && tokenIndex === 1) return ['cancel', 'clear'];
  if (command === '/queue' && previousToken === 'cancel') {
    return (session.jobQueue ?? [])
      .filter((item) => ['waiting', 'starting', 'running'].includes(item.status))
      .map((item) => item.id);
  }
  if (command === '/workspace') {
    if (tokenIndex === 1) return ['delete', 'init', 'list'];
    if (previousToken === 'delete') return workspaceNames();
    if (parts[1] === 'delete' && tokenIndex === 3) return ['--confirm'];
  }
  if (command === '/wiki' && tokenIndex === 1) return ['run'];
  if (command === '/skills' && tokenIndex === 1) return ['edit', 'list', 'run', 'show'];
  if (command === '/skills' && ['edit', 'run', 'show'].includes(previousToken ?? '')) return skillNames(session);
  if ((command === '/start' || command === '/stop') && tokenIndex === 1) return ['agents', ...serviceNames()];
  if (command === '/logs' && tokenIndex === 1) return serviceNames();
  return [];
}

function toConversationHistory(replMessages, maxExchanges = 6) {
  return replMessages
    .filter((m) => m.role === 'user' || isDonnaRole(m.role))
    .slice(-(maxExchanges * 2))
    .map((m) => ({ role: isDonnaRole(m.role) ? 'assistant' : 'user', content: m.content }));
}

function isDonnaRole(role) {
  return role === 'donna' || role === LEGACY_DONNA_ROLE;
}

// Read-only MCP tools exposed to /chat. The operator declares which tools per
// server in the `chatAccess` config (mcp.endpoints.json). /chat is extended to
// those tools ONLY, filtered through the same read-only test Donna's /agent
// mode uses (isDonnaReadTool), and only when their server is connected — so
// /chat can answer live state questions ("le CME est-il configuré ?") but can
// never mutate or delegate. Actions still belong to /agent, which has all tools.
export function chatReadTools(session) {
  const servers = session?.chatAccess?.servers;
  if (!servers) return [];
  const scopedMcp = Object.fromEntries(
    Object.entries(session.mcp ?? {}).filter(([name]) => Object.hasOwn(servers, name)),
  );
  return buildLlmTools(scopedMcp).filter((item) => {
    const { server, tool } = parseToolCallName(item.function.name);
    const entry = servers[server];
    const declared = entry.allow === '*' ? true : (Array.isArray(entry.allow) && entry.allow.includes(tool));
    return declared && isDonnaReadTool(item);
  });
}

function buildDirectChatSystemPrompt(session) {
  const workspace = session.workspace ?? 'no workspace selected';
  const wikirc = session.wikirc?.profile ?? 'no profile loaded';
  const language = session.language ?? 'en-US';
  return [
    'You are Donna, the llm-wiki-manager chat assistant: warm, plain-spoken, and helpful — like an attentive colleague, never a raw status dump.',
    'You have a small READ-ONLY toolset — the tools provided to you for this turn, which may be none. Use them to answer questions about live state (e.g. "le CME est-il configuré", "quelles pages sont en attente"), and answer only from their results.',
    'If no provided tool covers the request — or the request is an action or mutation (ingest, build, export, configure, send, delete…), or needs a service that is not connected — say plainly you cannot do it in chat mode and to switch to agent mode (/agent). Do not pretend to execute it and never guess.',
    'Answer directly and concisely. Do not claim to have called tools or changed files beyond the tools actually provided.',
    'Chat mode is READ-ONLY, so never offer to perform an action yourself here — do NOT say "want me to start the ingestion?", because you cannot. That offer belongs to agent mode. When a natural next step is an action, you may warmly hand off instead, in one short line (in the reply language): e.g. "If you want to run the ingestion, switch to agent mode with /agent." Point the way; never promise to do it.',
    'Never add a "Next steps", "Prochaines étapes", "À suivre", options, or suggestions section unless the user explicitly asks what to do next. End after answering the question.',
    'Never invent a tool name, command, job id, status, or result (e.g. do not fabricate names like "check_cme_configuration"). If you cannot know something with the tools you were given, say so.',
    `Reply language: ${language}.`,
    `Current workspace: ${workspace}.`,
    `Current wikirc profile: ${wikirc}.`,
  ].join('\n');
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
  const parts = inputBuffer.trimEnd().split(/\s+/).filter(Boolean);
  const values = completionValuesFor(parts, inputBuffer, session);
  if (values.length === 0) return null;
  return tokenCompletions(inputBuffer, values);
}

export function completionContext(inputBuffer, session) {
  if (!inputBuffer.startsWith('/')) return null;
  const parts = inputBuffer.trimEnd().split(/\s+/).filter(Boolean);
  const values = completionValuesFor(parts, inputBuffer, session);
  if (values.length === 0) return null;
  const lastSpace = inputBuffer.lastIndexOf(' ');
  const prefix = inputBuffer.endsWith(' ') ? '' : inputBuffer.slice(lastSpace + 1);
  const matches = values.filter((value) => value.startsWith(prefix));
  if (matches.length === 0) return null;
  return { parts, matches, prefix };
}

export function completionDescription(value, parts) {
  if (value.startsWith('/')) return COMMAND_COMPLETION_DESCRIPTIONS[value] ?? 'Run this shell command.';
  const command = parts[0];
  const subcommand = SUBCOMMAND_COMPLETION_DESCRIPTIONS[`${command}:${value}`];
  if (subcommand) return subcommand;
  if (command === '/use') return 'Load this workspace.';
  if (command === '/start') return serviceDescription(value) ?? 'Start this Docker Compose service.';
  if (command === '/stop') return serviceDescription(value) ?? 'Stop this Docker Compose service.';
  if (command === '/logs') return serviceDescription(value) ?? 'Show logs for this Docker Compose service.';
  if (command === '/workspace') {
    if (parts[1] === 'delete' && value === '--confirm') return 'Confirm workspace deletion.';
    if (parts.at(-1) === 'delete') return 'Delete this workspace.';
    return 'Choose a workspace action.';
  }
  if (command === '/mcp') return parts[1] === 'call' ? 'Use this MCP server.' : 'Filter tools to this MCP server.';
  if (command === '/skills') {
    if (parts.at(-1) === 'edit') return 'Edit this skill.';
    if (parts.at(-1) === 'run') return 'Run this skill guide.';
    if (parts.at(-1) === 'show') return 'Show this skill.';
    return 'Choose a skills action.';
  }
  if (command === '/config') {
    if (parts.at(-1) === 'use') return 'Load this wikirc profile.';
    if (parts.at(-1) === 'edit') return 'Edit this wikirc profile.';
    return 'Choose a config action.';
  }
  return 'Complete this argument.';
}

function completionLines(inputBuffer, session, columns) {
  const context = completionContext(inputBuffer, session);
  if (!context) return [];
  if (context.matches.length === 0) {
    return [`${styles.dim}No completions for ${context.prefix || 'current input'}.${styles.reset}`];
  }

  const items = context.matches.slice(0, 10).map((value) => ({
    value,
    description: completionDescription(value, context.parts),
  }));
  const oneColumn = columns < 96 || items.length <= 3;
  const itemWidth = oneColumn ? columns : Math.floor((columns - 3) / 2);
  const renderItem = (item) => {
    const valueWidth = Math.min(18, Math.max(10, Math.floor(itemWidth * 0.34)));
    const value = `${styles.cyan}${truncateAnsi(item.value, valueWidth)}${styles.reset}`;
    const descWidth = Math.max(8, itemWidth - valueWidth - 2);
    const desc = `${styles.dim}${truncateAnsi(item.description, descWidth)}${styles.reset}`;
    return `${padVisible(value, valueWidth)} ${desc}`;
  };

  const rendered = items.map(renderItem);
  if (oneColumn) return rendered;

  const lines = [];
  for (let index = 0; index < rendered.length; index += 2) {
    const left = rendered[index];
    const right = rendered[index + 1] ?? '';
    lines.push(`${left}${' '.repeat(Math.max(3, itemWidth - stripAnsi(left).length + 3))}${right}`);
  }
  return lines;
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function wrapCellText(text, width) {
  const lines = [];
  for (const para of text.split('\n')) {
    if (!para) { lines.push(''); continue; }
    let line = '';
    for (const word of para.split(' ')) {
      if (!word) continue;
      if (line.length + (line ? 1 : 0) + word.length <= width) {
        line += (line ? ' ' : '') + word;
      } else if (word.length >= width) {
        if (line) { lines.push(line); line = ''; }
        for (let i = 0; i < word.length; i += width) {
          const chunk = word.slice(i, i + width);
          if (i + width >= word.length) line = chunk;
          else lines.push(chunk);
        }
      } else {
        if (line) lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines.length ? lines : [''];
}

function renderTerminalTable(token, parseCell, colWidth) {
  const numCols = token.header.length || 1;
  const border = (l, m, r) =>
    `${styles.gray}${l}${Array.from({ length: numCols }, () => '─'.repeat(colWidth + 2)).join(m)}${r}${styles.reset}`;
  const sep = `${styles.gray}│${styles.reset}`;
  const drawRow = (cells, bold) => {
    const wrapped = cells.map((c) => wrapCellText(parseCell(c), colWidth));
    const height = Math.max(...wrapped.map((c) => c.length));
    return Array.from({ length: height }, (_, i) =>
      `${sep}${wrapped.map((c) => {
        const txt = (c[i] ?? '').padEnd(colWidth, ' ');
        return bold ? ` [1m${txt}[0m ` : ` ${txt} `;
      }).join(sep)}${sep}`,
    );
  };
  const rows = [border('┌', '┬', '┐'), ...drawRow(token.header, true), border('├', '┼', '┤')];
  for (const row of token.rows) rows.push(...drawRow(row, false));
  rows.push(border('└', '┴', '┘'));
  return rows.join('\n') + '\n\n';
}

function stripHtml(value) {
  return String(value)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?(script|style|iframe|object|embed|svg|math)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?[^>]+>/g, '');
}

function stripDsmlArtifacts(value) {
  return String(value ?? '')
    .replace(/<\s*[|｜]{2}\s*DSML\s*[|｜]{2}[^>\r\n]*(?:>|$)/gi, '')
    .replace(/^[^\S\r\n]*.*[|｜]{2}\s*DSML\s*[|｜]{2}.*(?:\r?\n|$)/gim, '')
    .replace(/\n{3,}/g, '\n\n');
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
  white: '\u001b[37m',
  inverse: '\u001b[7m',
};

export function colorizeStatus(text) {
  return marked(stripHtml(text)).trimEnd()
    .split('\n')
    .map((line) => {
      if (line.startsWith('●') && /\bconnected\b/.test(line)) return `${styles.green}●${styles.reset}${line.slice(1)}`;
      if (line.startsWith('◐') && /\bconfigured\b/.test(line)) return `${styles.orange}◐${styles.reset}${line.slice(1)}`;
      if (line.startsWith('○') && /\bmissing\b/.test(line)) return `${styles.red}○${styles.reset}${line.slice(1)}`;
      if (line.startsWith('○')) return `${styles.gray}○${styles.reset}${line.slice(1)}`;
      return line;
    })
    .join('\n')
    .replace(/\b(configured|ready|enabled|reinitialized|loaded)\b/g, `${styles.green}$1${styles.reset}`)
    .replace(/\b(missing|limited|disabled|not loaded|not found)\b/g, `${styles.yellow}$1${styles.reset}`);
}

function visibleLength(value) {
  return stripAnsi(String(value)).length;
}

function padVisible(value, width) {
  const text = String(value);
  return `${text}${' '.repeat(Math.max(0, width - visibleLength(text)))}`;
}

function splitTabularBlocks(lines) {
  const blocks = [];
  let current = [];
  let tabular = null;
  for (const line of lines) {
    const isTabular = line.includes('\t');
    if (tabular === null || tabular === isTabular) {
      current.push(line);
      tabular = isTabular;
      continue;
    }
    blocks.push({ tabular, lines: current });
    current = [line];
    tabular = isTabular;
  }
  if (current.length > 0) blocks.push({ tabular, lines: current });
  return blocks;
}

function renderPlainTable(lines, maxWidth) {
  const rows = lines.map((line) => line.split('\t').map((cell) => cell.trim()));
  const columnCount = Math.max(...rows.map((row) => row.length), 1);
  const normalized = rows.map((row) => Array.from({ length: columnCount }, (_, i) => row[i] ?? ''));
  const available = Math.max(24, maxWidth - columnCount - 1);
  const natural = Array.from({ length: columnCount }, (_, i) =>
    Math.max(3, ...normalized.map((row) => visibleLength(row[i]))),
  );
  const totalNatural = natural.reduce((sum, width) => sum + width, 0) + columnCount * 2;
  const widths = totalNatural <= available
    ? natural
    : natural.map((width) => Math.max(6, Math.floor((width / totalNatural) * available)));
  const border = (left, middle, right) =>
    `${styles.gray}${left}${widths.map((width) => '─'.repeat(width + 2)).join(middle)}${right}${styles.reset}`;
  const separator = `${styles.gray}│${styles.reset}`;
  const formatCell = (cell, index) => {
    const clean = cell.length > widths[index] ? `${cell.slice(0, Math.max(1, widths[index] - 1))}…` : cell;
    return ` ${padVisible(clean, widths[index])} `;
  };

  return [
    border('┌', '┬', '┐'),
    ...normalized.map((row) => `${separator}${row.map(formatCell).join(separator)}${separator}`),
    border('└', '┴', '┘'),
  ];
}

function colorizeCommandLine(line, previousLine = '', nextLine = '') {
  if (line.startsWith('●') && /\bconnected\b/.test(line)) return `${styles.green}●${styles.reset}${line.slice(1)}`;
  if (line.startsWith('◐') && /\bconfigured\b/.test(line)) return `${styles.orange}◐${styles.reset}${line.slice(1)}`;
  if (line.startsWith('○') && /\bmissing\b/.test(line)) return `${styles.red}○${styles.reset}${line.slice(1)}`;
  if (line.startsWith('○')) return `${styles.gray}○${styles.reset}${line.slice(1)}`;

  const heading = line.match(/^#{1,3}\s+(.+)$/);
  if (heading) return `${styles.bold}${styles.cyan}${heading[1]}${styles.reset}`;

  if (
    line.trim()
    && !line.startsWith(' ')
    && !line.startsWith('- ')
    && !line.includes(':')
    && !line.includes('=')
    && (nextLine.includes(':') || nextLine.includes('=') || previousLine === '')
  ) {
    return `${styles.bold}${styles.cyan}${line}${styles.reset}`;
  }

  const keyValue = line.match(/^([A-Za-z][A-Za-z0-9 _./-]{0,34}):\s*(.*)$/);
  if (keyValue) return `${styles.dim}${keyValue[1]}:${styles.reset} ${keyValue[2]}`;

  const equalsValue = line.match(/^([A-Za-z][A-Za-z0-9 _./-]{0,34})=(.*)$/);
  if (equalsValue) return `${styles.dim}${equalsValue[1]}=${styles.reset}${equalsValue[2]}`;

  const listItem = line.match(/^(-)\s+(.+)$/);
  if (listItem) return `${styles.gray}-${styles.reset} ${listItem[2]}`;

  return line;
}

function colorizeCommand(text, maxWidth = output.columns || 100) {
  const lines = String(text)
    .split('\n')
    .map((line) => line.replace(/\s+$/g, ''));
  const out = [];
  for (const block of splitTabularBlocks(lines)) {
    if (block.tabular) {
      out.push(...renderPlainTable(block.lines, maxWidth));
      continue;
    }
    block.lines.forEach((line, index) => {
      out.push(colorizeCommandLine(line, block.lines[index - 1] ?? '', block.lines[index + 1] ?? ''));
    });
  }
  return out.join('\n');
}

function formatMcpStatusForPanel(mcpStatus) {
  const entries = Object.entries(mcpStatus ?? {}).filter(([, value]) => value.status === 'connected');
  if (entries.length === 0) return [];
  return entries.map(([name, value]) => {
    const detail = [value.status, value.detail].filter(Boolean).join(' ');
    return `${styles.green}●${styles.reset} ${name}${detail ? ` ${detail}` : ''}`;
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

function dotBanner(columns) {
  const compact = ['> donna'];
  const full = [
    '  ██╗   ██████╗  ██████╗ ████████╗',
    '  ╚██╗  ██╔══██╗██╔═══██╗╚══██╔══╝',
    '   ╚██╗ ██║  ██║██║   ██║   ██║   ',
    '   ██╔╝ ██║  ██║██║   ██║   ██║   ',
    '  ██╔╝  ██████╔╝╚██████╔╝   ██║   ',
    '  ╚═╝   ╚═════╝  ╚═════╝    ╚═╝   ',
  ];
  const lines = columns >= 30 ? full : compact;
  return lines.map((line) => line.slice(0, columns));
}

function renderBannerWithMcpPanel(columns, session) {
  const banner = dotBanner(columns);
  const activeMcpLines = session.workspace ? formatMcpStatusForPanel(session.mcp) : [];
  if (banner.length === 1 || columns < 72 || activeMcpLines.length === 0) {
    return banner.map((line) => `${styles.bold}${styles.white}${line}${styles.reset}`);
  }

  const panelWidth = Math.min(48, Math.max(34, Math.floor(columns * 0.44)));
  const bannerWidth = columns - panelWidth - 3;
  const columnGap = 2;
  const columnWidth = Math.max(10, Math.floor((panelWidth - columnGap) / 2));
  const maxPanelRows = Math.max(0, banner.length - 2);
  const maxVisible = maxPanelRows * 2;
  const needsSummary = activeMcpLines.length > maxVisible;
  const visibleCount = Math.max(0, maxVisible - (needsSummary ? 1 : 0));
  const visible = activeMcpLines.slice(0, visibleCount);
  const hidden = Math.max(0, activeMcpLines.length - visible.length);
  const mcpRows = [];
  for (let index = 0; index < Math.min(maxPanelRows, Math.ceil(visible.length / 2)); index += 1) {
    const left = truncateAnsi(visible[index * 2] ?? '', columnWidth);
    const right = truncateAnsi(visible[index * 2 + 1] ?? '', columnWidth);
    mcpRows.push(`${padVisible(left, columnWidth)}${' '.repeat(columnGap)}${right}`);
  }
  if (hidden > 0) {
    const summary = `${styles.dim}+${hidden} MCP more${styles.reset}`;
    if (mcpRows.length < maxPanelRows) {
      mcpRows.push(summary);
    } else if (mcpRows.length > 0) {
      mcpRows[mcpRows.length - 1] = summary;
    }
  }
  const mcpLines = ['', 'MCP', ...mcpRows];

  return banner.map((line, index) => {
    const leftRaw = line.slice(0, bannerWidth).padEnd(bannerWidth, ' ');
    const left = `${styles.bold}${styles.white}${leftRaw}${styles.reset}`;
    const rightRaw = truncateAnsi(mcpLines[index] ?? '', panelWidth);
    const right = `${rightRaw}${' '.repeat(Math.max(0, panelWidth - stripAnsi(rightRaw).length))}`;
    return `${left}   ${right}`;
  });
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function pathBaseName(value) {
  return String(value ?? '').split('/').filter(Boolean).pop() ?? '';
}

function productionActivityFromPayload(payload) {
  const progress = payload?.progress;
  const job = payload?.job;
  const jobId = payload?.jobId ?? job?.jobId;
  if (!progress && !job && !jobId) return null;
  const status = job?.status ?? payload?.status ?? progress?.status ?? 'running';
  const percent = Number.isFinite(Number(progress?.percent))
    ? `${Math.round(Number(progress.percent))}%`
    : null;
  const sourceCount = Number(progress?.sourceCount);
  const sourceIndex = Number(progress?.sourceIndex);
  const sourceDoneCount = Number(progress?.sourceDoneCount);
  const fileProgress = Number.isFinite(sourceCount) && sourceCount > 0
    ? Number.isFinite(sourceIndex)
      ? `file ${Math.min(sourceCount, sourceIndex + 1)}/${sourceCount}`
      : Number.isFinite(sourceDoneCount)
        ? `files ${Math.min(sourceCount, sourceDoneCount)}/${sourceCount}`
        : null
    : null;
  const batchProgress = progress?.batchCount
    ? `batch ${Number(progress.batchIndex ?? 0) + 1}/${progress.batchCount}`
    : null;
  const progressDetail = batchProgress && /^batch\s+\d+\/\d+/i.test(String(progress?.detail ?? ''))
    ? null
    : progress?.detail;
  const detail = [
    progress?.phase ?? progress?.currentStep ?? job?.type ?? 'production',
    status,
    percent,
    fileProgress,
    batchProgress,
    progress?.source ? pathBaseName(progress.source) : null,
    progress?.template ? pathBaseName(progress.template) : null,
    progress?.deliverable ? pathBaseName(progress.deliverable) : null,
    progressDetail,
    progress?.lastEvent ? `last ${progress.lastEvent}` : null,
  ].filter(Boolean).join(' · ');
  return {
    jobId: jobId ?? null,
    status,
    label: detail ? `Production: ${detail}` : `Production: ${status}`,
    terminal: ['done', 'failed', 'cancelled'].includes(String(status)),
    updatedAt: new Date().toISOString(),
  };
}

function rememberProductionActivity(session, payload) {
  const activity = productionActivityFromPayload(payload);
  if (!activity) return false;
  session.productionActivity = {
    ...(session.productionActivity ?? {}),
    ...activity,
    jobId: activity.jobId ?? session.productionActivity?.jobId ?? null,
  };
  return true;
}

export function applyRuntimeStateToShellSession(session, state) {
  if (!state || typeof state !== 'object') return false;
  const displayState = sanitizeRuntimeStateForDisplay(state);
  session.agentProjection = {
    conversation: Array.isArray(displayState.conversation) ? displayState.conversation.map((message) => ({ ...message })) : [],
    chain: Array.isArray(displayState.chain) ? displayState.chain.map((step) => ({ ...step })) : [],
    plan: Array.isArray(displayState.plan) && displayState.plan.length > 0
      ? displayState.plan.map((step) => ({ ...step }))
      : null,
    activities: Array.isArray(displayState.activities) ? displayState.activities.map((activity) => ({ ...activity })) : [],
    logs: Array.isArray(displayState.logs) ? [...displayState.logs] : [],
    summary: displayState.summary ?? null,
    status: displayState.status ?? 'idle',
    planRevision: displayState.planRevision ?? 0,
    planPatches: Array.isArray(displayState.planPatches) ? displayState.planPatches.map((patch) => ({ ...patch })) : [],
  };
  session.workflow = displayState.workflow && typeof displayState.workflow === 'object'
    ? {
        ...state.workflow,
        nodes: Array.isArray(state.workflow.nodes) ? state.workflow.nodes.map((node) => ({ ...node })) : [],
        relations: Array.isArray(state.workflow.relations) ? state.workflow.relations.map((relation) => ({ ...relation })) : [],
        waitingReasons: Array.isArray(state.workflow.waitingReasons) ? [...state.workflow.waitingReasons] : [],
        warnings: Array.isArray(state.workflow.warnings) ? [...state.workflow.warnings] : [],
      }
    : null;
  session.headlessPlan = session.agentProjection.plan
    ? session.agentProjection.plan.map((step) => ({ ...step }))
    : null;
  session.activities = Object.fromEntries(
    session.agentProjection.activities.map((activity) => [activity.key, { ...activity }]),
  );
  // Runtime queue items replace the local jobQueue wholesale on every sync.
  // Tag their origin so /queue cancel can refuse to fake-cancel them locally
  // (a local status flip would be silently reverted by the next SSE sync).
  if (Array.isArray(displayState.queue)) session.jobQueue = displayState.queue.map((item) => ({ ...item, origin: 'runtime' }));
  const production = session.agentProjection.activities.filter((activity) => activity.source === 'production').at(-1);
  if (production) {
    session.productionActivity = {
      jobId: production.id,
      status: production.status,
      label: production.label,
      terminal: production.terminal,
      updatedAt: production.updatedAt,
    };
  }
  return true;
}

export function sanitizeRuntimeStateForDisplay(state) {
  if (!state || typeof state !== 'object') return state;
  const status = String(state.status ?? 'idle').toLowerCase();
  const visible = ['running', 'queued', 'pending', 'waiting', 'pending_approval', 'error', 'failed']
    .includes(status);
  if (visible) return state;
  return {
    ...state,
    conversation: [],
    chain: [],
    plan: [],
    activities: [],
    workflow: null,
    logs: [],
    summary: null,
    planPatches: [],
  };
}

// In agent mode, Donna receives every free-text turn and decides whether to
// answer or call an exposed tool. Slash commands remain the deterministic UI.
export function shouldHandleFreeTextLocally(_line, session, { llmAvailable = Boolean(session?.llm) } = {}) {
  const classification = { kind: 'agent_turn', confidence: 1, reason: 'agent_mode_llm_decision' };
  if (!llmAvailable) return { local: false, classification, fallbackReason: 'local LLM unavailable' };
  return { local: true, classification };
}

export async function submitRuntimeRun(line, { runtime, session }) {
  const workspace = session.workspace ?? null;
  try {
    if (runtimeRunActive(session)) {
      // POST /run during an active run blindly ENQUEUES a future run server-
      // side (202 queued) — the 409→control fallback below never fires, so
      // "stop le job" / "annule" ended up in the queue instead of being
      // classified. Send an explicit control message: the server classifies
      // it (cancel aborts the run, approve grants, modify proposes a patch).
      const result = await postRuntimeControl('message', { url: runtime.url, workspace, input: line });
      // The client-side "run active" flag can be STALE (projection still says
      // running right after a run ended). The server's answer carries the
      // truth: if the runtime is actually idle and only produced a canned
      // read-only reply ("Runtime is idle."), the user's input was meant to
      // START a run — fall through to POST /run instead of dead-ending.
      const idleCannedReply = result?.running === false
        && ['converse', 'observe', 'ambiguous'].includes(String(result?.kind ?? ''));
      if (!idleCannedReply) {
        return { kind: result?.kind ?? 'control', result };
      }
    }
    const result = await postRuntimeRun(line, { url: runtime.url, workspace });
    if (result?.queued || result?.kind === 'enqueue_run' || result?.kind === 'enqueue') {
      return { kind: 'queued', result };
    }
    if (result?.kind && !result?.runId) {
      // The server was actually running (stale idle flag client-side) and
      // classified our input as a control message — surface its kind and
      // localized explanation instead of pretending a run was accepted.
      return { kind: result.kind, result };
    }
    return { kind: 'accepted', result };
  } catch (err) {
    if (err?.status !== 409) {
      return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    }
    try {
      const result = await postRuntimeControl('message', { url: runtime.url, workspace, input: line });
      return { kind: result?.kind ?? 'control', result };
    } catch (queueErr) {
      return { kind: 'error', message: queueErr instanceof Error ? queueErr.message : String(queueErr) };
    }
  }
}

function activityText(session) {
  const activity = sessionActivities(session).find((item) => !item.terminal)
    ?? (session.productionActivity?.label ? session.productionActivity : null);
  if (!activity?.label) return '';
  const color = activity.terminal
    ? (activity.status === 'done' || activity.status === 'success') ? styles.green : styles.red
    : styles.cyan;
  return `${color}${truncateAnsi(activity.label, 72)}${styles.reset}`;
}

function runtimeRunActive(session) {
  return String(session.agentProjection?.status ?? '').toLowerCase() === 'running';
}

function dividerWithActivity(session, columns) {
  const activity = activityText(session);
  if (!activity) return '─'.repeat(columns);
  const plain = stripAnsi(activity);
  const slot = ` ${plain} `;
  const visible = Math.min(columns, slot.length);
  const left = Math.max(0, columns - visible);
  const clipped = truncateAnsi(activity, Math.max(0, columns - left - 2));
  return `${styles.gray}${'─'.repeat(left)}${styles.reset} ${clipped} `;
}

function renderActivityLines(activityLines, columns, rows) {
  return activityLines
    .slice(-rows)
    .map((line) => `${styles.dim}${truncateAnsi(line, Math.max(10, columns - 2))}${styles.reset}`);
}

function isDurableActivityLine(label) {
  return /^[a-z0-9_-]+\.[a-z0-9_-]+:/i.test(String(label).trim());
}

function renderScreen({ packageJson, session, messages, inputBuffer, busy = false, spinnerFrame = 0, scrollOffset = 0, spinnerLabel = 'Thinking…', activityLines = [], runtime = null }) {
  const columns = output.columns || 100;
  const rows = output.rows || 30;
  const banner = renderBannerWithMcpPanel(columns, session);
  const runtimeBanner = runtimeUnavailableAgentMessage(runtime);
  const completions = busy ? [] : completionLines(inputBuffer, session, columns);
  const visibleCompletions = completions.slice(0, COMPLETION_PANEL_ROWS);
  const completionRows = visibleCompletions.length > 0 ? COMPLETION_PANEL_ROWS : 0;
  const activityRows = LOWER_DETAIL_ROWS - completionRows;
  const activity = renderActivityLines(activityLines, columns, activityRows);
  const productionActivityRows = 1;
  const fixedRows = 4 + banner.length + (runtimeBanner ? 1 : 0) + productionActivityRows + 1 + LOWER_PANEL_ROWS + BOTTOM_PADDING_ROWS;
  const middleHeight = Math.max(5, rows - fixedRows);
  lastMiddleHeight = middleHeight;
  const prompt = promptFor(session);
  const title = '';
  const context = [
    `wiki-manager ${versionWithBuild(packageJson)}`,
    session.workspace ? session.workspace : 'no workspace',
    session.wikirc?.profile ? session.wikirc.profile : 'no wikirc',
    session.language ? session.language : 'no language',
    session.llm ? 'llm ready' : 'llm limited',
    runtimeStatusLine(runtime, session),
  ].join('  ');
  const header = `${title}${' '.repeat(Math.max(0, columns - stripAnsi(title).length - context.length))}${context}`;
  const divider = '─'.repeat(columns);

  const bodyLines = messages.flatMap((message, index) => {
    const label =
      message.role === 'user'
        ? `${styles.cyan}You${styles.reset}`
        : message.role === 'command'
          ? `${styles.gray}Shell${styles.reset}`
          : `${styles.green}donna${styles.reset}`;
    const lines = message.role === 'command'
      ? [
        `${label}:`,
        ...wrapText(colorizeCommand(message.content, columns), columns),
      ]
      : wrapText(
        `${label}: ${isDonnaRole(message.role) ? colorizeStatus(message.content) : message.content}`,
        columns,
      );
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
    ? `${styles.cyan}${spinner}${styles.reset} ${styles.dim}${spinnerLabel}${styles.reset}`
    : `${prompt}${inputBuffer}`;

  const clippedInputLine = truncateAnsi(inputLine, columns);
  let buf = '\u001b[?25l\u001b[H';
  buf += `${header.slice(0, columns).padEnd(columns, ' ')}\n`;
  buf += `${' '.repeat(columns)}\n`;
  if (banner.length > 0) {
    buf += `${banner.map((line) => line.padEnd(columns, ' ')).join('\n')}\n`;
  }
  if (runtimeBanner) {
    buf += `${padVisible(`${styles.yellow}${truncateAnsi(runtimeBanner, columns)}${styles.reset}`, columns)}\n`;
  }
  buf += `${topDivider}\n`;
  buf += `${visibleBody.map((line) => padVisible(line, columns)).join('\n')}\n`;
  // Keep this line reserved: production jobs publish their progress here.
  buf += `${padVisible(dividerWithActivity(session, columns), columns)}\n`;
  buf += `${padVisible(clippedInputLine, columns)}\n`;
  buf += `${styles.white}${'─'.repeat(columns)}${styles.reset}\n`;
  for (let index = 0; index < activityRows; index += 1) {
    buf += `${padVisible(activity[index] ?? '', columns)}\n`;
  }
  for (let index = 0; index < completionRows; index += 1) {
    buf += `${padVisible(visibleCompletions[index] ?? '', columns)}\n`;
  }
  for (let index = 0; index < BOTTOM_PADDING_ROWS; index += 1) {
    buf += `${' '.repeat(columns)}\n`;
  }
  buf += `\u001b[${LOWER_PANEL_ROWS + BOTTOM_PADDING_ROWS + 1}A`;
  buf += `\u001b[${stripAnsi(clippedInputLine).length + 1}G`;
  buf += '\u001b[?25h';
  output.write(buf);
}

async function runAgentTurn(input, { agent, session, onUpdate, onStep, displayInput = input }) {
  const messages = conversationMessages(session);
  const history = toConversationHistory(messages);
  session._onStep = onStep ?? null;
  session.packageJson = session.packageJson ?? {};
  dispatchAgentEvent(session, createAgentEvent('run_started', {
    origin: 'user',
    payload: { input: displayInput },
  }));
  dispatchAgentEvent(session, createAgentEvent('user_message', {
    origin: 'user',
    payload: { content: displayInput },
  }));

  // Show the user's input in the conversation (mirrors runDirectChatTurn).
  messages.push({ role: 'user', content: displayInput });
  onUpdate?.();

  // Create the donna bubble immediately so "Thinking…" is visible during TTFT.
  let donnaMessage = { role: 'donna', content: '' };
  messages.push(donnaMessage);
  onUpdate?.();

  session._onStream = (delta) => {
    if (!donnaMessage) {
      // Re-create after _onStreamReset removed an empty bubble (tool call on first turn).
      donnaMessage = { role: 'donna', content: '' };
      messages.push(donnaMessage);
    }
    if (delta) {
      donnaMessage.content += delta;
      onUpdate?.();
    }
  };
  session._onStreamReset = () => {
    if (!donnaMessage) return;
    // Text emitted before a tool call is provisional narration, not an answer.
    // Remove it; the post-tool result gets a fresh Donna bubble.
    const index = messages.indexOf(donnaMessage);
    if (index !== -1) messages.splice(index, 1);
    donnaMessage = null;
    onUpdate?.();
  };

  let agentResult;
  try {
    agentResult = await agent.invoke({ input, session, messages: history });
  } catch (err) {
    if (err.name === 'AbortError') {
      if (donnaMessage) {
        const idx = messages.indexOf(donnaMessage);
        if (idx !== -1) messages.splice(idx, 1);
      }
      return { aborted: true };
    }
    // Non-abort error: surface it in the bubble rather than leaving "Thinking…" stuck.
    if (donnaMessage) {
      const msg = err instanceof Error ? err.message : String(err);
      donnaMessage.content = formatLlmUnavailableMessage(msg);
      onUpdate?.();
    }
    throw err;
  } finally {
    delete session._onStep;
    delete session._onStream;
    delete session._onStreamReset;
  }

  if (agentResult.streamedInline) {
    if (donnaMessage) {
      donnaMessage.content = stripDsmlArtifacts(donnaMessage.content).trimEnd();
      if (!donnaMessage.content.trim()) {
        donnaMessage.content = formatLlmUnavailableMessage('flux vide');
      }
    } else {
      messages.push({ role: 'donna', content: formatLlmUnavailableMessage('flux vide') });
    }
    onUpdate?.();
    return {};
  }

  if (agentResult.response != null) {
    const content = stripDsmlArtifacts(agentResult.response);
    if (donnaMessage) {
      donnaMessage.content = content;
    } else {
      messages.push({ role: 'donna', content });
    }
    onUpdate?.();
    return {};
  }

  if (agentResult.readyToStream && session.llm?.stream) {
    if (!donnaMessage) {
      donnaMessage = { role: 'donna', content: '' };
      messages.push(donnaMessage);
    }
    onUpdate?.();
    const { system, messages: streamMessages = [] } = agentResult.streamContext ?? {};
    try {
      onStep?.('Agent: streaming final answer…');
      for await (const delta of session.llm.stream({
        system: system ?? buildAgentSystemPrompt({ input, session }),
        messages: streamMessages,
        signal: session._abortSignal,
      })) {
        const cleanDelta = stripDsmlArtifacts(delta);
        if (cleanDelta) {
          donnaMessage.content += cleanDelta;
          onUpdate?.();
        }
      }
      donnaMessage.content = stripDsmlArtifacts(donnaMessage.content).trimEnd();
      if (!donnaMessage.content.trim()) {
        donnaMessage.content = formatLlmUnavailableMessage('flux vide');
        onUpdate?.();
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        const idx = messages.indexOf(donnaMessage);
        if (idx !== -1) messages.splice(idx, 1);
        return { aborted: true };
      }
      const message = err instanceof Error ? err.message : String(err);
      donnaMessage.content = formatLlmUnavailableMessage(message);
      onUpdate?.();
    }
    return {};
  }

  if (donnaMessage) {
    donnaMessage.content = formatLlmUnavailableMessage('reponse vide');
  } else {
    messages.push({ role: 'donna', content: formatLlmUnavailableMessage('reponse vide') });
  }
  onUpdate?.();
  return {};
}

// Bounded read-only tool loop for /chat. Only the tools declared in chatAccess
// (and read-only) are offered; every call goes through callMcpTool, and any
// tool the model names outside the offered set is refused — /chat can never
// mutate or delegate. maxToolIterations caps the loop.
async function runChatReadToolLoop({ input, session, history, donnaMessage, onUpdate, onStep, readTools }) {
  const allowed = new Set(readTools.map((item) => item.function.name));
  // /chat only supplies the policy; the loop mechanic lives in runBoundedToolLoop.
  // executeCall enforces the allow-list and turns each call into a text result;
  // it never mutates and refuses anything outside the offered read set.
  const executeCall = async (call) => {
    const rawName = call.function?.name ?? '';
    const { server, tool } = resolveToolCallName(session.mcp, rawName);
    const qualified = server ? `${server}__${tool}` : null;
    if (!qualified || !allowed.has(qualified)) {
      return `Refused: "${rawName}" is not an available read-only tool in chat mode. Actions and other tools live in agent mode (/agent).`;
    }
    let args = {};
    try { args = call.function?.arguments ? JSON.parse(call.function.arguments) : {}; } catch { args = {}; }
    try {
      onStep?.(`Chat: read ${server} ${tool}…`);
      const res = await callMcpTool(session.mcp, server, tool, args, session._abortSignal);
      return formatMcpToolResult(res);
    } catch (err) {
      if (err.name === 'AbortError' && session._abortSignal?.aborted) throw err;
      return `Error [${qualified}]: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
  const { content, capped } = await runBoundedToolLoop({
    llm: session.llm,
    system: buildDirectChatSystemPrompt(session),
    messages: [...history, { role: 'user', content: input }],
    tools: readTools,
    executeCall,
    maxIterations: Math.min(8, Number(session?.chatAccess?.maxToolIterations) || 4),
    signal: session._abortSignal,
    onStep: (i, cap) => onStep?.(`Chat: consulting… [${i}/${cap}]`),
  });
  donnaMessage.content = capped
    ? 'Je n’ai pas pu conclure dans la limite d’itérations du mode chat. Passe en /agent si besoin.'
    : (stripDsmlArtifacts(content).trimEnd() || formatLlmUnavailableMessage('reponse vide'));
  onUpdate?.();
}

async function runDirectChatTurn(input, { session, onUpdate, onStep }) {
  if (!session.llm?.stream) {
    conversationMessages(session).push({ role: 'command', content: directChatUnavailableText(session) });
    return { exit: false };
  }
  const messages = conversationMessages(session);
  const history = toConversationHistory(messages);
  messages.push({ role: 'user', content: input });
  onUpdate?.();
  const donnaMessage = { role: 'donna', content: '' };
  messages.push(donnaMessage);
  onUpdate?.();
  const readTools = chatReadTools(session);
  const canUseReadTools = readTools.length > 0 && typeof session.llm.completeWithTools === 'function';
  try {
    if (canUseReadTools) {
      await runChatReadToolLoop({ input, session, history, donnaMessage, onUpdate, onStep, readTools });
    } else {
      onStep?.('Chat: streaming direct answer…');
      for await (const delta of session.llm.stream({
        system: buildDirectChatSystemPrompt(session),
        messages: [...history, { role: 'user', content: input }],
        signal: session._abortSignal,
      })) {
        const cleanDelta = stripDsmlArtifacts(delta);
        if (cleanDelta) {
          donnaMessage.content += cleanDelta;
          onUpdate?.();
        }
      }
      donnaMessage.content = stripDsmlArtifacts(donnaMessage.content).trimEnd();
      if (!donnaMessage.content.trim()) {
        donnaMessage.content = formatLlmUnavailableMessage('flux vide');
        onUpdate?.();
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      messages.pop();
      return { exit: false, aborted: true };
    }
    const message = err instanceof Error ? err.message : String(err);
    donnaMessage.content = formatLlmUnavailableMessage(message);
    onUpdate?.();
  }
  return { exit: false };
}

// Headless equivalent of runDirectChatTurn for HTTP callers (the runtime /turn
// in chat mode). Reuses the exact same read-only policy — chatReadTools +
// runChatReadToolLoop + buildDirectChatSystemPrompt — so there is no second
// implementation of chat access; it just returns the final text instead of
// driving a live repl bubble. The caller must have seeded session.chatAccess
// (and session.mcp) so chatReadTools can resolve the allow-listed read tools.
export async function runHeadlessChatTurn(session, input, { history = [], onStep } = {}) {
  const donnaMessage = { role: 'donna', content: '' };
  const readTools = chatReadTools(session);
  const canUseReadTools = readTools.length > 0 && typeof session.llm?.completeWithTools === 'function';
  if (canUseReadTools) {
    await runChatReadToolLoop({ input, session, history, donnaMessage, onStep, readTools });
    return donnaMessage.content;
  }
  if (typeof session.llm?.stream === 'function') {
    let content = '';
    for await (const delta of session.llm.stream({
      system: buildDirectChatSystemPrompt(session),
      messages: [...history, { role: 'user', content: input }],
      signal: session._abortSignal,
    })) {
      const clean = stripDsmlArtifacts(delta);
      if (clean) content += clean;
    }
    return stripDsmlArtifacts(content).trimEnd() || formatLlmUnavailableMessage('flux vide');
  }
  return directChatUnavailableText(session);
}

function directChatUnavailableText(session) {
  if (!session.workspacePath) {
    return 'Direct chat unavailable: no workspace loaded. Use /use <workspace>.';
  }
  if (!session.wikircConfig) {
    return 'Direct chat unavailable: no active wikirc profile. Use /config list then /config use <profile>.';
  }
  const llm = session.wikircConfig?.llm ?? {};
  const missing = [
    !llm.apiKey ? 'llm.apiKey' : null,
    !llm.model ? 'llm.model' : null,
    !llm.baseUrl ? 'llm.baseUrl' : null,
  ].filter(Boolean);
  if (missing.length > 0) {
    return [
      `Direct chat unavailable: missing ${missing.join(', ')} in ${session.wikirc?.fileName ?? 'active wikirc'}.`,
      'Use /config list, /config use <profile>, or /config edit <profile>.',
    ].join('\n');
  }
  return 'Direct chat unavailable: no streaming LLM configured.';
}

export async function runLine(line, { agent, packageJson, session, onUpdate, onStep, chatMode = session.chatMode ?? true, runtime = null }) {
  const trimmed = stripHtml(line).trim();
  if (!trimmed) return { exit: false };

  if (/^\/chat(?:\s|$)/.test(trimmed) && trimmed.replace(/^\/chat(?:\s+|$)/, '').trim()) {
    conversationMessages(session).push({ role: 'command', content: 'Usage: /chat\nThen type your message in chat mode.' });
    return { exit: false };
  }

  if (trimmed.startsWith('/')) {
    onStep?.(`Shell: ${trimmed}`);
    const result = await handleSlashCommand(trimmed, { packageJson, session, onStep, runtime });
    const messages = conversationMessages(session);
    const handoffRawToAgent = Boolean(result.rawOutput && result.agentTrigger && agent);
    if (result.output) {
      const parts = trimmed.split(/\s+/);
      if (parts[0] === '/mcp' && parts[1] === 'call' && parts[2]) {
        const payload = parseJsonText(result.output);
        const activity = extractActivity(payload, { server: parts[2], tool: parts[3] });
        if (activity) {
          dispatchAgentEvent(session, createAgentEvent('activity_upserted', {
            origin: 'tool',
            payload: { activity },
          }));
        } else {
          rememberProductionActivity(session, payload);
        }
      }
    }
    if (result.output && !handoffRawToAgent) {
      messages.push({ role: 'command', content: result.output });
      onUpdate?.();
    }
    if (handoffRawToAgent) {
      const agentResult = await runAgentTurn(result.agentTrigger, { agent, session, onUpdate, onStep, displayInput: trimmed });
      if (agentResult.aborted) return { exit: false, aborted: true };
    } else if (result.agentTrigger && agent) {
      const agentResult = await runAgentTurn(result.agentTrigger, { agent, session, onUpdate, onStep });
      if (agentResult.aborted) return { exit: false, aborted: true };
    }
    return { exit: Boolean(result.exit), setMode: result.setMode };
  }

  if (chatMode) {
    return runDirectChatTurn(trimmed, { session, onUpdate, onStep });
  }

  const agentResult = await runAgentTurn(trimmed, { agent, session, onUpdate, onStep });
  if (agentResult.aborted) return { exit: false, aborted: true };
  return { exit: false };
}

async function runPipeShell({ agent, packageJson, session }) {
  const rl = createInterface({ input, output, prompt: promptFor(session) });
  console.log(`donna  wiki-manager ${packageJson.version}  non-interactive`);
  console.log('─'.repeat(80));
  console.log('Agent-first shell active. Type /help for commands, /exit to quit.');
  rl.prompt();

  try {
    for await (const rawLine of rl) {
      const beforeMessages = conversationMessages(session);
      const beforeLength = beforeMessages.length;
      const result = await runLine(rawLine, { agent, packageJson, session });
      const afterMessages = conversationMessages(session);
      const emitted = afterMessages === beforeMessages ? afterMessages.slice(beforeLength) : afterMessages;
      for (const message of emitted) console.log(message.content);
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

async function runTuiShell({ agent, packageJson, session, runtime = null }) {
  const messages = conversationMessages(session);
  messages.push({
    role: 'donna',
    content: [
      initialLegacyWelcomeMessage(),
      'Tip: Ctrl+Y copies the last response.',
    ].join('\n'),
  });
  let inputBuffer = '';
  const inputHistory = [];
  let historyIndex = null;
  let busy = false;
  let spinnerFrame = 0;
  let spinnerInterval = null;
  let spinnerLabel = 'Thinking…';
  let activityLines = [];
  let lastCtrlCAt = 0;
  let ctrlCTimer = null;
  let currentAbortController = null;
  let scrollOffset = 0;
  let mouseScrollEnabled = false;
  let desiredMouseScrollEnabled = false;
  let mouseSelectionTimer = null;
  let done = false;
  let processing = Promise.resolve();
  let runtimePollingActive = false;
  let runtimeStreamAbort = null;
  let runtimeReconnectTimer = null;
  let runtimeSyncTimer = null;
  let runtimeStreamStopped = false;
  let runtimeShutdownRequested = false;
  let finish;
  const finished = new Promise((resolve) => {
    finish = resolve;
  });

  async function shutdownRuntimeOnExit() {
    if (!runtime?.url || runtimeShutdownRequested) return;
    runtimeShutdownRequested = true;
    try {
      await postRuntimeShutdown({ url: runtime.url });
    } catch {
      // The shell is already exiting; an unavailable runtime should not block
      // terminal restoration.
    }
  }

  input.setRawMode(true);
  input.resume();
  output.write('\u001b[?1049h');

  const rerender = () => renderScreen({ packageJson, session, messages: conversationMessages(session), inputBuffer, busy, spinnerFrame, scrollOffset, spinnerLabel, activityLines, runtime });
  busy = true;
  spinnerLabel = 'Loading wiki-manager shell...';
  spinnerInterval = setInterval(() => {
    spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
    rerender();
  }, 80);
  rerender();

  try {
    const { output: wsOutput } = await handleSlashCommand('/workspace list', { packageJson, session });
    if (wsOutput) messages.push({ role: 'command', content: wsOutput });
  } finally {
    clearInterval(spinnerInterval);
    spinnerInterval = null;
    busy = false;
    spinnerFrame = 0;
    spinnerLabel = 'Thinking…';
    rerender();
  }

  function syncRuntimeState() {
    if (!runtime?.url) return;
    void fetchRuntimeState({ url: runtime.url, workspace: session.workspace ?? null })
      .then((state) => {
        runtimePollingActive = true;
        applyRuntimeStateToShellSession(session, state);
        rerender();
      })
      .catch(() => {
        runtimePollingActive = false;
        rerender();
      });
  }

  function scheduleRuntimeStateSync() {
    if (runtimeSyncTimer) clearTimeout(runtimeSyncTimer);
    runtimeSyncTimer = setTimeout(syncRuntimeState, 200);
  }

  async function subscribeRuntimeEvents() {
    if (!runtime?.url || runtimeStreamStopped) return;
    runtimeStreamAbort = new AbortController();
    try {
      for await (const event of streamRuntimeEvents({ url: runtime.url, signal: runtimeStreamAbort.signal, workspace: session.workspace ?? null })) {
        runtimePollingActive = true;
        if (event.type === 'state') {
          applyRuntimeStateToShellSession(session, event.data);
          rerender();
        } else {
          scheduleRuntimeStateSync();
        }
      }
    } catch {
      // Runtime stream may be temporarily unavailable; the local MCP polling fallback resumes below.
    }
    if (runtimeStreamStopped) return;
    runtimePollingActive = false;
    rerender();
    runtimeReconnectTimer = setTimeout(() => { void subscribeRuntimeEvents(); }, 1500);
  }

  if (runtime?.url) {
    syncRuntimeState();
    void subscribeRuntimeEvents();
  }

  const pollBusy = new Set();
  const productionPollInterval = setInterval(async () => {
    if (runtimePollingActive) return;
    const candidates = sessionActivities(session).filter((item) => item.poll && !item.terminal);
    // Legacy fallback: if no generic activities tracked yet, fall back to productionActivity.
    if (candidates.length === 0 && session.productionActivity?.jobId && !session.productionActivity.terminal) {
      candidates.push({
        key: `production:${session.productionActivity.jobId}`,
        poll: { server: 'production', tool: 'production_job_status', args: { jobId: session.productionActivity.jobId }, intervalMs: 2500 },
        terminal: false,
        lastPolledAt: null,
      });
    }
    for (const activity of candidates) {
      const key = activity.key ?? `${activity.poll.server}:${activity.id ?? 'activity'}`;
      if (pollBusy.has(key)) continue;
      const endpoint = session.mcp?.[activity.poll.server];
      if (!endpoint || endpoint.status !== 'connected') continue;
      const intervalMs = activity.poll.intervalMs ?? 2500;
      const lastPolledAt = Date.parse(activity.lastPolledAt ?? '0');
      if (Date.now() - lastPolledAt < intervalMs) continue;
      pollBusy.add(key);
      activity.lastPolledAt = new Date().toISOString();
      void callMcpTool(session.mcp, activity.poll.server, activity.poll.tool, activity.poll.args ?? {})
        .then((result) => {
          const payload = parseJsonText(formatMcpToolResult(result));
          const polledActivity = extractActivity(payload, { server: activity.poll.server, tool: activity.poll.tool });
          if (polledActivity) {
            dispatchAgentEvent(session, createAgentEvent('activity_upserted', {
              origin: 'poll',
              payload: { activity: polledActivity },
            }));
          }
          if (!polledActivity && rememberProductionActivity(session, payload)) {
            syncActivitiesToPlan(session.headlessPlan, sessionActivities(session));
          }
          if (polledActivity || session.productionActivity) rerender();
        })
        .catch(() => {
          // Keep the last known status visible; transient MCP errors should not interrupt typing.
        })
        .finally(() => {
          pollBusy.delete(key);
        });
    }
  }, 1000);

  const setMouseScrollEnabled = (enabled) => {
    mouseScrollEnabled = enabled;
    output.write(enabled ? '\u001b[?1000h\u001b[?1006h' : '\u001b[?1000l\u001b[?1006l');
  };

  const suspendMouseForSelection = () => {
    setMouseScrollEnabled(false);
    clearTimeout(mouseSelectionTimer);
    mouseSelectionTimer = setTimeout(() => {
      if (!done && desiredMouseScrollEnabled) setMouseScrollEnabled(true);
    }, MOUSE_SELECTION_RESUME_MS);
  };

  const mouseFilter = new Transform({
    transform(chunk, _enc, cb) {
      const str = chunk.toString('utf8');
      const filtered = str.replace(/\u001b\[<(\d+);\d+;\d+([Mm])/g, (_, btnStr, suffix) => {
        const btn = parseInt(btnStr, 10);
        if (btn === 64) {
          scrollOffset = Math.min(scrollOffset + 3, Math.max(0, lastBodyLineCount - lastMiddleHeight));
          setImmediate(rerender);
        } else if (btn === 65) {
          scrollOffset = Math.max(0, scrollOffset - 3);
          setImmediate(rerender);
        } else if (suffix === 'M') {
          suspendMouseForSelection();
        } else if (suffix === 'm') {
          clearTimeout(mouseSelectionTimer);
          mouseSelectionTimer = null;
          if (desiredMouseScrollEnabled) setMouseScrollEnabled(true);
        }
        return '';
      });
      if (filtered.length > 0) cb(null, Buffer.from(filtered, 'utf8'));
      else cb();
    },
  });
  input.pipe(mouseFilter);
  emitKeypressEvents(mouseFilter);
  setMouseScrollEnabled(false);

  const onResize = () => rerender();
  output.on('resize', onResize);
  rerender();

  const handleKeypress = async (str, key) => {
    if (done) return;

    if (key?.ctrl && key.name === 't') {
      const prevLabel = spinnerLabel;
      const prevBusy = busy;
      desiredMouseScrollEnabled = !desiredMouseScrollEnabled;
      setMouseScrollEnabled(desiredMouseScrollEnabled);
      spinnerLabel = desiredMouseScrollEnabled
        ? 'Mouse scroll enabled — click temporarily restores native selection'
        : 'Mouse scroll disabled — native text selection and copy restored';
      busy = true;
      rerender();
      setTimeout(() => { spinnerLabel = prevLabel; busy = prevBusy; rerender(); }, 1800);
      return;
    }

    if (key?.ctrl && key.name === 'y') {
      const lastDonna = [...messages].reverse().find((m) => isDonnaRole(m.role));
      if (lastDonna) {
        const text = stripAnsi(colorizeStatus(lastDonna.content)).replace(/\[[0-9;]*m/g, '');
        const clipCmd = process.platform === 'darwin'
          ? { command: 'pbcopy', args: [] }
          : { command: 'xclip', args: ['-selection', 'clipboard'] };
        const prevLabel = spinnerLabel;
        const prevBusy = busy;
        try {
          execFileSync(clipCmd.command, clipCmd.args, { input: text });
          spinnerLabel = 'Copied to clipboard ✓';
        } catch {
          spinnerLabel = 'Copy failed — pbcopy / xclip not available';
        }
        busy = true;
        rerender();
        setTimeout(() => { spinnerLabel = prevLabel; busy = prevBusy; rerender(); }, 1800);
      }
      return;
    }
    if ((key?.ctrl || key?.meta) && key.name === 'c') {
      if (busy) {
        currentAbortController?.abort();
        spinnerLabel = 'Interrupting…';
        rerender();
        return;
      }
      if (runtime?.url && runtimeRunActive(session)) {
        void postRuntimeCancel({ url: runtime.url, workspace: session.workspace ?? null })
          .then(() => {
            activityLines = [...activityLines, 'runtime: cancel requested'].slice(-LOWER_DETAIL_ROWS);
            rerender();
          })
          .catch((err) => {
            activityLines = [...activityLines, `runtime cancel error: ${err instanceof Error ? err.message : String(err)}`].slice(-LOWER_DETAIL_ROWS);
            rerender();
          });
        return;
      }
      const now = Date.now();
      if (now - lastCtrlCAt <= 1500) {
        done = true;
        finish();
        return;
      }
      lastCtrlCAt = now;
      const exitHint = 'Shell: press Ctrl+C again to exit.';
      activityLines = [...activityLines.filter((line) => line !== exitHint), exitHint].slice(-LOWER_DETAIL_ROWS);
      rerender();
      clearTimeout(ctrlCTimer);
      ctrlCTimer = setTimeout(() => {
        if (Date.now() - lastCtrlCAt >= 1500) {
          activityLines = activityLines.filter((line) => line !== exitHint);
          lastCtrlCAt = 0;
          rerender();
        }
      }, 1600);
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
      activityLines = [];
      spinnerFrame = 0;
      spinnerLabel = 'Working…';
      spinnerInterval = setInterval(() => {
        spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
        rerender();
      }, 80);
      rerender();
      const onStep = (label) => {
        if (!String(label).startsWith('Production:')) {
          activityLines = [...activityLines, label].slice(-LOWER_DETAIL_ROWS);
        }
        rerender();
      };
      currentAbortController = new AbortController();
      session._abortSignal = currentAbortController.signal;
      let aborted = false;
      try {
        if (runtime?.url && line.trim().startsWith('/approve')) {
          const parts = line.trim().split(/\s+/).slice(1);
          const kind = ['run', 'item', 'approval'].includes(parts[0]) ? parts.shift() : 'run';
          const id = parts[0];
          if (!id) {
            conversationMessages(session).push({ role: 'command', content: 'Usage: /approve [run|item|approval] <id>' });
          } else {
            const result = await postRuntimeApprove({
              url: runtime.url,
              workspace: session.workspace ?? null,
              ...(kind === 'item' ? { itemId: id } : kind === 'approval' ? { approvalId: id } : { runId: id }),
            });
            conversationMessages(session).push({ role: 'command', content: `Approval ${result.approved ? 'accepted' : 'not found'}: ${id}` });
            syncRuntimeState();
          }
        } else {
          const freeTextRouting = (runtime?.url && !session.chatMode && !line.trim().startsWith('/'))
            ? shouldHandleFreeTextLocally(line, session)
            : null;
          if (freeTextRouting?.local) {
            // Question/small talk → local agent (read tools), no runtime run.
            activityLines = [...activityLines, `agent: ${freeTextRouting.classification.kind} handled locally`].slice(-LOWER_DETAIL_ROWS);
            const result = await runLine(line, { agent, packageJson, session, onUpdate: rerender, onStep, runtime });
            done = result.exit;
            aborted = result.aborted ?? false;
          } else if (runtime?.url && !session.chatMode && !line.trim().startsWith('/')) {
            if (freeTextRouting?.fallbackReason) {
              activityLines = [...activityLines, `runtime: ${freeTextRouting.fallbackReason}, routing to runtime run`].slice(-LOWER_DETAIL_ROWS);
            }
            conversationMessages(session).push({ role: 'user', content: line });
            const outcome = await submitRuntimeRun(line, { runtime, session });
            if (outcome.kind === 'accepted') {
              activityLines = [...activityLines, 'runtime: run accepted'].slice(-LOWER_DETAIL_ROWS);
            } else if (outcome.kind === 'queued') {
              // Server-localized acknowledgement (src/runtime/controlMessages.js).
              conversationMessages(session).push({ role: 'command', content: String(outcome.result?.explanation ?? 'Request added to the queue.') });
              activityLines = [...activityLines, 'runtime: control queued'].slice(-LOWER_DETAIL_ROWS);
            } else if (outcome.kind === 'observe' || outcome.kind === 'converse' || outcome.kind === 'mutate') {
              const explanation = outcome.result?.explanation ?? 'Runtime control message accepted.';
              conversationMessages(session).push({ role: 'command', content: explanation });
              activityLines = [...activityLines, `runtime: ${outcome.kind}`].slice(-LOWER_DETAIL_ROWS);
            } else if (outcome.kind === 'ambiguous') {
              conversationMessages(session).push({ role: 'command', content: String(outcome.result?.explanation ?? 'Runtime could not classify that message. Use /queue for a future run, or ask/status more explicitly.') });
              activityLines = [...activityLines, 'runtime: ambiguous control'].slice(-LOWER_DETAIL_ROWS);
            } else if (outcome.result?.explanation) {
              // cancel / approve / modify_run and any future control kinds:
              // always surface the server's localized explanation.
              conversationMessages(session).push({ role: 'command', content: String(outcome.result.explanation) });
              activityLines = [...activityLines, `runtime: ${outcome.kind}`].slice(-LOWER_DETAIL_ROWS);
            } else {
              conversationMessages(session).push({ role: 'command', content: `Runtime error: ${outcome.message}` });
              activityLines = [...activityLines, `runtime error: ${outcome.message}`].slice(-LOWER_DETAIL_ROWS);
            }
            syncRuntimeState();
          } else if (!session.chatMode && !line.trim().startsWith('/')) {
            const message = recordRuntimeUnavailableAgentInput(session, line, runtime);
            activityLines = [...activityLines, message ?? 'runtime: disconnected'].slice(-LOWER_DETAIL_ROWS);
          } else {
            const result = await runLine(line, { agent, packageJson, session, onUpdate: rerender, onStep, runtime });
            done = result.exit;
            aborted = result.aborted ?? false;
          }
        }
      } catch (err) {
        if (err.name !== 'AbortError') throw err;
        aborted = true;
      } finally {
        currentAbortController = null;
        delete session._abortSignal;
        clearInterval(spinnerInterval);
        spinnerInterval = null;
        busy = false;
        spinnerLabel = 'Thinking…';
        activityLines = activityLines.filter(isDurableActivityLine).slice(-LOWER_DETAIL_ROWS);
        scrollOffset = 0;
        rerender();
      }
      if (aborted) {
        activityLines = ['Interrupted.'];
        rerender();
      }
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
    runtimeStreamStopped = true;
    runtimeStreamAbort?.abort();
    clearTimeout(runtimeReconnectTimer);
    clearTimeout(runtimeSyncTimer);
    clearInterval(productionPollInterval);
    clearTimeout(ctrlCTimer);
    clearTimeout(mouseSelectionTimer);
    output.off('resize', onResize);
    setMouseScrollEnabled(false);
    input.unpipe(mouseFilter);
    mouseFilter.destroy();
    input.setRawMode(false);
    input.pause();
    output.write('\u001b[?25h\u001b[H\u001b[2J\u001b[?1049l');
    await shutdownRuntimeOnExit();
  }
}

export async function runShell({ agent, packageJson, runtime = null }) {
  const session = createSession();
  // Donna's runtime control tools (runtime__kill/cancel/status) read the
  // endpoint from the session.
  session.runtime = runtime;
  if (!input.isTTY || !output.isTTY) {
    await runPipeShell({ agent, packageJson, session });
    return;
  }
  await runTuiShell({ agent, packageJson, session, runtime });
}
