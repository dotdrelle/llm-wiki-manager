import { createInterface } from 'node:readline';
import { emitKeypressEvents } from 'node:readline';
import { Transform } from 'node:stream';
import { stdin as input, stdout as output } from 'node:process';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { buildAgentSystemPrompt, buildLimitedAgentResponse } from '../agent/graph.js';
import { handleSlashCommand } from '../commands/slash.js';
import { serviceDescription, serviceNames as composeServiceNames } from '../core/compose.js';
import { callMcpTool, formatMcpToolResult } from '../core/mcp.js';
import { listSkills } from '../core/skills.js';
import { listWikircProfiles } from '../core/wikirc.js';
import { listWorkspaces } from '../core/workspaces.js';

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
  '/workspaces': 'List configured workspaces.',
  '/new': 'Create or configure a new workspace.',
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
  '/show-skill': 'Show one skill.',
  '/run-skill': 'Prepare one skill for guided execution.',
  '/clear': 'Clear the conversation screen.',
  '/chat': 'Stream a direct chat answer without agent tools.',
};

const SUBCOMMAND_COMPLETION_DESCRIPTIONS = {
  '/config:list': 'List .wikirc.yaml profiles.',
  '/config:status': 'Show the active wikirc profile.',
  '/config:use': 'Reload session config from a profile.',
  '/mcp:call': 'Call one MCP tool with optional JSON.',
  '/mcp:endpoints': 'Show MCP URLs and token presence.',
  '/mcp:status': 'Show MCP connection status.',
  '/mcp:tools': 'Show discovered MCP tools.',
  '/workspace:init': 'Legacy form of /new.',
  '/wiki:run': 'Use the low-level llm-wiki CLI fallback.',
  '/skill:run': 'Legacy form of /run-skill.',
  '/skill:show': 'Legacy form of /show-skill.',
};

export function createSession() {
  return {
    workspace: null,
    workspacePath: null,
    workspaceEnvFile: null,
    wikirc: null,
    wikircConfig: null,
    language: null,
    mcp: null,
    commands: ['help', 'version', 'exit', 'workspaces', 'new', 'use', 'config', 'status', 'services', 'start', 'stop', 'logs', 'mcp', 'wiki', 'skills', 'show-skill', 'run-skill', 'clear', 'chat'],
    llm: null,
    productionActivity: null,
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

export function promptFor(session) {
  return session.workspace ? `${session.workspace}> ` : 'dot > ';
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
  return {
    inputBuffer: shared.length > prefix.length ? `${base}${shared}` : inputBuffer,
  };
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
  if (command === '/config' && tokenIndex === 1) return ['list', 'status', 'use'];
  if (command === '/config' && previousToken === 'use') return wikircProfileNames(session);
  if (command === '/mcp' && tokenIndex === 1) return ['call', 'endpoints', 'status', 'tools'];
  if (command === '/mcp' && previousToken === 'tools') return mcpNames(session);
  if (command === '/mcp' && previousToken === 'call') return mcpNames(session);
  if (command === '/mcp' && parts[1] === 'call' && tokenIndex === 3) return mcpToolNames(session, parts[2]);
  if (command === '/workspace' && tokenIndex === 1) return ['init'];
  if (command === '/wiki' && tokenIndex === 1) return ['run'];
  if ((command === '/start' || command === '/stop' || command === '/logs') && tokenIndex === 1) return serviceNames();
  if ((command === '/show-skill' || command === '/run-skill') && tokenIndex === 1) return skillNames(session);
  if (command === '/skill' && tokenIndex === 1) return ['run', 'show'];
  if (command === '/skill' && (previousToken === 'run' || previousToken === 'show')) return skillNames(session);
  return [];
}

function toConversationHistory(replMessages, maxExchanges = 6) {
  return replMessages
    .filter((m) => m.role === 'user' || m.role === 'dot')
    .slice(-(maxExchanges * 2))
    .map((m) => ({ role: m.role === 'dot' ? 'assistant' : 'user', content: m.content }));
}

function buildDirectChatSystemPrompt(session) {
  const workspace = session.workspace ?? 'no workspace selected';
  const wikirc = session.wikirc?.profile ?? 'no profile loaded';
  const language = session.language ?? 'en-US';
  return [
    'You are dot, the llm-wiki-manager chat assistant.',
    'Answer directly and concisely. Do not claim to have called tools or changed files.',
    'If the user asks for an action that needs workspace commands, MCP tools, services, files, or mutations, say to ask as an agent action instead of pretending to execute it.',
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
  if (command === '/mcp') return parts[1] === 'call' ? 'Use this MCP server.' : 'Filter tools to this MCP server.';
  if (command === '/skill') return ['run', 'show'].includes(parts[1]) ? 'Select this skill.' : 'Choose a skill action.';
  if (command === '/config') return parts.at(-1) === 'use' ? 'Load this wikirc profile.' : 'Choose a config action.';
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
  const compact = ['> dot'];
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

function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

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
    progress?.currentStep ?? job?.type ?? 'production',
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

function activityText(session) {
  const activity = session.productionActivity;
  if (!activity?.label) return '';
  const color = activity.terminal
    ? activity.status === 'done'
      ? styles.green
      : styles.red
    : styles.cyan;
  return `${color}${truncateAnsi(activity.label, 72)}${styles.reset}`;
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

function renderScreen({ packageJson, session, messages, inputBuffer, busy = false, spinnerFrame = 0, scrollOffset = 0, spinnerLabel = 'Thinking…', activityLines = [] }) {
  const columns = output.columns || 100;
  const rows = output.rows || 30;
  const banner = renderBannerWithMcpPanel(columns, session);
  const completions = busy ? [] : completionLines(inputBuffer, session, columns);
  const visibleCompletions = completions.slice(0, COMPLETION_PANEL_ROWS);
  const completionRows = visibleCompletions.length > 0 ? COMPLETION_PANEL_ROWS : 0;
  const activityRows = LOWER_DETAIL_ROWS - completionRows;
  const activity = renderActivityLines(activityLines, columns, activityRows);
  const productionActivityRows = 1;
  const fixedRows = 4 + banner.length + productionActivityRows + 1 + LOWER_PANEL_ROWS + BOTTOM_PADDING_ROWS;
  const middleHeight = Math.max(5, rows - fixedRows);
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
          : `${styles.green}dot${styles.reset}`;
    const lines = message.role === 'command'
      ? [
        `${label}:`,
        ...wrapText(colorizeCommand(message.content, columns), columns),
      ]
      : wrapText(
        `${label}: ${message.role === 'dot' ? colorizeStatus(message.content) : message.content}`,
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

async function runAgentTurn(input, { agent, session, onUpdate, onStep }) {
  const messages = conversationMessages(session);
  const history = toConversationHistory(messages);
  session._onStep = onStep ?? null;
  session.packageJson = session.packageJson ?? {};
  let agentResult;
  try {
    agentResult = await agent.invoke({ input, session, messages: history });
  } catch (err) {
    delete session._onStep;
    if (err.name === 'AbortError') return { aborted: true };
    throw err;
  } finally {
    delete session._onStep;
  }

  if (agentResult.response != null) {
    messages.push({ role: 'dot', content: stripDsmlArtifacts(agentResult.response) });
    onUpdate?.();
    return {};
  }

  if (agentResult.readyToStream && session.llm?.stream) {
    const dotMessage = { role: 'dot', content: '' };
    messages.push(dotMessage);
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
          dotMessage.content += cleanDelta;
          onUpdate?.();
        }
      }
      dotMessage.content = stripDsmlArtifacts(dotMessage.content).trimEnd();
      if (!dotMessage.content.trim()) {
        dotMessage.content = buildLimitedAgentResponse({ input, session }, 'LLM stream ended without content');
        onUpdate?.();
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        messages.pop();
        return { aborted: true };
      }
      const message = err instanceof Error ? err.message : String(err);
      dotMessage.content = buildLimitedAgentResponse({ input, session }, `LLM indisponible: ${message}`);
      onUpdate?.();
    }
    return {};
  }

  messages.push({ role: 'dot', content: buildLimitedAgentResponse({ input, session }) });
  onUpdate?.();
  return {};
}

export async function runLine(line, { agent, packageJson, session, onUpdate, onStep }) {
  const trimmed = stripHtml(line).trim();
  if (!trimmed) return { exit: false };

  if (trimmed.startsWith('/chat')) {
    const directInput = trimmed.replace(/^\/chat(?:\s+|$)/, '').trim();
    if (!directInput) {
      conversationMessages(session).push({ role: 'command', content: 'Usage: /chat <message>' });
      return { exit: false };
    }
    if (!session.llm?.stream) {
      conversationMessages(session).push({ role: 'command', content: 'Direct chat unavailable: no streaming LLM configured.' });
      return { exit: false };
    }
    const messages = conversationMessages(session);
    const history = toConversationHistory(messages);
    messages.push({ role: 'user', content: directInput });
    onUpdate?.();
    const dotMessage = { role: 'dot', content: '' };
    messages.push(dotMessage);
    onUpdate?.();
    try {
      onStep?.('Chat: streaming direct answer…');
      for await (const delta of session.llm.stream({
        system: buildDirectChatSystemPrompt(session),
        messages: [...history, { role: 'user', content: directInput }],
        signal: session._abortSignal,
      })) {
        const cleanDelta = stripDsmlArtifacts(delta);
        if (cleanDelta) {
          dotMessage.content += cleanDelta;
          onUpdate?.();
        }
      }
      dotMessage.content = stripDsmlArtifacts(dotMessage.content).trimEnd();
      if (!dotMessage.content.trim()) {
        dotMessage.content = buildLimitedAgentResponse({ input: directInput, session }, 'LLM stream ended without content');
        onUpdate?.();
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        messages.pop();
        return { exit: false, aborted: true };
      }
      const message = err instanceof Error ? err.message : String(err);
      dotMessage.content = buildLimitedAgentResponse({ input: directInput, session }, `LLM indisponible: ${message}`);
      onUpdate?.();
    }
    return { exit: false };
  }

  if (trimmed.startsWith('/')) {
    onStep?.(`Shell: ${trimmed}`);
    const result = await handleSlashCommand(trimmed, { packageJson, session, onStep });
    const messages = conversationMessages(session);
    if (result.output) {
      const parts = trimmed.split(/\s+/);
      if (parts[0] === '/mcp' && parts[1] === 'call' && parts[2] === 'production') {
        rememberProductionActivity(session, parseJsonText(result.output));
      }
      messages.push({ role: 'command', content: result.output });
      onUpdate?.();
    }
    if (result.agentTrigger && agent) {
      const agentResult = await runAgentTurn(result.agentTrigger, { agent, session, onUpdate, onStep });
      if (agentResult.aborted) return { exit: false, aborted: true };
    }
    return { exit: Boolean(result.exit) };
  }

  const messages = conversationMessages(session);
  messages.push({ role: 'user', content: trimmed });
  onUpdate?.();
  const agentResult = await runAgentTurn(trimmed, { agent, session, onUpdate, onStep });
  if (agentResult.aborted) return { exit: false, aborted: true };
  return { exit: false };
}

async function runPipeShell({ agent, packageJson, session }) {
  const rl = createInterface({ input, output, prompt: promptFor(session) });
  console.log(`dot  wiki-manager ${packageJson.version}  non-interactive`);
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

async function runTuiShell({ agent, packageJson, session }) {
  const messages = conversationMessages(session);
  messages.push({
    role: 'dot',
    content: [
      'Orchestrator agent ready.',
      '',
      'Load a workspace with `/use <workspace>`, then chat or use commands.',
      'Type `/help` for all commands — `Ctrl+Y` copies the last response.',
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
  let mouseScrollEnabled = true;
  let desiredMouseScrollEnabled = true;
  let mouseSelectionTimer = null;
  let done = false;
  let processing = Promise.resolve();
  let finish;
  const finished = new Promise((resolve) => {
    finish = resolve;
  });

  input.setRawMode(true);
  input.resume();
  output.write('\u001b[?1049h');

  const rerender = () => renderScreen({ packageJson, session, messages: conversationMessages(session), inputBuffer, busy, spinnerFrame, scrollOffset, spinnerLabel, activityLines });
  busy = true;
  spinnerLabel = 'Loading wiki-manager shell...';
  spinnerInterval = setInterval(() => {
    spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
    rerender();
  }, 80);
  rerender();

  try {
    const { output: wsOutput } = await handleSlashCommand('/workspaces', { packageJson, session });
    if (wsOutput) messages.push({ role: 'command', content: wsOutput });
  } finally {
    clearInterval(spinnerInterval);
    spinnerInterval = null;
    busy = false;
    spinnerFrame = 0;
    spinnerLabel = 'Thinking…';
    rerender();
  }

  let productionPollBusy = false;
  const productionPollInterval = setInterval(async () => {
    const activity = session.productionActivity;
    const jobId = activity?.jobId;
    if (!jobId || activity?.terminal || productionPollBusy || session.mcp?.production?.status !== 'connected') return;
    productionPollBusy = true;
    try {
      const result = await callMcpTool(session.mcp, 'production', 'production_job_status', { jobId });
      const payload = parseJsonText(formatMcpToolResult(result));
      if (rememberProductionActivity(session, payload)) rerender();
    } catch {
      // Keep the last known status visible; transient MCP errors should not interrupt typing.
    } finally {
      productionPollBusy = false;
    }
  }, 2500);

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
  setMouseScrollEnabled(true);

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
        : 'Mouse scroll disabled — native text selection restored';
      busy = true;
      rerender();
      setTimeout(() => { spinnerLabel = prevLabel; busy = prevBusy; rerender(); }, 1800);
      return;
    }

    if (key?.ctrl && key.name === 'y') {
      const messages = conversationMessages(session);
      const lastdot = [...messages].reverse().find((m) => m.role === 'dot');
      if (lastdot) {
        const text = stripAnsi(colorizeStatus(lastdot.content)).replace(/\[[0-9;]*m/g, '');
        const clipCmd = process.platform === 'darwin'
          ? { command: 'pbcopy', args: [] }
          : { command: 'xclip', args: ['-selection', 'clipboard'] };
        const { execFileSync } = await import('node:child_process');
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
    if (key?.ctrl && key.name === 'c') {
      if (busy) {
        currentAbortController?.abort();
        spinnerLabel = 'Interrupting…';
        rerender();
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
        const result = await runLine(line, { agent, packageJson, session, onUpdate: rerender, onStep });
        done = result.exit;
        aborted = result.aborted ?? false;
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
  }
}

export async function runShell({ agent, packageJson }) {
  const session = createSession();
  if (!input.isTTY || !output.isTTY) {
    await runPipeShell({ agent, packageJson, session });
    return;
  }
  throw new Error('Interactive TUI requires Bun/OpenTUI. Run: bun ./bin/wiki-manager.js');
}
