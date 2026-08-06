import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROFILE_FLAGS, profileServiceStatus } from './agentsCompose.js';

test('a disabled service says which flag, in which file, and what to do', () => {
  const status = profileServiceStatus('connectors', { env: {} });
  assert.equal(status.enabled, false);
  assert.equal(status.flag, 'CONNECTORS_ENABLED');
  // Le message d'origine — « unavailable or disabled » — ne disait ni lequel
  // des deux, ni où regarder : Donna, faute de fait à citer, inventait un
  // `cme.yaml` et un « manifeste des services actifs ».
  assert.match(status.message, /CONNECTORS_ENABLED is not set/);
  assert.match(status.message, /set CONNECTORS_ENABLED=true/);
  assert.match(status.message, /\/start agents/);
  assert.match(status.message, /\.env/);
  // Le piège du profil Compose : le conteneur n'existe pas du tout, ce qui
  // ressemble à un service planté.
  assert.match(status.message, /does not exist at all/);
});

test('a disabled service quotes the value actually found', () => {
  const status = profileServiceStatus('connectors', { env: { CONNECTORS_ENABLED: 'false' } });
  assert.equal(status.enabled, false);
  assert.match(status.message, /CONNECTORS_ENABLED is "false"/);
});

test('an enabled but unreachable service is a different diagnosis', () => {
  const status = profileServiceStatus('connectors', { env: { CONNECTORS_ENABLED: 'true' } });
  assert.equal(status.enabled, true);
  assert.match(status.message, /enabled .* but not reachable/);
  assert.doesNotMatch(status.message, /set CONNECTORS_ENABLED=true/);
});

test('an unknown service is not described as disabled', () => {
  const status = profileServiceStatus('nope', { env: {} });
  assert.equal(status.flag, null);
  assert.match(status.message, /no "nope" service/);
});

test('/connector reports the reason instead of a bare "unavailable or disabled"', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../commands/slash.js', import.meta.url)),
    'utf8',
  );
  assert.match(source, /profileServiceStatus\('connectors'\)\.message/);
  assert.doesNotMatch(source, /The connectors service is unavailable or disabled\./);
});

test('every profile flag is documented where the operator will look', () => {
  const doc = readFileSync(
    fileURLToPath(new URL('../../../llm-wiki/help-doc/06-troubleshooting.md', import.meta.url)),
    'utf8',
  );
  // Donna répond aux questions produit depuis cette documentation : un drapeau
  // absent d'ici est un drapeau qu'elle ne peut que deviner.
  for (const flag of Object.values(PROFILE_FLAGS)) {
    assert.ok(doc.includes(flag), `${flag} must be documented in help-doc/06-troubleshooting.md`);
  }
});

test('stopping the agents resolves the same manager files as starting them', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./wikiSetup.js', import.meta.url)),
    'utf8',
  );
  // `stopAgents` n'épinglait pas WIKI_MANAGER_ENV_FILE : le script résolvait
  // `.env` contre le répertoire du paquet, `connectors_enabled` y lisait un
  // profil inactif, et `docker compose down` partait sans
  // `--profile connectors`. Un service à profil inactif étant invisible à
  // Compose, le conteneur restait debout — `/stop agents` annonçait un succès
  // en laissant tourner ce qu'il prétendait arrêter.
  const stopBlock = source.slice(source.indexOf('export async function stopAgents'));
  for (const key of ['WIKI_MANAGER_ENV_FILE: managerEnvFile()', 'WIKI_MANAGER_ENDPOINTS_FILE: managerMcpEndpointsFile()']) {
    assert.ok(stopBlock.includes(key), `stopAgents must pin ${key}`);
  }
});

test('"all" means the same thing to start and to stop', () => {
  const slash = readFileSync(fileURLToPath(new URL('../commands/slash.js', import.meta.url)), 'utf8');
  // `/start all` démarrait les agents, `/stop all` ne les arrêtait pas : la
  // séquence start/stop ne revenait donc pas à l'état de départ.
  assert.match(slash, /const startsAgents = service === 'all';/);
  assert.match(slash, /const stopsAgents = service === 'all' \|\| stopsEverything;/);
});

test('stopping one workspace never takes the shared agents from another', () => {
  const slash = readFileSync(fileURLToPath(new URL('../commands/slash.js', import.meta.url)), 'utf8');
  // Les agents externes sont UNE pile partagée. `/stop all` les arrêtait sans
  // condition : couper un workspace coupait tous les autres, qui ne voyaient
  // qu'une panne.
  assert.match(slash, /await otherWorkspacesRunning\(context\.session, listWorkspaces\(\)\)/);
  assert.match(slash, /if \(busy\.length > 0\) \{/);
  // Le renoncement doit se dire : un saut silencieux ressemble exactement au
  // bug d'origine.
  assert.match(slash, /agents left running for \$\{busy\.join\(', '\)\}/);
  assert.match(slash, /use \/stop everything to stop them anyway/);
  // `everything` court-circuite la garde, et c'est son seul intérêt.
  assert.match(slash, /const busy = stopsEverything\s*\n\s*\? \[\]/);
});

test('the everything escape hatch is discoverable', () => {
  const slash = readFileSync(fileURLToPath(new URL('../commands/slash.js', import.meta.url)), 'utf8');
  const repl = readFileSync(fileURLToPath(new URL('../shell/repl.js', import.meta.url)), 'utf8');
  // Une porte de sortie qui n'apparaît ni dans l'aide ni dans la complétion
  // n'existe pas pour l'opérateur qui en a besoin.
  assert.match(slash, /\/stop \[all\|everything\|service\|agents\]/);
  assert.match(repl, /command === '\/stop' && tokenIndex === 1\) return \['all', 'everything'/);
  assert.match(repl, /if \(value === 'everything'\)/);
});

test('the addressable agents are read from the compose file, never hard-coded', async () => {
  const { agentServiceNames, togglableAgentNames } = await import('./agentsCompose.js');
  const declared = agentServiceNames();

  // Une liste figée annonçait `mailer`, qui ne vit que dans l'exemple
  // d'override : proposer un service absent, c'est promettre un
  // « no such service ».
  assert.ok(declared.includes('connectors'));
  assert.ok(declared.includes('cme'));
  assert.ok(!declared.includes('mailer'), 'mailer is not declared until the operator uncomments it');

  // Et seuls les agents à drapeau se proposent un par un dans l'interface.
  assert.deepEqual(togglableAgentNames(), ['connectors']);
  for (const name of togglableAgentNames()) {
    assert.ok(declared.includes(name), `${name} must actually exist in the agents stack`);
  }
});

test('an agent can be started and stopped on its own', () => {
  const setup = readFileSync(fileURLToPath(new URL('./wikiSetup.js', import.meta.url)), 'utf8');
  const slash = readFileSync(fileURLToPath(new URL('../commands/slash.js', import.meta.url)), 'utf8');
  const script = readFileSync(fileURLToPath(new URL('../../wiki-workspace', import.meta.url)), 'utf8');

  assert.match(setup, /'agents', 'up', \.\.\.\(options\.services \?\? \[\]\)/);
  assert.match(setup, /'agents', 'down', \.\.\.\(options\.services \?\? \[\]\)/);
  // La pile agents est un projet Compose distinct : sans ce routage, `/start
  // connectors` allait chercher un service inexistant côté workspace.
  assert.match(slash, /agentServiceNames\(\)\.includes\(service\)/);
  // `down <service>` supprimerait le réseau commun : Compose impose stop + rm.
  assert.match(script, /_agents_dc stop "\$@"/);
  assert.match(script, /_agents_dc rm -f "\$@"/);
});

test('a connector read tool is not mistaken for the limit of its agent', () => {
  const graph = readFileSync(fileURLToPath(new URL('../agent/graph.js', import.meta.url)), 'utf8');
  // « récupère ce mail » et « envoie un mail » ont été refusés comme
  // impossibles, alors que l'agent connectors déclare `external-source.collect`
  // et `communication.send-email`. Donna raisonnait sur les outils de lecture
  // exposés au chat — qui ne rendent que des métadonnées — au lieu de déléguer.
  assert.match(graph, /direct read tools of a connector are a preview/);
  assert.match(graph, /delegated through runtime__delegate, not answered from a read tool/);
  // Et un droit manquant doit être nommé comme tel, pas présenté comme une
  // fonctionnalité absente.
  assert.match(graph, /lack of an authorization grant or scope/);
});

test('the system prompt points product questions at the documentation tools', () => {
  const graph = readFileSync(
    fileURLToPath(new URL('../agent/graph.js', import.meta.url)),
    'utf8',
  );
  // Les outils help_* sont exposés (allow-list du mode chat) mais le prompt ne
  // disait nulle part qu'ils sont LA source des questions produit : Donna
  // répondait de mémoire, et inventait.
  assert.match(graph, /bundled product documentation is your source/);
  assert.match(graph, /call the documentation search\/read tools FIRST/);
  assert.match(graph, /Configuration facts are never answered from memory/);
});
