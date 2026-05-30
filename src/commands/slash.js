import { createLlmClientFromWikiConfig } from '../agent/llm.js';
import { buildMcpStatus, formatMcpStatus } from '../core/mcp.js';
import { findWorkspace, listWorkspaces } from '../core/workspaces.js';
import {
  listWikircProfiles,
  loadWikircProfile,
  summarizeWikircConfig,
} from '../core/wikirc.js';

export function printVersion(packageJson) {
  console.log(packageJson.version);
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

Interactive shell:
  /help                Show shell commands
  /version             Show version
  /workspaces          List configured workspaces
  /use <workspace>     Load a workspace and its default .wikirc.yaml
  /config list         List .wikirc.yaml profiles for the current workspace
  /config use <name>   Reload session LLM/config from .wikirc.yaml.<name>
  /config status       Show active wikirc profile without secrets
  /status              Show current workspace/session state
  /exit                Exit the shell

Agent mode:
  Any input without a leading / is routed to the LangGraph orchestrator.

Status:
  Step 2 is installed: minimal agent-first shell backed by LangGraph.
  Shell UI is English. Agent exchange language is read from the active .wikirc.yaml.
  LLM config is intentionally workspace-scoped and will be read from .wikirc.yaml after /use <workspace>.
  Workspace, service, MCP and skill tools will be added in the next increments.
`;
}

export function printHelp(packageJson) {
  console.log(helpText(packageJson));
}

export function handleSlashCommand(line, context) {
  const args = line.slice(1).trim().split(/\s+/).filter(Boolean);
  const [command] = args;

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
      return {
        output: [
          `workspace=${context.session.workspace ?? '-'}`,
          `workspacePath=${context.session.workspacePath ?? '-'}`,
          `wikirc=${context.session.wikirc?.profile ?? '-'}`,
          `wikircFile=${context.session.wikirc?.fileName ?? '-'}`,
          `language=${context.session.language ?? '-'}`,
          `llm=${context.session.llm ? 'configured' : 'missing'}`,
          formatMcpStatus(context.session.mcp),
        ].join('\n'),
      };
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
      context.session.mcp = buildMcpStatus(context.session);
      try {
        const summary = loadSessionWikirc(context.session, 'default');
        return {
          output: [
            `Workspace loaded: ${workspace.name}`,
            `Path: ${workspace.workspacePath}`,
            'Active wikirc:',
            wikircSummaryText(summary),
            context.session.llm ? 'LLM session: configured' : 'LLM session: missing config',
          ].join('\n'),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          output: [
            `Workspace loaded: ${workspace.name}`,
            `Path: ${workspace.workspacePath}`,
            `Wikirc not loaded: ${message}`,
          ].join('\n'),
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
    case 'exit':
    case 'quit':
      return { exit: true };
    default:
      return {
        output: `Unknown command: /${command}\nUse /help to see available commands.`,
      };
  }
}
