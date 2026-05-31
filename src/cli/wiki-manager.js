import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentGraph } from '../agent/graph.js';
import { printHelp, printVersion } from '../commands/slash.js';
import { runShell } from '../shell/repl.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = resolve(__dirname, '../../package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
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
  const once = valueAfter(argv, '--once');
  if (once) {
    const result = await agent.invoke({
      input: once,
      session: {
        workspace: null,
        workspacePath: null,
        workspaceEnvFile: null,
        wikirc: null,
        wikircConfig: null,
        language: null,
        mcp: null,
        commands: ['help', 'version', 'exit', 'workspaces', 'workspace', 'use', 'config', 'status', 'services', 'start', 'stop', 'logs', 'mcp', 'wiki', 'skills', 'skill'],
        llm: null,
      },
    });
    console.log(result.response);
    return;
  }

  await runShell({ agent, packageJson });
}
