import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createLlmClientFromWikiConfig } from '../agent/llm.js';
import { composeServices, listServices, runWikiCli, serviceLogs, serviceStates, startService, stopService } from '../core/compose.js';
import {
  applyMcpRuntimeStatus,
  buildMcpStatus,
  callMcpTool,
  discoverMcpTools,
  formatMcpToolResult,
  formatMcpStatus,
  formatMcpToolSummary,
  formatMcpTools,
} from '../core/mcp.js';
import { createWorkspace, findWorkspace, listWorkspaces } from '../core/workspaces.js';
import { findSkill, listSkills } from '../core/skills.js';
import { formatActivityError, formatActivitySummary } from '../core/activity.js';
import {
  listWikircProfiles,
  loadWikircProfile,
  resolveWikircProfile,
  summarizeWikircConfig,
} from '../core/wikirc.js';

export function printVersion(packageJson) {
  console.log(packageJson.version);
}

const styles = {
  reset: '\u001b[0m',
  cyan: '\u001b[36m',
  bold: '\u001b[1m',
};

function stripAnsi(value) {
  return String(value).replace(/\u001b\[[0-9;]*m/g, '');
}

function padVisible(value, width) {
  const text = String(value);
  return `${text}${' '.repeat(Math.max(0, width - stripAnsi(text).length))}`;
}

function sectionBlock(title, lines = []) {
  return [title, ...lines.map((line) => `  ${line}`)].join('\n');
}

function twoColumns(left, right) {
  const leftLines = String(left || '').split('\n');
  const rightLines = String(right || '').split('\n');
  const rows = Math.max(leftLines.length, rightLines.length);
  const out = [];
  for (let i = 0; i < rows; i += 1) {
    const l = leftLines[i] ?? '';
    const r = rightLines[i] ?? '';
    out.push(r ? `${l}\t${r}` : l);
  }
  return out.join('\n');
}

function commandLabel(value) {
  return `${styles.bold}${styles.cyan}${value}${styles.reset}`;
}

function helpPair(leftCommand, leftText, rightCommand, rightText) {
  const left = `${padVisible(commandLabel(leftCommand), 18)}${leftText}`;
  const right = rightCommand ? `${padVisible(commandLabel(rightCommand), 18)}${rightText}` : '';
  return `  ${padVisible(left, 38)}${right}`;
}

function wikircSummaryText(summary) {
  return [
    `profile=${summary.profile}`,
    `file=${summary.fileName}`,
    `provider=${summary.provider ?? '-'}`,
    `model=${summary.model ?? '-'}`,
    `baseUrl=${summary.baseUrl ?? '-'}`,
    `language=${summary.language ?? '-'}`,
    `apiKey=${summary.hasApiKey ? 'configured' : 'missing'}`,
    `vector=${summary.vectorEnabled ? 'enabled' : 'disabled'}`,
    `embedding=${summary.embeddingModel ?? '-'}`,
  ].join('\n');
}

function toPosixPath(value) {
  return String(value).replace(/\\/g, '/');
}

function walkFiles(rootPath) {
  const files = [];
  if (!rootPath || !existsSync(rootPath)) return files;
  const visit = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolutePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile()) {
        try {
          const stat = statSync(absolutePath);
          files.push({ absolutePath, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch {
          // Ignore files that disappear or cannot be read while status is collected.
        }
      }
    }
  };
  visit(rootPath);
  return files;
}

function markdownFiles(workspacePath, relativeDir) {
  const rootPath = join(workspacePath, relativeDir);
  return walkFiles(rootPath)
    .filter((file) => file.absolutePath.endsWith('.md'))
    .map((file) => ({
      ...file,
      relativePath: toPosixPath(relative(workspacePath, file.absolutePath)),
    }));
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value) {
  if (!Number.isFinite(value) || value <= 0) return '-';
  return new Date(value).toLocaleString();
}

function compactPath(value) {
  const text = String(value ?? '');
  if (!text || text === '-') return '-';
  const normalized = toPosixPath(text).replace(/\/+$/g, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 2) return normalized;
  const prefix = normalized.startsWith('/') ? '/…' : '…';
  return `${prefix}/${parts.slice(-2).join('/')}`;
}

function countIndexLinks(workspacePath) {
  const indexPath = join(workspacePath, 'wiki', 'index.md');
  if (!existsSync(indexPath)) return { exists: false, links: 0 };
  try {
    const raw = readFileSync(indexPath, 'utf8');
    const markdownLinks = raw.match(/\[[^\]]+\]\(([^)]+\.md(?:#[^)]+)?)\)/g) ?? [];
    const wikiLinks = raw.match(/\[\[[^\]]+\]\]/g) ?? [];
    return { exists: true, links: markdownLinks.length + wikiLinks.length };
  } catch {
    return { exists: true, links: 0 };
  }
}

function folderStats(files) {
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const latest = files.reduce((best, file) => (file.mtimeMs > (best?.mtimeMs ?? 0) ? file : best), null);
  const largest = files.reduce((best, file) => (file.size > (best?.size ?? 0) ? file : best), null);
  return { count: files.length, totalBytes, latest, largest };
}

function formatRecentFiles(files, limit = 3) {
  const recent = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
  if (recent.length === 0) return '  recent: -';
  return [
    '  recent:',
    ...recent.map((file) => `    - ${file.relativePath} (${formatBytes(file.size)})`),
  ].join('\n');
}

function collectWorkspaceStats(session) {
  if (!session.workspacePath) return null;
  const workspacePath = session.workspacePath;
  const wiki = markdownFiles(workspacePath, 'wiki');
  const concepts = markdownFiles(workspacePath, join('wiki', 'concepts'));
  const sourceNotes = markdownFiles(workspacePath, join('wiki', 'sources'));
  const answers = markdownFiles(workspacePath, join('wiki', 'answers'));
  const untracked = markdownFiles(workspacePath, join('raw', 'untracked'));
  const ingested = markdownFiles(workspacePath, join('raw', 'ingested'));
  const templates = markdownFiles(workspacePath, 'templates');
  const deliverables = markdownFiles(workspacePath, 'deliverables');
  const logs = walkFiles(join(workspacePath, '.wiki', 'logs'));
  const index = countIndexLinks(workspacePath);
  return {
    wiki: folderStats(wiki),
    concepts: folderStats(concepts),
    sourceNotes: folderStats(sourceNotes),
    answers: folderStats(answers),
    untracked: folderStats(untracked),
    ingested: folderStats(ingested),
    templates: folderStats(templates),
    deliverables: folderStats(deliverables),
    logs: folderStats(logs),
    index,
    untrackedFiles: untracked,
  };
}

function statLine(label, stat) {
  return `${label}: ${stat.count} (${formatBytes(stat.totalBytes)})`;
}

function workspaceStatsText(stats) {
  if (!stats) return 'No workspace loaded.';
  const hints = [];
  if (stats.untracked.count > 0) {
    hints.push(`${stats.untracked.count} raw/untracked document(s) are waiting for ingest.`);
  }
  if (!stats.index.exists) {
    hints.push('wiki/index.md is missing.');
  } else if (stats.index.links === 0) {
    hints.push('wiki/index.md exists but has no markdown/wiki links.');
  }
  if (stats.wiki.count === 0) {
    hints.push('The wiki has no markdown pages yet.');
  }

  const wikiLatest = formatDate(Math.max(
      stats.wiki.latest?.mtimeMs ?? 0,
      stats.concepts.latest?.mtimeMs ?? 0,
      stats.sourceNotes.latest?.mtimeMs ?? 0,
      stats.answers.latest?.mtimeMs ?? 0,
  ));
  const deliverablesLatest = formatDate(Math.max(
      stats.templates.latest?.mtimeMs ?? 0,
      stats.deliverables.latest?.mtimeMs ?? 0,
  ));

  const wikiColumn = sectionBlock(`Wiki content: ${wikiLatest}`, [
    statLine('wiki pages', stats.wiki),
    statLine('concepts', stats.concepts),
    statLine('source notes', stats.sourceNotes),
    statLine('answers', stats.answers),
    `index: ${stats.index.exists ? 'ok' : 'missing'} (${stats.index.links} links)`,
  ]);
  const rawColumn = sectionBlock('Raw sources', [
    statLine('untracked', stats.untracked),
    statLine('ingested', stats.ingested),
    stats.untracked.largest ? `largest: ${stats.untracked.largest.relativePath} (${formatBytes(stats.untracked.largest.size)})` : 'largest: -',
    ...formatRecentFiles(stats.untrackedFiles).split('\n'),
  ]);
  const deliveryColumn = sectionBlock(`Deliverables: ${deliverablesLatest}`, [
    statLine('templates', stats.templates),
    statLine('deliverables', stats.deliverables),
  ]);
  const internalColumn = sectionBlock('Internal', [
    `logs: ${stats.logs.count} (${formatBytes(stats.logs.totalBytes)})`,
  ]);
  const hintsColumn = sectionBlock('Hints', hints.length > 0 ? hints : ['No immediate content action detected.']);

  return [
    twoColumns(wikiColumn, rawColumn),
    '',
    twoColumns(deliveryColumn, `${internalColumn}\n\n${hintsColumn}`),
  ].join('\n');
}

function workspaceLoadedText(workspace, summary, session) {
  return [
    `Workspace: ${workspace.name}`,
    '',
    `Path: ${workspace.workspacePath}`,
    `Env: ${workspace.envFile}`,
    '',
    'Active config',
    '',
    `profile: ${summary.profile}`,
    `file: ${summary.fileName}`,
    `language: ${summary.language ?? '-'}`,
    `provider: ${summary.provider ?? '-'}`,
    `model: ${summary.model ?? '-'}`,
    `baseUrl: ${summary.baseUrl ?? '-'}`,
    `apiKey: ${summary.hasApiKey ? 'configured' : 'missing'}`,
    `vector: ${summary.vectorEnabled ? 'enabled' : 'disabled'}`,
    `embedding: ${summary.embeddingModel ?? '-'}`,
    '',
    'Session',
    '',
    `llm: ${session.llm ? 'configured' : 'missing config'}`,
    `mcp: ${Object.values(session.mcp ?? {}).filter((value) => value.status === 'connected').length} connected`,
  ].join('\n');
}

function workspaceLoadedWithoutConfigText(workspace, message) {
  return [
    `Workspace: ${workspace.name}`,
    '',
    `Path: ${workspace.workspacePath}`,
    `Env: ${workspace.envFile}`,
    '',
    'Active config',
    '',
    `Wikirc not loaded: ${message}`,
  ].join('\n');
}

function serviceStatesText(states) {
  const entries = Object.entries(states ?? {});
  if (entries.length === 0) return 'No running compose services.';
  return entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([service, state]) => `- ${service}: ${state.running ? 'running' : state.state || 'unknown'}`)
    .join('\n');
}

function mcpEndpointsText(mcpStatus) {
  const entries = Object.entries(mcpStatus ?? {});
  if (entries.length === 0) return 'No MCP endpoints configured.';
  return entries
    .map(([name, endpoint]) => {
      const headerNames = Object.keys(endpoint.headers ?? {});
      const auth = headerNames.length > 0
        ? `headers: ${headerNames.join(',')}`
        : `token: ${endpoint.token ? 'configured' : 'missing'}`;
      const url = endpoint.url ?? '-';
      return `${name}\t${url}\t${auth}\tstatus: ${endpoint.status}`;
    })
    .join('\n');
}

function skillsText(session) {
  const skills = listSkills(session);
  if (skills.length === 0) return 'No skills discovered.';
  return skills
    .map((skill) => {
      const description = String(skill.description || 'workflow skill').replace(/\s+/g, ' ').trim();
      const compact = description.length > 96 ? `${description.slice(0, 93)}...` : description;
      return `${skill.name}\t${skill.scope}\t${compact}`;
    })
    .join('\n');
}

function skillDetailText(skill) {
  return [
    `# ${skill.name}`,
    '',
    `Scope: ${skill.scope}`,
    `Path: ${skill.path}`,
    skill.description ? `Description: ${skill.description}` : null,
    skill.params?.length ? `Params: ${skill.params.join(', ')}` : null,
    '',
    skill.body || '_Empty skill body._',
  ].filter(Boolean).join('\n');
}



function buildSkillRunPrompt(skill) {
  return [
    `Execute the "${skill.name}" skill for the current workspace.`,
    'Follow the workflow steps below. Call MCP tools and shell commands as needed for each step.',
    'Report progress as you go. Ask for confirmation before irreversible or costly actions not already defined in the skill.',
    '',
    skill.body || '',
  ].filter(Boolean).join('\n');
}

function skillActionCommand(session, action, name) {
  if (!name) {
    const available = listSkills(session);
    if (!available.length) return { output: `No skills available. Load a workspace with /use first.` };
    const usage = `/skills ${action} <skill>`;
    return { output: `Available skills: ${available.map((s) => s.name).join(', ')}\nUsage: ${usage}` };
  }
  const skill = findSkill(session, name);
  if (!skill) {
    const available = listSkills(session);
    const hint = available.length ? ` Available: ${available.map((s) => s.name).join(', ')}` : '';
    return { output: `Skill not found: ${name}.${hint}` };
  }
  if (action === 'run') {
    return { output: `Skill: ${skill.name} — launching…`, agentTrigger: buildSkillRunPrompt(skill) };
  }
  return { output: skillDetailText(skill) };
}

function skillEditCommand(session, name) {
  if (!name) {
    const available = listSkills(session);
    if (!available.length) return { output: 'No skills available. Load a workspace with /use first.' };
    return { output: `Available skills: ${available.map((s) => s.name).join(', ')}\nUsage: /skills edit <skill>` };
  }
  const skill = findSkill(session, name);
  if (!skill) {
    const available = listSkills(session);
    const hint = available.length ? ` Available: ${available.map((s) => s.name).join(', ')}` : '';
    return { output: `Skill not found: ${name}.${hint}` };
  }
  const openEditor = session._onOpenEditor;
  if (typeof openEditor !== 'function') {
    return { output: `Edit file: ${skill.path}` };
  }
  const content = readFileSync(skill.path, 'utf8');
  const displayPath = session.workspacePath ? relative(session.workspacePath, skill.path) : skill.path;
  openEditor({
    title: `Edit skill: ${skill.name}`,
    filePath: skill.path,
    displayPath,
    content,
    language: skill.path.endsWith('.yaml') || skill.path.endsWith('.yml') ? 'yaml' : 'markdown',
  });
  return { output: `Editing ${displayPath}` };
}

async function createWorkspaceCommand(context, workspaceName, targetPath) {
  if (!workspaceName) {
    return {
      output: [
        'Usage: /new <name> [path]',
        '',
        'Creates/configures a new workspace through wiki-workspace config.',
        'Legacy form: /workspace init <name> [path].',
        'For llm-wiki init inside the current workspace, use /wiki run init.',
      ].join('\n'),
    };
  }
  try {
    context.onStep?.(`Workspace: creating ${workspaceName}…`);
    const output = await createWorkspace(workspaceName, targetPath, { timeout: 600_000 });
    return {
      output: [
        output,
        '',
        `Workspace created: ${workspaceName}`,
        `Use /use ${workspaceName} to load it.`,
      ].filter(Boolean).join('\n'),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { output: message };
  }
}

function formatMcpCallActivity(serverName, toolName, resultText) {
  if (serverName === 'production') return null;
  return formatActivitySummary(serverName, toolName, resultText);
}

async function refreshMcpRuntimeStatus(session) {
  session.mcp = buildMcpStatus(session);
  if (!session.workspacePath) return null;
  try {
    const states = await serviceStates(session);
    session.mcp = applyMcpRuntimeStatus(session.mcp, states);
    session.mcp = await discoverMcpTools(session.mcp);
    return states;
  } catch {
    session.mcp = await discoverMcpTools(session.mcp);
    return null;
  }
}

async function statusText(session) {
  const states = await refreshMcpRuntimeStatus(session);
  const services = session.workspacePath
    ? await composeServices(session).catch(() => [])
    : [];
  const workspaceStats = collectWorkspaceStats(session);
  const workspaceColumn = sectionBlock('Workspace', [
    `workspace: ${session.workspace ?? '-'}`,
    `path: ${compactPath(session.workspacePath ?? '-')}`,
    `env: ${compactPath(session.workspaceEnvFile ?? '-')}`,
  ]);
  const configColumn = sectionBlock('Config', [
    `wikirc: ${session.wikirc?.profile ?? '-'}${session.wikirc?.fileName ? ` (${session.wikirc.fileName})` : ''}`,
    `language: ${session.language ?? '-'}`,
    `llm: ${session.llm ? 'configured' : 'missing'}`,
    `provider: ${session.wikircConfig?.llm?.provider ?? '-'}`,
    `model: ${session.wikircConfig?.llm?.model ?? '-'}`,
    `baseUrl: ${session.wikircConfig?.llm?.baseUrl ?? '-'}`,
  ]);
  const servicesColumn = sectionBlock('Services', services.length > 0
    ? services.map((service) => `- ${service}`)
    : ['No workspace loaded.']);
  const runtimeColumn = sectionBlock('Runtime', (states ? serviceStatesText(states) : 'Docker runtime not available or no workspace loaded.').split('\n'));
  const mcpColumn = sectionBlock('MCP', formatMcpStatus(session.mcp).split('\n'));
  const mcpToolsColumn = sectionBlock('MCP tool summary', formatMcpToolSummary(session.mcp).split('\n'));

  return [
    twoColumns(workspaceColumn, configColumn),
    '',
    workspaceStatsText(workspaceStats),
    '',
    twoColumns(servicesColumn, runtimeColumn),
    '',
    twoColumns(mcpColumn, mcpToolsColumn),
  ].join('\n');
}

function loadWorkspaceSystemPrompt(workspacePath) {
  const promptPath = join(workspacePath, '.wiki', 'system-prompt.md');
  return existsSync(promptPath) ? readFileSync(promptPath, 'utf8').trim() || null : null;
}

function loadSessionWikirc(session, profileName = 'default') {
  if (!session.workspacePath) {
    throw new Error('No workspace loaded. Use /use <workspace>.');
  }
  const loaded = loadWikircProfile(session.workspacePath, profileName);
  session.wikirc = {
    profile: loaded.profile.name,
    fileName: loaded.profile.fileName,
    path: loaded.profile.path,
  };
  session.wikircConfig = loaded.config;
  session.language = loaded.config?.language ?? null;
  session.llm = createLlmClientFromWikiConfig(loaded.config);
  if (session.mcp?.production) {
    session.mcp.production.activeConfigPath = loaded.profile.fileName;
  }
  return summarizeWikircConfig(loaded.profile, loaded.config);
}

export function helpText(packageJson) {
  return `wiki-manager ${packageJson.version}

Agent-first shell and orchestration cockpit for llm-wiki workspaces.

Usage:
  wiki-manager [options]

Options:
  -v, --version        Print version
  -h, --help           Print help
  --once <prompt>      Run one agent turn and exit
  --headless           Run a workspace task non-interactively
  --workspace <name>   Workspace for --headless
  --skill <name>       Skill to run in --headless (implies --wait)
  --prompt <text>      Task or extra instruction for --headless
  --log-file <path>    Optional headless log path
  --wait               Wait for active jobs to complete after agent turn (--prompt only)
  --no-wait            Disable agentic loop for --skill (single turn)
  --timeout <seconds>  Per-wave job wait timeout in seconds (default: 3600)
  --max-turns <n>      Max agent turns in agentic loop (default: 20)

Interactive shell:
${helpPair('/help', 'Help', '/version', 'Version')}
${helpPair('/workspaces', 'Workspaces', '/new <n> [path]', 'New workspace')}
${helpPair('/use <workspace>', 'Use workspace', '/status', 'Session status')}
${helpPair('/config list', 'Config profiles', '/config use <n>', 'Use config')}
${helpPair('/config edit <n>', 'Edit config', '/config status', 'Active config')}
${helpPair('/services', 'Services', '/start [service]', 'Start service(s)')}
${helpPair('/stop [service]', 'Stop service(s)', '/logs <service>', 'Service logs')}
${helpPair('/skills', 'List skills', '/skills show <n>', 'Show skill')}
${helpPair('/skills run <n>', 'Run skill guide', '/skills edit <n>', 'Edit skill')}
${helpPair('/mcp status', 'MCP status', '/mcp endpoints', 'MCP endpoints')}
${helpPair('/mcp tools [mcp]', 'MCP tools', '/mcp call ...', 'Call MCP tool')}
${helpPair('/wiki', 'Run wiki index', '/wiki run <args>', 'Raw wiki CLI')}
${helpPair('/chat', 'Chat mode', '/agent', 'Agent mode')}
${helpPair('/openui', 'Open web UI in browser', '', '')}
${helpPair('/clear', 'Clear screen', '/exit', 'Exit')}
${helpPair('Ctrl+Y', 'Copy last reply', '', '')}
${helpPair('PgUp/PgDn', 'Scroll thread', 'Ctrl+C Ctrl+C', 'Exit')}

Modes:
  Default startup mode is chat: free text is sent directly to the LLM without tools.
  Use /agent to route free text to the LangGraph orchestrator with MCP tools.
  Use /chat to return to direct LLM chat mode.

Status:
  Agent-first shell is installed with workspace services, MCP calls, wiki CLI, skill discovery, and headless runs.
  Shell UI is English. Agent exchange language is read from the active .wikirc.yaml.
  LLM config is intentionally workspace-scoped and will be read from .wikirc.yaml after /use <workspace>.
  Headless mode supports one-shot workspace prompts and skill runs with log output.
`;
}

export function printHelp(packageJson) {
  console.log(helpText(packageJson));
}

export async function handleSlashCommand(line, context) {
  const args = line.slice(1).trim().split(/\s+/).filter(Boolean);
  const [command] = args;
  const step = context.onStep ?? (() => {});

  switch (command) {
    case '':
    case 'help':
      return { output: helpText(context.packageJson) };
    case 'version':
      return { output: context.packageJson.version };
    case 'chat':
      context.session.chatMode = true;
      return { setMode: 'chat', output: 'Mode: chat' };
    case 'agent':
      context.session.chatMode = false;
      return { setMode: 'agent', output: 'Mode: agent' };
    case 'workspaces': {
      const workspaces = listWorkspaces();
      if (workspaces.length === 0) {
        return { output: 'No workspace configured.' };
      }
      return {
        output: workspaces
          .map((workspace) => `${workspace.name}\t${workspace.workspacePath}`)
          .join('\n'),
      };
    }
    case 'status': {
      step('Shell: refreshing workspace, services and MCP status…');
      return { output: await statusText(context.session) };
    }
    case 'use': {
      const workspaceName = args[1];
      if (!workspaceName) {
        return { output: 'Usage: /use <workspace>' };
      }
      const workspace = findWorkspace(workspaceName);
      if (!workspace) {
        return { output: `Workspace not found: ${workspaceName}` };
      }
      context.session.workspace = workspace.name;
      context.session.workspacePath = workspace.workspacePath;
      context.session.workspaceEnv = workspace.env;
      context.session.workspaceEnvFile = workspace.envFile;
      context.session.mcp = buildMcpStatus(context.session);
      context.session.systemPrompt = loadWorkspaceSystemPrompt(workspace.workspacePath);
      try {
        step(`Workspace: loading ${workspace.name} config…`);
        const summary = loadSessionWikirc(context.session, 'default');
        step(`Workspace: discovering ${workspace.name} MCP tools…`);
        await refreshMcpRuntimeStatus(context.session);
        return {
          output: workspaceLoadedText(workspace, summary, context.session),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          output: workspaceLoadedWithoutConfigText(workspace, message),
        };
      }
    }
    case 'config': {
      const subcommand = args[1] ?? 'status';
      if (!context.session.workspacePath) {
        return { output: 'No workspace loaded. Use /use <workspace>.' };
      }
      if (subcommand === 'list') {
        const profiles = listWikircProfiles(context.session.workspacePath);
        if (profiles.length === 0) {
          return { output: 'No .wikirc.yaml profile found in the workspace.' };
        }
        const active = context.session.wikirc?.profile;
        return {
          output: profiles
            .map((profile) => {
              const marker = profile.name === active ? '*' : ' ';
              return `${marker} ${profile.name}\t${profile.fileName}`;
            })
            .join('\n'),
        };
      }
      if (subcommand === 'use') {
        const profileName = args[2];
        if (!profileName) {
          return { output: 'Usage: /config use <default|name>' };
        }
        try {
          const summary = loadSessionWikirc(context.session, profileName);
          return {
            output: [
              'Active wikirc:',
              wikircSummaryText(summary),
              context.session.llm ? 'LLM session: reinitialized' : 'LLM session: missing config',
            ].join('\n'),
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { output: message };
        }
      }
      if (subcommand === 'edit') {
        const profileName = args[2];
        if (!profileName) {
          const profiles = listWikircProfiles(context.session.workspacePath);
          const available = profiles.map((profile) => profile.name).join(', ') || 'none';
          return { output: `Usage: /config edit <profile>\nAvailable profiles: ${available}` };
        }
        try {
          const profile = resolveWikircProfile(context.session.workspacePath, profileName);
          const content = readFileSync(profile.path, 'utf8');
          const openEditor = context.session._onOpenEditor;
          if (typeof openEditor !== 'function') {
            return { output: `Edit file: ${profile.path}` };
          }
          openEditor({
            title: `Edit wikirc: ${profile.name}`,
            filePath: profile.path,
            displayPath: profile.fileName,
            content,
            language: 'yaml',
          });
          return { output: `Editing ${profile.fileName}` };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { output: message };
        }
      }
      if (subcommand === 'status') {
        if (!context.session.wikirc || !context.session.wikircConfig) {
          return { output: 'No active wikirc profile.' };
        }
        const summary = {
          ...summarizeWikircConfig(
            {
              name: context.session.wikirc.profile,
              path: context.session.wikirc.path,
            },
            context.session.wikircConfig,
          ),
          fileName: context.session.wikirc.fileName,
        };
        return { output: wikircSummaryText(summary) };
      }
      return { output: 'Usage: /config <list|use|edit|status>' };
    }
    case 'services': {
      try {
        step('Services: reading compose state…');
        await refreshMcpRuntimeStatus(context.session);
        return { output: await listServices(context.session) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        step(formatActivityError('services', 'list', err));
        return { output: message };
      }
    }
    case 'start': {
      const service = args[1];
      try {
        step(`Services: starting ${service ?? 'workspace services'}…`);
        const output = await startService(context.session, service);
        step('Services: refreshing MCP runtime…');
        await refreshMcpRuntimeStatus(context.session);
        return { output };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        step(formatActivityError('services', 'stop', err));
        return { output: message };
      }
    }
    case 'stop': {
      const service = args[1];
      try {
        step(`Services: stopping ${service ?? 'workspace services'}…`);
        const output = await stopService(context.session, service);
        step('Services: refreshing MCP runtime…');
        await refreshMcpRuntimeStatus(context.session);
        return { output };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        step(formatActivityError('services', 'logs', err));
        return { output: message };
      }
    }
    case 'logs': {
      const service = args[1];
      const tail = args[2] ? Number(args[2]) : 120;
      try {
        step(`Services: reading logs for ${service ?? 'service'}…`);
        return { output: await serviceLogs(context.session, service, { tail }) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { output: message };
      }
    }
    case 'mcp': {
      const subcommand = args[1] ?? 'status';
      step('MCP: refreshing endpoints and tools…');
      await refreshMcpRuntimeStatus(context.session);
      if (subcommand === 'status') {
        return { output: formatMcpStatus(context.session.mcp) };
      }
      if (subcommand === 'endpoints') {
        return { output: mcpEndpointsText(context.session.mcp) };
      }
      if (subcommand === 'tools') {
        const filterName = args[2] ?? null;
        if (filterName && !context.session.mcp?.[filterName]) {
          return { output: `Unknown MCP: ${filterName}` };
        }
        return { output: formatMcpTools(context.session.mcp, filterName) };
      }
      if (subcommand === 'call') {
        const serverName = args[2];
        const toolName = args[3];
        if (!serverName || !toolName) {
          return { output: 'Usage: /mcp call <mcp> <tool> [json]' };
        }
        try {
          const rawArgs = args.slice(4).join(' ');
          const toolArgs = rawArgs ? JSON.parse(rawArgs) : {};
          step(`MCP: calling ${serverName}.${toolName}…`);
          const result = await callMcpTool(context.session.mcp, serverName, toolName, toolArgs);
          const output = formatMcpToolResult(result);
          const activity = formatMcpCallActivity(serverName, toolName, output);
          if (activity) step(activity);
          return { output };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          step(formatActivityError(serverName, toolName, err));
          return { output: message };
        }
      }
      return { output: 'Usage: /mcp <status|endpoints|tools|call> [mcp]' };
    }
    case 'new': {
      return createWorkspaceCommand(context, args[1], args[2] ?? null);
    }
    case 'workspace': {
      const subcommand = args[1];
      if (subcommand !== 'init') {
        return { output: 'Usage: /new <name> [path]\nLegacy: /workspace init <name> [path]' };
      }
      return createWorkspaceCommand(context, args[2], args[3] ?? null);
    }
    case 'wiki': {
      const subcommand = args[1];
      if (!subcommand) {
        try {
          step('Wiki: running index…');
          const output = await runWikiCli(context.session, ['index'], {
            timeout: 600_000,
            onOutput: (line) => step(`Wiki: ${line}`),
          });
          const activity = formatActivitySummary('wiki', 'index', output);
          if (activity) step(activity);
          return { output };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          step(formatActivityError('wiki', 'index', err));
          return { output: message };
        }
      }
      try {
        if (subcommand === 'run') {
          const wikiArgs = args.slice(2);
          if (wikiArgs.length === 0) return { output: 'Usage: /wiki run <args...>' };
          step(`Wiki: running ${wikiArgs.join(' ')}…`);
          const output = await runWikiCli(context.session, wikiArgs, {
            onOutput: (line) => step(`Wiki: ${line}`),
          });
          const activity = formatActivitySummary('wiki', wikiArgs[0] ?? 'run', output);
          if (activity) step(activity);
          return { output };
        }
        return {
          output: [
            `/${command} ${subcommand} is not a direct shell primitive.`,
            subcommand === 'init' ? 'Use /workspace init <name> [path] to create a new workspace, or /wiki run init for the explicit current-workspace init hatch.' : null,
            subcommand === 'index' ? 'Use /wiki for index, or /wiki run index for the explicit backup hatch.' : null,
            'Use the MCP production agent for ingest/build/export/polish/pipeline actions.',
            'Diagnostics stay behind the explicit hatch: /wiki run doctor.',
          ].filter(Boolean).join('\n'),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        step(formatActivityError('wiki', subcommand ?? 'run', err));
        return { output: message };
      }
    }
    case 'skills': {
      if (args[1] === 'show') {
        return skillActionCommand(context.session, 'show', args[2]);
      }
      if (args[1] === 'run') {
        return skillActionCommand(context.session, 'run', args[2]);
      }
      if (args[1] === 'edit') {
        return skillEditCommand(context.session, args[2]);
      }
      if (args[1] && args[1] !== 'list') {
        return { output: 'Usage: /skills [list|show|run|edit] [skill]' };
      }
      return { output: skillsText(context.session) };
    }
    case 'openui': {
      const port = context.session.workspaceEnv?.WIKI_SERVE_PORT ?? '3100';
      const url = `http://localhost:${port}`;
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
      try {
        execFileSync(opener, [url], { stdio: 'ignore' });
        return { output: `Opening web UI: ${url}` };
      } catch {
        return { output: `Web UI: ${url}` };
      }
    }
    case 'clear': {
      const key = context.session.workspace || '__global__';
      context.session.conversations[key] = [];
      return { output: null };
    }
    case 'exit':
    case 'quit':
      return { exit: true };
    default:
      return {
        output: `Unknown command: /${command}\nUse /help to see available commands.`,
      };
  }
}
