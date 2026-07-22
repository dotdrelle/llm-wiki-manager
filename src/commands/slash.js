import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
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
import { extractActivity, formatActivityError, formatActivityLine, formatActivitySummary, parseJsonText } from '../core/activity.js';
import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import {
  cancelQueueItem,
  clearFinishedQueueItems,
  enqueueProductionJob,
  formatQueue,
  productionLockBusy,
} from '../core/jobQueue.js';
import {
  listWikircProfiles,
  resolveWikircProfile,
  summarizeWikircConfig,
} from '../core/wikirc.js';
import { applySessionWikircProfile } from '../core/sessionConfig.js';
import {
  deleteWorkspaceAndFiles,
  finalizeCreatedWorkspace,
  startAgents,
  stopAgents,
} from '../core/wikiSetup.js';
import {
  cleanDocumentUploads,
  convertPendingDocumentUploads,
  convertStoredDocument,
  formatUploadRecord,
  listDocumentUploads,
  storeAndMaybeConvertDocument,
} from '../core/documentIntake.js';
import { fetchRuntimeState, postRuntimeCancel, postRuntimeControl, postRuntimeKill, postRuntimeRun } from '../runtime/client.js';
import { versionWithBuild } from '../core/buildInfo.js';

export function printVersion(packageJson) {
  console.log(versionWithBuild(packageJson));
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

function workspaceStatsColumns(stats) {
  if (!stats) return { left: 'No workspace loaded.', right: '' };
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

  return {
    left: [wikiColumn, deliveryColumn].join('\n\n'),
    right: [rawColumn, internalColumn, hintsColumn].join('\n\n'),
  };
}

function workspaceLoadedText(workspace, summary, session) {
  const profiles = listWikircProfiles(workspace.workspacePath);
  const profileLines = profiles.length > 0
    ? profiles.map((profile) => {
        const marker = profile.name === summary.profile ? '*' : ' ';
        return `${marker} ${profile.name}\t${profile.fileName}`;
      })
    : ['No .wikirc.yaml profile found.'];
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
    'Available configs',
    '',
    ...profileLines,
    '',
    `Switch config: /config use <profile>`,
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
    `The user asked to run the "${skill.name}" skill for the current workspace.`,
    'First explain concisely, in the user language, what will be launched and its intended outcome.',
    'Do not quote, reproduce, or display the raw skill content.',
    'Then execute the workflow, using the available tools when required.',
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
    return {
      output: JSON.stringify({ operation: 'run-skill', skill: skill.name }),
      rawOutput: true,
      agentTrigger: buildSkillRunPrompt(skill),
    };
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
        'Creates and registers a workspace via wiki-workspace config.',
        'For llm-wiki init inside the current workspace, use /wiki run init.',
      ].join('\n'),
    };
  }
  try {
    context.onStep?.(`Workspace: creating ${workspaceName}…`);
    const output = await createWorkspace(workspaceName, targetPath, { timeout: 600_000 });
    finalizeCreatedWorkspace(workspaceName);
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

function publishPayloadActivity(session, payload, context = {}) {
  const activity = extractActivity(payload, context);
  if (!activity) return null;
  dispatchAgentEvent(session, createAgentEvent('activity_upserted', {
    origin: context.server ?? 'mcp',
    payload: { activity },
  }));
  return formatActivityLine(activity);
}

function publishDocumentActivity(session, activity) {
  if (!activity) return null;
  return publishPayloadActivity(session, { _activity: activity }, { server: 'documents', tool: 'documents_convert_to_markdown' });
}

export async function refreshMcpRuntimeStatus(session) {
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
  const runtimeColumn = sectionBlock('Runtime', (states ? serviceStatesText(states) : 'Docker runtime not available or no workspace loaded.').split('\n'));
  const mcpColumn = sectionBlock('MCP', formatMcpStatus(session.mcp).split('\n'));
  const mcpToolsColumn = sectionBlock('MCP tool summary', formatMcpToolSummary(session.mcp).split('\n'));
  const stats = workspaceStatsColumns(workspaceStats);

  const leftColumn = [workspaceColumn, stats.left, runtimeColumn, mcpColumn].filter(Boolean).join('\n\n');
  const rightColumn = [configColumn, stats.right, mcpToolsColumn].filter(Boolean).join('\n\n');

  // Leading/trailing padding row on *both* columns so the boxed pair doesn't
  // butt directly against the pane border when the view is scrolled to show
  // the tail. A single space on each side (not '') keeps the row tab-joined,
  // so both the left and right box render — an empty string on either side
  // of the tab makes twoColumns drop the pairing and only the left box shows.
  const pad = ' \t ';
  return [pad, twoColumns(leftColumn, rightColumn), pad].join('\n');
}

function loadWorkspaceSystemPrompt(workspacePath) {
  const promptPath = join(workspacePath, '.wiki', 'system-prompt.md');
  return existsSync(promptPath) ? readFileSync(promptPath, 'utf8').trim() || null : null;
}

function clearWorkspaceSession(session) {
  session.workspace = null;
  session.workspacePath = null;
  session.workspaceEnv = null;
  session.workspaceEnvFile = null;
  session.wikirc = null;
  session.wikircConfig = null;
  session.language = null;
  session.llm = null;
  session.mcp = null;
  session.systemPrompt = null;
}

function formatWorkspaceList(workspaces, session = null) {
  if (workspaces.length === 0) return 'No workspace configured.';
  return [
    'Workspaces',
    '',
    ...workspaces.flatMap((workspace) => {
      const active = workspace.name === session?.workspace ? 'active' : 'available';
      return [
        `${workspace.name}\t${active}`,
        `  path\t${workspace.workspacePath}`,
        `  use\t/use ${workspace.name}`,
        `  delete\t/workspace delete ${workspace.name}`,
        '',
      ];
    }),
  ].join('\n').trimEnd();
}

function workspaceDeletePrompt(workspaces) {
  if (workspaces.length === 0) return 'No workspace configured.';
  return [
    'Delete a workspace:',
    ...workspaces.map((workspace) => `  /workspace delete ${workspace.name}\t${workspace.workspacePath}`),
    '',
    'The next step asks for confirmation before deleting files.',
  ].join('\n');
}

export function helpText(packageJson) {
  return `wiki-manager ${packageJson.version}

Agent-first shell and orchestration cockpit for llm-wiki workspaces.

Usage:
  wiki-manager [options]

Options:
  -v, --version        Print version
  -h, --help           Print help
  --cacert <path>      Trust a local CA; Docker must be able to read this host path
  --once <prompt>      Run one agent turn and exit
  --headless           Run a workspace task non-interactively
  --workspace <name>   Initial workspace (interactive or --headless)
  --skill <name>       Skill to run in --headless (implies --wait)
  --prompt <text>      Task or extra instruction for --headless
  --log-file <path>    Optional headless log path
  --wait               Wait for active jobs to complete after agent turn (--prompt only)
  --no-wait            Disable agentic loop for --skill (single turn)
  --timeout <seconds>  Per-wave job wait timeout in seconds (default: 3600)
  --max-turns <n>      Max agent turns in agentic loop (default: 20)

Interactive shell:
${helpPair('/help', 'Help', '/version', 'Version')}
${helpPair('/workspace list', 'Workspaces', '/new <n> [path]', 'New workspace')}
${helpPair('/use <workspace>', 'Use workspace', '/status', 'Session status')}
${helpPair('/config list', 'Config profiles', '/config use <n>', 'Use config')}
${helpPair('/config edit <n>', 'Edit config', '/workspace delete <n>', 'Delete workspace')}
${helpPair('/services', 'Services', '/start [all|service|agents]', 'Start service(s)')}
${helpPair('/stop [all|service|agents]', 'Stop service(s)', '/logs <service>', 'Service logs')}
${helpPair('/skills', 'List skills', '/skills show <n>', 'Show skill')}
${helpPair('/skills run <n>', 'Run skill guide', '/skills edit <n>', 'Edit skill')}
${helpPair('/mcp status', 'MCP status', '/mcp endpoints', 'MCP endpoints')}
${helpPair('/mcp tools [mcp]', 'MCP tools', '/mcp call ...', 'Call MCP tool')}
${helpPair('/upload <path>', 'Upload document', '/uploads', 'Uploaded docs')}
${helpPair('/upload convert pending', 'Convert pending', '/uploads clean', 'Clean uploads')}
${helpPair('/wiki', 'Run wiki index', '/wiki run <args>', 'Raw wiki CLI')}
${helpPair('/chat', 'Chat mode', '/agent [question]', 'Agent mode / one-shot')}
${helpPair('/openui', 'Open web UI in browser', '', '')}
${helpPair('/run status', 'Runtime status', '/run kill', 'Kill runtime run(s)')}
${helpPair('/run capability <id>', 'Deterministic capability run', '/approve', 'Grant pending approval')}
${helpPair('/cancel', 'Cancel active run', '', '')}
${helpPair('/run cancel', 'Cancel active run', '', '')}
${helpPair('/queue', 'MCP job queue', '/queue clear', 'Clear finished')}
${helpPair('/queue cancel <id>', 'Cancel queued/running', '', '')}
${helpPair('/clear', 'Clear screen', '/clear --all', 'Reset run+plan+queue+logs')}
${helpPair('/exit', 'Exit', '', '')}
${helpPair('Ctrl+Y', 'Copy last reply', '', '')}
${helpPair('PgUp/PgDn', 'Scroll thread', 'Ctrl+C Ctrl+C', 'Exit')}

Modes:
  Default startup mode is chat: free text is sent directly to the LLM without tools.
  Use /agent to route free text to the LangGraph orchestrator with MCP tools.
  Use /chat to return to direct LLM chat mode.

Status:
  Agent-first shell is installed with workspace services, MCP calls, wiki CLI, skill discovery, and headless runs.
  Shell UI is English. Agent exchange language is read from the active .wikirc.yaml.
  LLM config is intentionally workspace-scoped and is read from .wikirc.yaml after /use <workspace>.
  Headless mode supports one-shot workspace prompts and skill runs with log output.
`;
}

export function printHelp(packageJson) {
  console.log(helpText(packageJson));
}

function rawCommandAgentPrompt(command, output) {
  return [
    `L'utilisateur a lancé la commande shell ${command}.`,
    'Voici la sortie brute collectée par la commande déterministe. Ne relance pas la commande et ne modifie pas les données.',
    'Réponds à l’utilisateur à partir de ces faits, en appliquant le profil workspace et les préférences de présentation déjà chargés dans ton prompt système.',
    '',
    'Sortie brute:',
    '```text',
    output || '(empty)',
    '```',
  ].join('\n');
}

function rawCommandResult(command, output) {
  return {
    output,
    rawOutput: true,
    agentTrigger: rawCommandAgentPrompt(command, output),
  };
}

// Shared by every deterministic command that can trigger an on-demand
// `docker pull` (agents up, service start): reports the images as they're
// found missing and hands back the final list for localizedOperationResult.
async function collectMissingImages(step, fn) {
  let missingImages = [];
  await fn({
    onImagesMissing: (images) => {
      missingImages = images;
      step(`Donna: downloading and installing missing components: ${images.join(', ')}…`);
    },
  });
  return missingImages;
}

function componentInstallAction(missingImages) {
  return missingImages.length > 0 ? 'downloaded-and-installed-missing-components' : null;
}

export function localizedOperationResult({ operation, target, status = 'succeeded', componentAction = null, images = [] }) {
  const facts = JSON.stringify({
    operation,
    target,
    status,
    ...(componentAction ? { componentAction, images } : {}),
  });
  return {
    output: facts,
    rawOutput: true,
    agentTrigger: [
      'Formule le résultat structuré suivant dans la langue et le ton demandés par le profil du workspace.',
      'Réponds par une seule phrase humaine et naturelle.',
      'Ne mentionne aucune commande, syntaxe shell, étape suivante ou détail technique.',
      `Résultat: ${facts}`,
    ].join('\n'),
  };
}

function formatRuntimeRunStatus(state) {
  const status = state?.status ?? 'unknown';
  const runId = state?.runId ? ` run=${state.runId}` : '';
  const queued = Array.isArray(state?.controlQueue)
    ? state.controlQueue.filter((item) => item.status === 'queued').length
    : 0;
  const tasks = Array.isArray(state?.workflow?.nodes)
    ? state.workflow.nodes.filter((node) => node.type === 'task' && !['done', 'failed', 'cancelled'].includes(String(node.status))).length
    : 0;
  return `runtime: ${status}${runId} · queued=${queued} · activeTasks=${tasks}`;
}

function runtimeManagedItemId(context, id) {
  const runtimeState = typeof context.runtimeState === 'function' ? context.runtimeState() : context.runtimeState;
  const states = [runtimeState, context.session].filter(Boolean);
  return states.some((state) =>
    runtimeQueueMatches(state, id)
    || runtimeWorkflowMatches(state.workflow, id));
}

function runtimeQueueMatches(state, id) {
  return Array.isArray(state?.queue) && state.queue.some((item) => String(item.id) === String(id));
}

function runtimeWorkflowMatches(workflow, id) {
  if (!workflow || typeof workflow !== 'object') return false;
  const target = String(id);
  return (Array.isArray(workflow.nodes) && workflow.nodes.some((node) => String(node.id) === target || String(node.itemId ?? node.taskId ?? '') === target))
    || (Array.isArray(workflow.relations) && workflow.relations.some((relation) => String(relation.from) === target || String(relation.to) === target));
}

export async function handleSlashCommand(line, context) {
  const args = line.slice(1).trim().split(/\s+/).filter(Boolean);
  const [command] = args;
  const step = context.onStep ?? (() => {});
  const runAgentCommand = async (fn, verb) => {
    try {
      step(`Agents: ${verb}ing external agents…`);
      const missingImages = await collectMissingImages(step, fn);
      return localizedOperationResult({
        operation: verb,
        target: 'agents',
        componentAction: componentInstallAction(missingImages),
        images: missingImages,
      });
    } catch (err) {
      step(formatActivityError('agents', verb, err));
      return { output: err instanceof Error ? err.message : String(err) };
    }
  };

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
    case 'status': {
      step('Shell: refreshing workspace, services and MCP status…');
      return { output: await statusText(context.session) };
    }
    case 'use': {
      const workspaceName = args[1];
      if (!workspaceName) {
        return { output: formatWorkspaceList(listWorkspaces(), context.session) };
      }
      if (args[2]) {
        return { output: 'Usage: /use <workspace>' };
      }
      const workspace = findWorkspace(workspaceName);
      if (!workspace) {
        return { output: `Workspace not found: ${workspaceName}` };
      }
      clearWorkspaceSession(context.session);
      context.session.workspace = workspace.name;
      context.session.workspacePath = workspace.workspacePath;
      context.session.workspaceEnv = workspace.env;
      context.session.workspaceEnvFile = workspace.envFile;
      context.session.systemPrompt = loadWorkspaceSystemPrompt(workspace.workspacePath);
      try {
        step(`Workspace: loading ${workspace.name} config…`);
        const { summary } = applySessionWikircProfile(context.session, 'default');
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
          const { summary } = applySessionWikircProfile(context.session, profileName);
          await refreshMcpRuntimeStatus(context.session);
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
        const output = await listServices(context.session);
        return rawCommandResult('/services', output);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        step(formatActivityError('services', 'list', err));
        return { output: message };
      }
    }
    case 'start': {
      // 'all' already resolves correctly through serviceAliases() (DEFAULT_SERVICE_ALIASES.all
      // = COMPOSE_SERVICES, overridable via docker-compose.yml's service-aliases.all.targets) —
      // do not remap it to undefined, that bypasses any custom "all" target list and always
      // falls back to the hardcoded COMPOSE_SERVICES constant instead.
      const service = args[1];
      if (service === 'agents' || service === 'agent') return runAgentCommand(startAgents, 'start');
      try {
        step(`Services: starting ${service ?? 'workspace services'}…`);
        const missingImages = await collectMissingImages(step, (opts) => startService(context.session, service, opts));
        step('Services: refreshing MCP runtime…');
        await refreshMcpRuntimeStatus(context.session);
        return localizedOperationResult({
          operation: 'start',
          target: service || 'workspace-services',
          componentAction: componentInstallAction(missingImages),
          images: missingImages,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        step(formatActivityError('services', 'stop', err));
        return { output: message };
      }
    }
    case 'stop': {
      const service = args[1];
      if (service === 'agents') return runAgentCommand(stopAgents, 'stop');
      try {
        step(`Services: stopping ${service ?? 'workspace services'}…`);
        await stopService(context.session, service);
        step('Services: refreshing MCP runtime…');
        await refreshMcpRuntimeStatus(context.session);
        return localizedOperationResult({
          operation: 'stop',
          target: service || 'workspace-services',
        });
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
        const output = await serviceLogs(context.session, service, { tail });
        return rawCommandResult(`/logs ${[service, args[2]].filter(Boolean).join(' ')}`.trim(), output);
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
          let toolArgs = rawArgs ? JSON.parse(rawArgs) : {};
          if (serverName === 'production' && toolName === 'production_start_job' && context.session.workspace && !toolArgs.callerLabel) {
            toolArgs = { ...toolArgs, callerLabel: `${context.session.workspace}/wiki-manager` };
          }
          if (serverName === 'production' && toolName === 'production_start_job' && productionLockBusy(context.session)) {
            const item = enqueueProductionJob(context.session, toolArgs, 'production lock busy');
            return { output: `Queued ${item.id}: waiting ${item.workspace ?? 'no-workspace'} ${item.tool}` };
          }
          step(`MCP: calling ${serverName}.${toolName}…`);
          const result = await callMcpTool(context.session.mcp, serverName, toolName, toolArgs);
          const output = formatMcpToolResult(result);
          const payload = parseJsonText(output);
          if (serverName === 'production' && toolName === 'production_start_job' && payload?.ok === false && payload?.error === 'workspace_busy') {
            const item = enqueueProductionJob(context.session, toolArgs, 'workspace_busy');
            return { output: `Queued ${item.id}: waiting for production lock (${payload.activeJobId ?? 'active job'})` };
          }
          const activity = formatMcpCallActivity(serverName, toolName, output);
          if (activity) step(activity);
          return rawCommandResult(`/mcp call ${serverName} ${toolName}`, output);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          step(formatActivityError(serverName, toolName, err));
          return { output: message };
        }
      }
      return { output: 'Usage: /mcp <status|endpoints|tools|call> [mcp]' };
    }
    case 'cancel': {
      // Alias of /run cancel — people type /cancel when they want out.
      const runtime = context.runtime ?? {};
      if (!runtime.url) return { output: 'Runtime unavailable. Start/connect the runtime before using /cancel.' };
      const result = await postRuntimeCancel({ url: runtime.url, workspace: context.session.workspace ?? null });
      return { output: result.cancelled ? 'Runtime cancel requested.' : `Nothing to cancel${result.reason ? ` (${result.reason})` : ''} — use /run kill to purge everything.` };
    }
    case 'approve': {
      // /approve was only wired in the legacy REPL — in the opentui TUI it
      // returned "Unknown command", which made every approval time out and
      // every requiresApproval plan stall forever.
      const runtime = context.runtime ?? {};
      if (!runtime.url) return { output: 'Runtime unavailable. Start/connect the runtime before using /approve.' };
      const result = await postRuntimeControl('message', {
        url: runtime.url,
        workspace: context.session.workspace ?? null,
        input: args.slice(1).join(' ') || 'approve',
        intent: 'approve',
      });
      return { output: String(result?.explanation ?? (result?.accepted ? 'Approval granted.' : 'No pending approval found.')) };
    }
    case 'run': {
      const subcommand = args[1] ?? 'status';
      const runtime = context.runtime ?? {};
      const url = runtime.url;
      if (!url) return { output: 'Runtime unavailable. Start/connect the runtime before using /run.' };
      if (subcommand === 'status') {
        const state = await fetchRuntimeState({ url, workspace: context.session.workspace ?? null });
        return { output: formatRuntimeRunStatus(state) };
      }
      if (subcommand === 'cancel') {
        const result = await postRuntimeCancel({ url, workspace: context.session.workspace ?? null });
        return { output: result.cancelled ? 'Runtime cancel requested.' : `Runtime cancel skipped: ${result.reason ?? 'no active run'}` };
      }
      if (subcommand === 'capability') {
        // Business-agnostic deterministic run: mirrors the capability
        // registry instead of hardcoding an application verb. The agent's
        // task graph is validated/integrated server-side before any LLM turn.
        const capability = args[2];
        if (!capability) return { output: 'Usage: /run capability <capability-id> [operation] [files…]' };
        if (!context.session.workspace) return { output: 'No workspace loaded. Use /use <workspace> first.' };
        const operation = args[3] && !args[3].includes('.') && !args[3].includes('/') ? args[3] : undefined;
        const inputs = args.slice(operation ? 4 : 3);
        const result = await postRuntimeRun(`Run de capability ${capability}${operation ? ` (${operation})` : ''} demandé via /run capability.`, {
          url,
          workspace: context.session.workspace,
          capabilityPlan: {
            capability,
            ...(operation ? { operation } : {}),
            ...(inputs.length > 0 ? { inputs } : {}),
          },
        });
        if (result?.runId) {
          return { output: `▶ Run de capability accepté (${String(result.runId).slice(0, 8)}) — le plan de l'agent sera intégré et dispatché en parallèle ; approbation demandée avant les mutations (« valide tout » ou /approve).` };
        }
        return { output: `Run non démarré: ${result?.explanation ?? result?.error ?? JSON.stringify(result)}` };
      }
      if (subcommand === 'kill') {
        const result = await postRuntimeKill({ url, workspace: context.session.workspace ?? null, runId: args[2] ?? null });
        return { output: `Runtime kill requested: ${result.runs ?? 0} run${result.runs === 1 ? '' : 's'}, ${result.tasks ?? 0} task${result.tasks === 1 ? '' : 's'} cancelled.` };
      }
      return { output: 'Usage: /run [status|cancel|kill [runId]|capability <id> [operation] [files…]]' };
    }
    case 'queue': {
      const subcommand = args[1] ?? 'list';
      if (subcommand === 'list') return { output: formatQueue(context.session) };
      if (subcommand === 'clear') {
        const count = clearFinishedQueueItems(context.session);
        // "Cleared 0" with a busy runtime is a dead end: the items the user
        // wants gone are ACTIVE and runtime-managed — point at the commands
        // that actually stop them.
        const activeRuntimeItems = (context.session.jobQueue ?? [])
          .filter((item) => item.origin === 'runtime' && !['done', 'failed', 'cancelled', 'expired'].includes(String(item.status ?? '').toLowerCase())).length;
        const runActive = String(context.session.agentProjection?.status ?? '').toLowerCase() === 'running';
        if (count === 0 && (activeRuntimeItems > 0 || runActive)) {
          return {
            output: `Cleared 0 finished queue items — ${activeRuntimeItems || 'des'} item(s) actifs sont gérés par le runtime${runActive ? ' (run en cours)' : ''}. Utilisez /run cancel (arrêt doux) ou /run kill (abort + purge complète).`,
          };
        }
        return { output: `Cleared ${count} finished queue item${count === 1 ? '' : 's'}.` };
      }
      if (subcommand === 'cancel') {
        const id = args[2];
        if (!id) return { output: 'Usage: /queue cancel <id>' };
        // Runtime-managed items must be refused BEFORE the local cancel:
        // syncRuntimeState replaces session.jobQueue with the runtime queue,
        // so cancelQueueItem would "succeed" locally and the next SSE sync
        // would silently revert the item to waiting (fake cancel).
        const localItem = (context.session.jobQueue ?? []).find((item) => String(item.id) === String(id));
        if (localItem?.origin === 'runtime' || (!localItem && runtimeManagedItemId(context, id))) {
          return { output: 'Item géré par le runtime — utilisez /run kill (global) ou /run cancel au lieu de /queue cancel.' };
        }
        const result = await cancelQueueItem(context.session, id);
        return { output: result.message };
      }
      return { output: 'Usage: /queue [list|clear|cancel <id>]' };
    }
    case 'upload': {
      const rest = line.replace(/^\/upload(?:\s+|$)/, '').trim();
      if (!rest) return { output: 'Usage: /upload <path>\n       /upload convert <id|pending>' };
      if (rest.startsWith('convert ')) {
        try {
          const target = rest.replace(/^convert\s+/, '').trim();
          if (!target) return { output: 'Usage: /upload convert <id|pending>' };
          step('Documents: refreshing MCP status…');
          await refreshMcpRuntimeStatus(context.session);
          if (target === 'pending') {
            step('Documents: converting pending uploads…');
            const results = await convertPendingDocumentUploads(context.session);
            if (results.length === 0) return { output: 'No pending document upload.' };
            for (const result of results) {
              const activityLine = publishDocumentActivity(context.session, result.activity);
              if (activityLine) step(activityLine);
            }
            return {
              output: results.map(({ record }) => formatUploadRecord(record)).join('\n\n'),
            };
          }
          step(`Documents: converting upload ${target}…`);
          const { record, activity } = await convertStoredDocument(context.session, target);
          const activityLine = publishDocumentActivity(context.session, activity);
          if (activityLine) step(activityLine);
          return { output: formatUploadRecord(record) };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          step(formatActivityError('documents', 'convert', err));
          return { output: message };
        }
      }
      try {
        step('Documents: storing upload…');
        await refreshMcpRuntimeStatus(context.session);
        step('Documents: converting with documents MCP when available…');
        const { record, activity, converted } = await storeAndMaybeConvertDocument(context.session, rest);
        const activityLine = publishDocumentActivity(context.session, activity);
        if (activityLine) step(activityLine);
        const note = converted === false && activity && !activity.terminal
          ? '\nConversion en cours — suivez la progression dans le panneau Plan.'
          : '';
        return { output: formatUploadRecord(record) + note };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        step(formatActivityError('documents', 'upload', err));
        return { output: message };
      }
    }
    case 'uploads': {
      try {
        if (args[1] === 'clean') {
          const flagIndex = args.indexOf('--older-than');
          const olderThan = flagIndex !== -1 ? args[flagIndex + 1] : '30d';
          const result = await cleanDocumentUploads(context.session, olderThan);
          return {
            output: `Removed ${result.removed.length} upload record${result.removed.length === 1 ? '' : 's'} older than ${olderThan}.`,
          };
        }
        if (args[1] && args[1] !== 'list') {
          return { output: 'Usage: /uploads [list]\n       /uploads clean [--older-than 30d]' };
        }
        const uploads = await listDocumentUploads(context.session);
        if (uploads.length === 0) return { output: 'No document uploads for this workspace.' };
        return { output: uploads.map(formatUploadRecord).join('\n\n') };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { output: message };
      }
    }
    case 'new': {
      return createWorkspaceCommand(context, args[1], args[2] ?? null);
    }
    case 'workspace':
    case 'workplace': {
      const subcommand = args[1] ?? 'list';
      if (subcommand === 'list') {
        return { output: formatWorkspaceList(listWorkspaces(), context.session) };
      }
      if (subcommand === 'delete') {
        const workspaceName = args[2];
        const confirmed = args.includes('--confirm');
        const workspaces = listWorkspaces();
        if (!workspaceName) return { output: workspaceDeletePrompt(workspaces) };
        const workspace = workspaces.find((item) => item.name === workspaceName);
        if (!workspace) return { output: `Workspace not found: ${workspaceName}` };
        if (!confirmed) {
          return {
            output: [
              `Confirm workspace deletion: ${workspace.name}`,
              `Path: ${workspace.workspacePath}`,
              'This removes the registry entry and deletes the workspace files.',
              '',
              `Run: /workspace delete ${workspace.name} --confirm`,
            ].join('\n'),
          };
        }
        try {
          step(`Workspace: deleting ${workspace.name}…`);
          const result = await deleteWorkspaceAndFiles(workspace, workspace.workspacePath);
          const wasCurrent = context.session.workspace === workspace.name
            || context.session.workspacePath === workspace.workspacePath;
          if (wasCurrent) clearWorkspaceSession(context.session);
          return {
            output: [
              `Deleted workspace: ${workspace.name}`,
              `Removed registry entry and files at: ${result.deletedPath}`,
              wasCurrent ? 'Current session cleared. Use /use <workspace> or /workspace init <name> [path].' : null,
            ].filter(Boolean).join('\n'),
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { output: message };
        }
      }
      if (subcommand === 'init') return createWorkspaceCommand(context, args[2], args[3] ?? null);
      return { output: 'Usage: /workspace <list|delete <name> --confirm|init <name> [path]>' };
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
          return rawCommandResult('/wiki', output);
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
          return rawCommandResult(`/wiki run ${wikiArgs.join(' ')}`, output);
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
      const note = context.session.workspaceEnv ? '' : ' (no workspace loaded — using default port)';
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
      try {
        execFileSync(opener, [url], { stdio: 'ignore' });
        return { output: `Opening web UI: ${url}${note}` };
      } catch {
        return { output: `Web UI: ${url}${note}` };
      }
    }
    case 'clear': {
      const key = context.session.workspace || '__global__';
      context.session.conversations[key] = [];
      const wantsAll = args.slice(1).some((arg) => /^--?all$/i.test(String(arg)));
      if (!wantsAll) return { output: null };

      // /clear --all is a full reset, not just a screen wipe: it purges the
      // persisted runtime runs (interrupted runs are terminal and never
      // recovered at reboot, so this is what actually removes a zombie run),
      // clears the local MCP job queue, and empties the local projection
      // (plan, activities, logs, workflow) so the UI clears immediately
      // instead of waiting for the next SSE sync.
      const runtime = context.runtime ?? {};
      const workspace = context.session.workspace ?? null;
      const parts = [];
      if (runtime.url) {
        try {
          const killed = await postRuntimeKill({ url: runtime.url, workspace, runId: null, purge: true });
          const purged = killed.purged ?? { runs: 0, events: 0, queue: 0 };
          parts.push(`runtime : ${killed.runs ?? 0} run(s) interrompu(s), ${killed.tasks ?? 0} tâche(s), ${killed.queued ?? 0} requête(s)`);
          parts.push(`store purgé : ${purged.runs ?? 0} run(s), ${purged.events ?? 0} événement(s), ${purged.queue ?? 0} item(s) de file`);
        } catch (err) {
          parts.push(`runtime kill échoué : ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        parts.push('runtime non connecté (rien à purger côté serveur)');
      }

      const clearedQueue = clearFinishedQueueItems(context.session);
      context.session.agentProjection = {
        conversation: [],
        chain: [],
        plan: null,
        activities: [],
        logs: [],
        summary: null,
        status: 'idle',
        planRevision: 0,
        planPatches: [],
      };
      context.session.headlessPlan = null;
      context.session.activities = {};
      context.session.controlQueue = [];
      context.session.workflow = null;
      context.session.jobQueue = [];
      context.session.productionActivity = null;
      parts.push(`file locale : ${clearedQueue} item(s) terminés nettoyés`);

      return { output: `Interface réinitialisée (--all) — ${parts.join(' · ')}.` };
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
