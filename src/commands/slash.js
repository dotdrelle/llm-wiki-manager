import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
      const token = endpoint.token ? 'configured' : 'missing';
      const url = endpoint.url ?? '-';
      return `${name}\t${url}\ttoken: ${token}\tstatus: ${endpoint.status}`;
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

function skillRunText(skill) {
  return [
    `# Skill plan: ${skill.name}`,
    '',
    'This shell does not execute skill Markdown blindly.',
    'dot will use this workflow as operating instructions, then choose concrete primitives/MCP tools.',
    'Costly or mutating steps still require explicit confirmation.',
    '',
    'Use a natural-language request such as:',
    '',
    `run the ${skill.name} skill for this workspace`,
    '',
    'Skill content:',
    '',
    skill.body || '_Empty skill body._',
  ].join('\n');
}

function skillActionCommand(session, action, name) {
  if (!name) return { output: `Usage: /${action}-skill <name>\nLegacy: /skill ${action} <name>` };
  const skill = findSkill(session, name);
  if (!skill) return { output: `Skill not found: ${name}` };
  return { output: action === 'run' ? skillRunText(skill) : skillDetailText(skill) };
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
  return [
    'Session',
    `workspace: ${session.workspace ?? '-'}`,
    `workspacePath: ${session.workspacePath ?? '-'}`,
    `workspaceEnv: ${session.workspaceEnvFile ?? '-'}`,
    '',
    'Config',
    `wikirc: ${session.wikirc?.profile ?? '-'}${session.wikirc?.fileName ? ` (${session.wikirc.fileName})` : ''}`,
    `language: ${session.language ?? '-'}`,
    `llm: ${session.llm ? 'configured' : 'missing'}`,
    `provider: ${session.wikircConfig?.llm?.provider ?? '-'}`,
    `model: ${session.wikircConfig?.llm?.model ?? '-'}`,
    `baseUrl: ${session.wikircConfig?.llm?.baseUrl ?? '-'}`,
    '',
    'Services',
    services.length > 0 ? services.map((service) => `- ${service}`).join('\n') : 'No workspace loaded.',
    '',
    'Runtime',
    states ? serviceStatesText(states) : 'Docker runtime not available or no workspace loaded.',
    '',
    'MCP',
    formatMcpStatus(session.mcp),
    '',
    'MCP tool summary',
    formatMcpToolSummary(session.mcp),
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
  --skill <name>       Skill to run in --headless
  --prompt <text>      Task or extra instruction for --headless
  --log-file <path>    Optional headless log path

Interactive shell:
${helpPair('/help', 'Help', '/version', 'Version')}
${helpPair('/workspaces', 'Workspaces', '/new <n> [path]', 'New workspace')}
${helpPair('/use <workspace>', 'Use workspace', '/status', 'Session status')}
${helpPair('/config list', 'Config profiles', '/config use <n>', 'Use config')}
${helpPair('/config status', 'Active config', '/services', 'Services')}
${helpPair('/start [service]', 'Start service(s)', '/stop [service]', 'Stop service(s)')}
${helpPair('/logs <service>', 'Service logs', '/skills', 'List skills')}
${helpPair('/show-skill <n>', 'Show skill', '/run-skill <n>', 'Run skill guide')}
${helpPair('/mcp status', 'MCP status', '/mcp endpoints', 'MCP endpoints')}
${helpPair('/mcp tools [mcp]', 'MCP tools', '/mcp call ...', 'Call MCP tool')}
${helpPair('/wiki', 'Run wiki index', '/wiki run <args>', 'Raw wiki CLI')}
${helpPair('/chat <message>', 'Direct chat', '/clear', 'Clear screen')}
${helpPair('/exit', 'Exit', 'Ctrl+Y', 'Copy last reply')}
${helpPair('Ctrl+T', 'Toggle mouse scroll', 'Ctrl+C Ctrl+C', 'Exit')}

Agent mode:
  Any input without a leading / is routed to the LangGraph orchestrator.
  Use /chat <message> for direct LLM chat without agent tools.

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
      return { output: 'Usage: /config <list|use|status>' };
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
          const output = await runWikiCli(context.session, ['index'], { timeout: 600_000 });
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
          const output = await runWikiCli(context.session, wikiArgs);
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
      return { output: skillsText(context.session) };
    }
    case 'show-skill': {
      return skillActionCommand(context.session, 'show', args[1]);
    }
    case 'run-skill': {
      return skillActionCommand(context.session, 'run', args[1]);
    }
    case 'skill': {
      const subcommand = args[1] ?? 'show';
      const name = args[2];
      if (subcommand === 'show' || subcommand === 'run') {
        return skillActionCommand(context.session, subcommand, name);
      }
      return { output: 'Usage: /show-skill <name> or /run-skill <name>\nLegacy: /skill <show|run> <name>' };
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
