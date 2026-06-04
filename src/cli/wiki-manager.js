import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentGraph, buildAgentSystemPrompt, buildLimitedAgentResponse } from '../agent/graph.js';
import { handleSlashCommand, printHelp, printVersion } from '../commands/slash.js';
import { runShell } from '../shell/repl.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = resolve(__dirname, '../../package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const SHELL_COMMANDS = ['help', 'version', 'exit', 'workspaces', 'new', 'use', 'config', 'status', 'services', 'start', 'stop', 'logs', 'mcp', 'wiki', 'skills', 'show-skill', 'run-skill', 'clear', 'chat'];

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function createSession() {
  return {
    workspace: null,
    workspacePath: null,
    workspaceEnvFile: null,
    wikirc: null,
    wikircConfig: null,
    language: null,
    mcp: null,
    commands: SHELL_COMMANDS,
    llm: null,
    packageJson,
    conversations: { __global__: [] },
  };
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function writeHeadlessLog(session, lines, explicitPath) {
  const logPath = explicitPath
    ? resolve(explicitPath)
    : join(session.workspacePath ?? process.cwd(), '.wiki', 'logs', `headless-${timestampForFile()}.log`);
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, `${lines.join('\n')}\n`, 'utf8');
  return logPath;
}

async function runHeadlessAgentTurn(agent, session, input, log) {
  session.packageJson = packageJson;
  const result = await agent.invoke({ input, session, messages: [] });
  if (result.response != null) return result.response;
  if (result.readyToStream && session.llm?.stream) {
    const { system, messages = [] } = result.streamContext ?? {};
    let content = '';
    for await (const delta of session.llm.stream({
      system: system ?? buildAgentSystemPrompt({ input, session }),
      messages,
    })) {
      content += delta;
    }
    return content.trim() || buildLimitedAgentResponse({ input, session }, 'LLM stream ended without content');
  }
  return buildLimitedAgentResponse({ input, session });
}

async function runHeadless(argv, agent) {
  const workspaceName = valueAfter(argv, '--workspace');
  const skillName = valueAfter(argv, '--skill');
  const prompt = valueAfter(argv, '--prompt');
  const logFile = valueAfter(argv, '--log-file');
  const log = [`wiki-manager ${packageJson.version} headless`, `startedAt=${new Date().toISOString()}`];

  if (!workspaceName) throw new Error('Usage: wiki-manager --headless --workspace <name> (--skill <name>|--prompt <text>)');
  if (!skillName && !prompt) throw new Error('Usage: wiki-manager --headless --workspace <name> (--skill <name>|--prompt <text>)');

  const session = createSession();
  session.headless = true;
  const step = (line) => {
    log.push(line);
    console.log(line);
  };

  try {
    const useResult = await handleSlashCommand(`/use ${workspaceName}`, { packageJson, session, onStep: step });
    if (useResult.output) log.push(useResult.output);
    if (!session.workspacePath) throw new Error(useResult.output || `Workspace not loaded: ${workspaceName}`);
    if (!session.llm) throw new Error(`Workspace ${workspaceName} has no usable LLM config.`);

    let input = prompt;
    if (skillName) {
      const skillResult = await handleSlashCommand(`/run-skill ${skillName}`, { packageJson, session, onStep: step });
      if (skillResult.output) log.push(skillResult.output);
      if (String(skillResult.output ?? '').startsWith('Skill not found')) throw new Error(`Skill not found: ${skillName}`);
      input = [
        `Run the ${skillName} skill for workspace ${workspaceName} in headless mode.`,
        prompt ? `Additional instruction: ${prompt}` : null,
        '',
        skillResult.output,
      ].filter(Boolean).join('\n');
    }

    log.push(`input=${input}`);
    const response = await runHeadlessAgentTurn(agent, session, input, log);
    log.push('response:');
    log.push(response);
    console.log(response);
    const saved = await writeHeadlessLog(session, log, logFile);
    console.log(`Headless log: ${saved}`);
  } catch (err) {
    log.push(`error=${err instanceof Error ? err.message : String(err)}`);
    if (session.workspacePath || logFile) {
      const saved = await writeHeadlessLog(session, log, logFile);
      console.error(`Headless log: ${saved}`);
    }
    throw err;
  }
}

export async function runCli(argv) {
  if (argv.includes('--version') || argv.includes('-v')) {
    printVersion(packageJson);
    return;
  }

  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp(packageJson);
    return;
  }

  const agent = createAgentGraph();
  if (argv.includes('--headless')) {
    try {
      await runHeadless(argv, agent);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
    return;
  }

  const once = valueAfter(argv, '--once');
  if (once) {
    const result = await agent.invoke({
      input: once,
      session: createSession(),
    });
    console.log(result.response);
    return;
  }

  if (process.stdin.isTTY && process.stdout.isTTY) {
    if (!process.versions.bun) {
      throw new Error('Interactive TUI requires Bun. Run: bun ./bin/wiki-manager.js');
    }
    const { runOpenTuiShell } = await import('../shell/tui.tsx');
    await runOpenTuiShell({ agent, packageJson });
    return;
  }

  await runShell({ agent, packageJson });
}
