/**
 * @statuses-vocabulary
 *
 * CONTROL QUEUE item statuses, which include `expired`. A control request
 * is not a task and does not share its lifecycle.
 *
 * Declared here rather than in a central exception list so the waiver
 * travels with the code it excuses (see orchestrator/taskStatuses.test.js).
 */
import { isTerminal } from '../orchestrator/taskStatuses.js';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { openExternalUrl } from '../shell/openExternal.js';
import { classifyCommandFailure, failureHint, rawFailureText } from '../core/commandFailure.js';
import { join, relative } from 'node:path';
import { composeServices, listServices, otherWorkspacesRunning, runWikiCli, serviceLogs, serviceNames, serviceStates, startService, stopService } from '../core/compose.js';
import { agentServiceNames, profileServiceStatus } from '../core/agentsCompose.js';
import { GOOGLE_GRANTS, GOOGLE_GRANT_LABELS, defaultGoogleGrants } from '../core/googleGrants.js';
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
import { loadManagerEnv } from '../core/env.js';
import { resolveSchedulerConcurrency } from '../orchestrator/scheduler.js';
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

export function compactBaseUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '-';
  try {
    const parsed = new URL(raw);
    const label = parsed.host || parsed.hostname;
    return label ? `[${label}](${raw})` : raw;
  } catch {
    return raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '') || '-';
  }
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
  return { count: files.length, totalBytes, latest };
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
  };
}

function statLine(label, stat) {
  return `${label}: ${stat.count} (${formatBytes(stat.totalBytes)})`;
}

function positiveConcurrency(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.floor(parsed)) : fallback;
}

function discoveredAgentLimits(session, agentType) {
  const agents = session?.agentRegistry?.snapshot?.() ?? session?.agentRegistrySnapshot ?? [];
  const agent = agents.find((entry) =>
    String(entry?.description?.agentType ?? '').toLowerCase() === agentType
    || String(entry?.serverName ?? '').toLowerCase().includes(agentType));
  return agent?.description?.limits ?? {};
}

export function agentConcurrencySections(session, env = process.env) {
  const managerCeiling = positiveConcurrency(env.WIKI_MANAGER_CAPABILITY_CONCURRENCY, null);
  const productionLimits = discoveredAgentLimits(session, 'production');
  const productionRecommended = positiveConcurrency(
    productionLimits.recommendedConcurrency ?? env.PRODUCTION_RECOMMENDED_CONCURRENCY,
    4,
  );
  const productionMaximum = positiveConcurrency(
    productionLimits.maxConcurrency ?? env.PRODUCTION_MAX_CONCURRENCY,
    8,
  );
  const productionEffective = Math.min(
    productionRecommended,
    productionMaximum,
    managerCeiling ?? Number.POSITIVE_INFINITY,
  );

  const connectorLimits = discoveredAgentLimits(session, 'connectors');
  const collectionRecommended = positiveConcurrency(
    connectorLimits.recommendedConcurrency ?? env.CONNECTORS_RECOMMENDED_CONCURRENCY,
    2,
  );
  const collectionMaximum = positiveConcurrency(
    connectorLimits.maxConcurrency ?? env.CONNECTORS_MAX_CONCURRENCY,
    4,
  );
  const collectionEffective = Math.min(
    collectionRecommended,
    collectionMaximum,
    managerCeiling ?? Number.POSITIVE_INFINITY,
  );

  return {
    production: sectionBlock('Parallelism & throughput', [
      `effective: ${productionEffective}`,
      `recommended: ${productionRecommended}`,
      `maximum: ${productionMaximum}`,
      `scheduler workers: ${resolveSchedulerConcurrency(env.WIKI_MANAGER_SCHEDULER_CONCURRENCY)}`,
    ]),
    collection: sectionBlock('Collection concurrency', [
      `effective: ${collectionEffective}`,
      `recommended: ${collectionRecommended}`,
      `maximum: ${collectionMaximum}`,
    ]),
  };
}

function workspaceStatsColumns(stats, session) {
  if (!stats) return { left: 'No workspace loaded.', right: '' };

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
  // Counts only. `largest:` and the `recent:` list printed full relative paths
  // in a half-width column, so every line wrapped or was clipped and the block
  // read as noise. The file listing belongs to a command with room for it.
  const rawColumn = sectionBlock('Raw sources', [
    statLine('untracked', stats.untracked),
    statLine('ingested', stats.ingested),
  ]);
  const deliveryColumn = sectionBlock(`Deliverables: ${deliverablesLatest}`, [
    statLine('templates', stats.templates),
    statLine('deliverables', stats.deliverables),
  ]);
  const concurrency = agentConcurrencySections(session);

  return {
    left: [wikiColumn, deliveryColumn].join('\n\n'),
    right: [rawColumn, concurrency.production, concurrency.collection].join('\n\n'),
  };
}

function workspaceLoadedText(workspace, summary, session, mcpError = null) {
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
    ...(mcpError ? ['', `MCP discovery failed: ${mcpError}`] : []),
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

function mcpPort(endpoint) {
  const value = String(endpoint?.url ?? endpoint?.configuredUrl ?? '');
  try {
    const parsed = new URL(value);
    if (parsed.port) return parsed.port;
    if (parsed.protocol === 'https:') return '443';
    if (parsed.protocol === 'http:') return '80';
  } catch {
    // Placeholders in configured URLs are not valid URL syntax; use the
    // resolved trailing numeric port when one is present.
  }
  return value.match(/:(\d+)(?:\/|$)/)?.[1] ?? '-';
}

export function compactMcpStatus(mcpStatus) {
  const entries = Object.entries(mcpStatus ?? {});
  if (entries.length === 0) return '○ none';
  return entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, endpoint]) => {
      // `configured` covers two very different situations: an endpoint we
      // never probed (service stopped) and one whose probe failed. Reporting
      // both as "configured" is what makes a live agent look unconfigured —
      // surface the failure as its own state, with the cause one command away
      // (`/mcp status` prints the full toolsError).
      if (endpoint.status !== 'connected' && endpoint.toolError) {
        return `✕ ${name}  :${mcpPort(endpoint)}  unreachable (/mcp status)`;
      }
      const marker = endpoint.status === 'connected'
        ? '●'
        : endpoint.status === 'configured'
          ? '◐'
          : '○';
      return `${marker} ${name}  :${mcpPort(endpoint)}  ${endpoint.status ?? 'unknown'}`;
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
    // Seed the new workspace from the one in use: the LLM endpoint, key and
    // model are almost always the same, and re-entering them by hand was the
    // first thing to do after every /new.
    const { inherited } = await finalizeCreatedWorkspace(workspaceName, {
      inheritFrom: context.session?.workspace ?? null,
    });
    return {
      output: [
        output,
        '',
        `Workspace created: ${workspaceName}`,
        // State what was carried over. Inheriting silently would make a wrong
        // endpoint look like a scaffold default and send the operator hunting
        // in the wrong file.
        inherited.length > 0
          ? `Inherited from ${context.session.workspace}: ${inherited.join(', ')}`
          : null,
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
  const workspaceColumn = sectionBlock(`Workspace · ${session.workspace ?? '-'}`, [
    `path: ${compactPath(session.workspacePath ?? '-')}`,
    `env: ${compactPath(session.workspaceEnvFile ?? '-')}`,
  ]);
  const configColumn = sectionBlock('Config', [
    `wikirc: ${session.wikirc?.profile ?? '-'}${session.wikirc?.fileName ? ` (${session.wikirc.fileName})` : ''}`,
    `language: ${session.language ?? '-'}`,
    `llm: ${session.llm ? 'configured' : 'missing'}`,
    `provider: ${session.wikircConfig?.llm?.provider ?? '-'}`,
    `model: ${session.wikircConfig?.llm?.model ?? '-'}`,
    `baseUrl: ${compactBaseUrl(session.wikircConfig?.llm?.baseUrl)}`,
  ]);
  const runtimeColumn = sectionBlock('Runtime', (states ? serviceStatesText(states) : 'Docker runtime not available or no workspace loaded.').split('\n'));
  const mcpColumn = sectionBlock('MCP', compactMcpStatus(session.mcp).split('\n'));
  const stats = workspaceStatsColumns(workspaceStats, session);

  const leftColumn = [workspaceColumn, stats.left, runtimeColumn, mcpColumn].filter(Boolean).join('\n\n');
  const rightColumn = [configColumn, stats.right].filter(Boolean).join('\n\n');

  // Leading/trailing blank row so the boxed pair doesn't butt directly against
  // the pane border when the view is scrolled to show the tail. It is padding,
  // not data: LeftPane renders a row that is blank on both sides as a plain
  // spacer, so no empty bordered box is drawn past the last real line.
  const pad = ' ';
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
  --refresh            Stop runtime and project containers; remove project images
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
${helpPair('/services', 'Services', '/start [all|agents|services]', 'all = services + agents')}
${helpPair('/stop [all|everything|service|agents]', 'Stop service(s)', '/logs <service>', 'Service logs')}
${helpPair('/skills', 'List skills', '/skills show <n>', 'Show skill')}
${helpPair('/skills run <n>', 'Run skill guide', '/skills edit <n>', 'Edit skill')}
${helpPair('/mcp status', 'MCP status', '/mcp endpoints', 'MCP endpoints')}
${helpPair('/mcp tools [mcp]', 'MCP tools', '/mcp call ...', 'Call MCP tool')}
${helpPair('/connector list', 'Connector auth status', '/connector auth <n>', 'Authorize connector')}
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

export function rawCommandAgentPrompt(command, output) {
  return [
    `L'utilisateur a lancé la commande shell ${command}.`,
    'Voici la sortie brute collectée par la commande déterministe. Ne relance pas la commande, ne modifie pas les données et n’appelle aucun outil.',
    'Réponds à l’utilisateur à partir de ces faits, en appliquant le profil workspace et les préférences de présentation déjà chargés dans ton prompt système.',
    'Ne reproduis pas les détails techniques, identifiants internes, chemins, noms de conteneurs ou sorties brutes. Donne seulement le résultat utile en langage naturel.',
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

// Failure counterpart of localizedOperationResult. The raw docker output never
// reaches the conversation: it goes to the runtime log lane through `step()`,
// while Donna gets a stable reason code she can phrase — and act on, since
// every reason maps to something the operator can actually do.
export function localizedOperationFailure({ operation, target, error }) {
  const reason = classifyCommandFailure(error);
  const hint = reason === 'unknown' ? failureHint(error) : '';
  const facts = JSON.stringify({
    operation,
    target,
    status: 'failed',
    reason,
    ...(hint ? { detail: hint } : {}),
  });
  return {
    output: facts,
    rawOutput: true,
    // The status only lived inside the serialized facts, so a caller chaining
    // two operations (/start all = agents then services) had to re-parse JSON
    // to know whether to continue. Surface it as a plain flag.
    failed: true,
    agentTrigger: [
      "Formule l'échec structuré suivant dans la langue et le ton demandés par le profil du workspace.",
      "Réponds en une ou deux phrases humaines: ce qui a échoué, et l'action concrète que la personne peut faire.",
      'Ne cite aucune commande, aucun chemin de fichier, aucun drapeau shell ni sortie docker.',
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
    ? state.workflow.nodes.filter((node) => node.type === 'task' && !isTerminal(node.status)).length
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
      if (verb === 'start') {
        // `wiki-workspace agents up` generates the agent tokens into the
        // manager .env and adds the profiled entries to mcp.endpoints.json.
        // Both were read at boot, so without re-reading them the endpoint the
        // script just wrote resolves with an empty ${..._AUTH_TOKEN} and the
        // freshly started agent stays "credential not set" until a restart.
        step('Agents: reloading manager environment and MCP endpoints…');
        // The script may have replaced a blank/generated token that was
        // already loaded at boot. A non-overriding dotenv reload would keep
        // the stale process value and defeat the refresh.
        loadManagerEnv({ override: true });
        await refreshMcpRuntimeStatus(context.session);
      }
      return localizedOperationResult({
        operation: verb,
        target: 'agents',
        componentAction: componentInstallAction(missingImages),
        images: missingImages,
      });
    } catch (err) {
      step(formatActivityError('agents', verb, err));
      step(`Agents: docker output — ${rawFailureText(err)}`);
      return localizedOperationFailure({ operation: verb, target: 'agents', error: err });
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
      let summary;
      try {
        step(`Workspace: loading ${workspace.name} config…`);
        ({ summary } = applySessionWikircProfile(context.session, 'default'));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          output: workspaceLoadedWithoutConfigText(workspace, message),
        };
      }
      try {
        step(`Workspace: discovering ${workspace.name} MCP tools…`);
        await refreshMcpRuntimeStatus(context.session);
        return {
          output: workspaceLoadedText(workspace, summary, context.session),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          output: workspaceLoadedText(workspace, summary, context.session, message),
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
        step(formatActivityError('services', 'list', err));
        step(`Services: docker output — ${rawFailureText(err)}`);
        return localizedOperationFailure({ operation: 'list', target: 'workspace-services', error: err });
      }
    }
    case 'start': {
      // 'all' already resolves correctly through serviceAliases() (DEFAULT_SERVICE_ALIASES.all
      // = COMPOSE_SERVICES, overridable via docker-compose.yml's service-aliases.all.targets) —
      // do not remap it to undefined, that bypasses any custom "all" target list and always
      // falls back to the hardcoded COMPOSE_SERVICES constant instead.
      const service = args[1];
      if (service === 'agents' || service === 'agent') return runAgentCommand(startAgents, 'start');
      // Un agent nommé appartient à la pile agents (projet Compose distinct),
      // pas à celle du workspace : le router ici évite un « no such service »
      // sur un nom que la complétion propose pourtant.
      if (agentServiceNames().includes(service)) {
        return runAgentCommand((options) => startAgents({ ...options, services: [service] }), 'start');
      }
      // "all" used to mean "the workspace services", which left the external
      // agents down and looked like nothing had happened. It now means what an
      // operator reads into it: the whole stack. `/start services` keeps the
      // workspace-only behaviour.
      const startsAgents = service === 'all';
      const target = service === 'services' ? undefined : service;
      try {
        if (startsAgents) {
          // Validate the workspace half before mutating the global agents
          // stack. Otherwise `/start all` with no active workspace starts the
          // agents successfully and only then fails, leaving a partial start.
          if (!context.session.workspace || !context.session.workspacePath || !context.session.workspaceEnv?.WORKSPACE_NAME) {
            throw new Error('No workspace loaded. Use /use <workspace>.');
          }
          const agentsResult = await runAgentCommand(startAgents, 'start');
          if (agentsResult?.failed) return agentsResult;
        }
        step(`Services: starting ${target ?? 'workspace services'}…`);
        const missingImages = await collectMissingImages(step, (opts) => startService(context.session, target, opts));
        step('Services: refreshing MCP runtime…');
        await refreshMcpRuntimeStatus(context.session);
        return localizedOperationResult({
          operation: 'start',
          target: startsAgents ? 'all-services-and-agents' : (target || 'workspace-services'),
          componentAction: componentInstallAction(missingImages),
          images: missingImages,
        });
      } catch (err) {
        step(formatActivityError('services', 'start', err));
        step(`Services: docker output — ${rawFailureText(err)}`);
        return localizedOperationFailure({ operation: 'start', target: target || 'workspace-services', error: err });
      }
    }
    case 'stop': {
      const service = args[1];
      if (service === 'agents') return runAgentCommand(stopAgents, 'stop');
      if (agentServiceNames().includes(service)) {
        return runAgentCommand((options) => stopAgents({ ...options, services: [service] }), 'stop');
      }
      // Symétrique de `/start all` : « all » désigne toute la pile, agents
      // compris. Il ne stoppait que les services du workspace et laissait les
      // agents debout — donc `/start all` puis `/stop all` ne revenait pas à
      // l'état de départ.
      //
      // Cette symétrie ne tient que tant qu'un seul workspace tourne. Les
      // agents externes sont UNE pile partagée : les arrêter depuis un
      // workspace coupait les autres, qui n'avaient rien demandé et ne
      // voyaient qu'une panne. « all » reste donc « toute ma pile », et les
      // agents ne tombent que s'ils ne servent plus personne. `/stop
      // everything` garde la coupure franche, explicitement demandée.
      const stopsEverything = service === 'everything';
      const stopsAgents = service === 'all' || stopsEverything;
      const stopTarget = service === 'services' || stopsEverything ? undefined : service;
      try {
        step(`Services: stopping ${stopsEverything ? 'all workspaces and agents' : (service ?? 'workspace services')}…`);
        await stopService(context.session, stopTarget);
        if (stopsAgents) {
          const busy = stopsEverything
            ? []
            : await otherWorkspacesRunning(context.session, listWorkspaces());
          if (busy.length > 0) {
            // Say who is holding them, and how to override. A silent skip
            // would look exactly like the bug we just fixed.
            step(`Services: agents left running for ${busy.join(', ')} — use /stop everything to stop them anyway.`);
          } else {
            const agentsResult = await runAgentCommand(stopAgents, 'stop');
            if (agentsResult?.failed) return agentsResult;
          }
        }
        step('Services: refreshing MCP runtime…');
        await refreshMcpRuntimeStatus(context.session);
        return localizedOperationResult({
          operation: 'stop',
          target: service || 'workspace-services',
        });
      } catch (err) {
        step(formatActivityError('services', 'stop', err));
        step(`Services: docker output — ${rawFailureText(err)}`);
        return localizedOperationFailure({ operation: 'stop', target: service || 'workspace-services', error: err });
      }
    }
    case 'logs': {
      const service = args[1];
      // A usage mistake is not a runtime failure: keep it a plain instruction
      // rather than sending it to Donna to be rephrased.
      if (!service) return { output: `Usage: /logs <service> [tail] — services: ${serviceNames().join(', ')}` };
      const tail = args[2] ? Number(args[2]) : 120;
      try {
        step(`Services: reading logs for ${service ?? 'service'}…`);
        const output = await serviceLogs(context.session, service, { tail });
        return rawCommandResult(`/logs ${[service, args[2]].filter(Boolean).join(' ')}`.trim(), output);
      } catch (err) {
        step(formatActivityError('services', 'logs', err));
        step(`Services: docker output — ${rawFailureText(err)}`);
        return localizedOperationFailure({ operation: 'logs', target: service || 'workspace-services', error: err });
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
    case 'connector': {
      const subcommand = args[1] ?? 'list';
      const connectorResult = (output) => rawCommandResult(`/connector ${args.slice(1).join(' ')}`.trim(), output);
      if (!context.session.workspace) {
        return connectorResult('No workspace is currently loaded.');
      }
      await refreshMcpRuntimeStatus(context.session);
      const connectorMcp = context.session.mcp?.connectors;
      if (!connectorMcp || connectorMcp.status !== 'connected') {
        // Le manager sait exactement pourquoi : ne pas renvoyer un constat
        // vague que Donna comblerait en inventant.
        return connectorResult(profileServiceStatus('connectors').message);
      }
      if (subcommand === 'list') {
        if (args[2]) return connectorResult('The connector list request has invalid extra arguments.');
        try {
          const result = await callMcpTool(
            context.session.mcp,
            'connectors',
            'connectors_google_status',
            { workspace: context.session.workspace },
          );
          const payload = parseJsonText(formatMcpToolResult(result));
          if (payload?.status !== 'configured') {
            return connectorResult('google (Gmail): not authorized. Run `/connector auth google` to authorize reading and sending.');
          }
          // Le libellé annonçait « read-only » quels que soient les droits
          // réellement accordés — donc il mentait dès qu'on autorisait l'envoi,
          // et n'aidait pas à comprendre pourquoi l'envoi échouait sinon.
          const grants = Array.isArray(payload?.grants) ? payload.grants : [];
          const missing = GOOGLE_GRANTS.filter((grant) => !grants.includes(grant));
          const held = grants.map((grant) => `${grant} — ${GOOGLE_GRANT_LABELS[grant] ?? 'unknown grant'}`);
          const lines = [
            `google (Gmail): authorized for ${grants.join(', ') || 'nothing'}`,
            ...held.map((line) => `  ✓ ${line}`),
            ...missing.map((grant) => `  ✗ ${grant} — ${GOOGLE_GRANT_LABELS[grant]}`),
          ];
          if (missing.length > 0) {
            lines.push(`Run \`/connector auth google ${missing.join(' ')}\` to add the missing grant(s); existing ones are kept.`);
          }
          return connectorResult(lines.join('\n'));
        } catch (err) {
          return connectorResult(`google (Gmail): unavailable (${err instanceof Error ? err.message : String(err)})`);
        }
      }
      if (subcommand === 'auth') {
        const connector = String(args[2] ?? '').toLowerCase();
        if (!['google', 'gmail'].includes(connector)) {
          return connectorResult('The requested connector is unsupported. The available connector is google (Gmail).');
        }
        // Les droits demandés à Google. L'appel ne les passait pas, et le
        // serveur retombait sur son défaut `["read"]` : l'agent sait envoyer un
        // courriel, l'autorisation obtenue ne le permettait pas, et le refus
        // ressemblait à une fonctionnalité absente. On demande donc lecture ET
        // envoi par défaut, et les droits restants s'ajoutent à la demande.
        const requested = args.slice(3).map((value) => String(value).toLowerCase());
        const unknown = requested.filter((grant) => !GOOGLE_GRANTS.includes(grant));
        if (unknown.length > 0) {
          const available = GOOGLE_GRANTS.map((grant) => `${grant} (${GOOGLE_GRANT_LABELS[grant]})`).join('; ');
          return connectorResult(`Unsupported grant(s): ${unknown.join(', ')}. Available grants: ${available}.`);
        }
        // Par défaut, tout ce que l'agent sait faire — y compris `modify`, sans
        // quoi les actions que Donna propose d'elle-même (« marquer comme lu »,
        // « archiver ») échouent après coup. C'est la même incohérence que
        // l'envoi : promettre une action que l'autorisation ne couvre pas.
        const grants = requested.length > 0 ? [...new Set(requested)] : defaultGoogleGrants();
        try {
          const result = await callMcpTool(
            context.session.mcp,
            'connectors',
            'connectors_google_oauth_start',
            { workspace: context.session.workspace, grants },
          );
          const payload = parseJsonText(formatMcpToolResult(result));
          const authorizationUrl = payload?.authorizationUrl;
          if (payload?.error === 'send_capability_disabled') {
            return connectorResult(
              'Sending is disabled in this deployment (CONNECTORS_SEND_ENABLED=false in the manager .env), so the send grant cannot be authorized. Run `/connector auth google read` for read-only access, or enable sending and restart the connectors agent.',
            );
          }
          if (payload?.ok !== true || typeof authorizationUrl !== 'string') {
            return connectorResult(`Google authorization could not start (${payload?.error ?? 'missing authorization URL'}).`);
          }
          // L'autorisation est incrémentale côté Google : redemander avec un
          // droit de plus ne révoque pas les précédents.
          const scopeNote = `Requested grants: ${grants.join(', ')}.`;
          if (openExternalUrl(authorizationUrl)) {
            return connectorResult(`Google authorization opened successfully in the user browser. ${scopeNote}`);
          }
          return connectorResult(`Google authorization requires the user to open this URL: ${authorizationUrl} — ${scopeNote}`);
        } catch (err) {
          return connectorResult(`Google authorization could not start (${err instanceof Error ? err.message : String(err)}).`);
        }
      }
      return connectorResult(`The requested connector action is unsupported. Available actions: list, and auth google [${GOOGLE_GRANTS.join('|')}].`);
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
      if (openExternalUrl(url)) return { output: `Opening web UI: ${url}${note}` };
      return { output: `Web UI: ${url}${note}` };
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
