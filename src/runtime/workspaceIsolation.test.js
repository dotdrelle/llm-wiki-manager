import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgentEvent, dispatchAgentEvent, reduceAgentEvents } from '../core/agentEvents.js';
import { openRuntimeStore } from './store.js';

/*
 Isolation entre workspaces, avec plusieurs piles Docker et plusieurs `serve`
 chargés en même temps.

 Le runtime est UN processus (port 7788) partagé par tous les workspaces : ce
 sont ces tests qui font la différence entre « partagé » et « mélangé ». Ils
 portent sur le vrai store SQLite et sur le vrai filtre de publication, pas sur
 des doublures — c'est précisément le câblage entre les deux qui peut fuir.
*/

function freshStore() {
  return openRuntimeStore({ stateDir: mkdtempSync(join(tmpdir(), 'wiki-isolation-')) });
}

// `runtime_log` n'est délibérément pas persisté (bruit de progression) : ces
// tests utilisent donc des types qui le sont, pour porter sur le stockage réel.
function sessionFor(store, workspace) {
  const session = { workspace, activities: {}, headlessPlan: null, agentEvents: [] };
  session._onAgentEvent = (event) => store.persistEvent(event);
  return session;
}

test('a session stamps its workspace on every event it dispatches', () => {
  // Sans cette empreinte, un événement partirait avec workspace=null : le
  // filtre SSE le refuserait à tout client scopé, et `listEvents({workspace})`
  // ne le retrouverait jamais. La plan/activité d'un run serait perdue au
  // redémarrage, pour tout le monde.
  const store = freshStore();
  const acpi = sessionFor(store, 'acpi');

  dispatchAgentEvent(acpi, createAgentEvent('user_message', {
    origin: 'user',
    payload: { content: 'ingest démarré' },
  }));

  const [event] = store.listEvents({ workspace: 'acpi' });
  assert.equal(event.workspace, 'acpi', "l'événement doit porter son workspace");
});

test('two workspaces writing at the same time never see each other', () => {
  const store = freshStore();
  const acpi = sessionFor(store, 'acpi');
  const demo = sessionFor(store, 'demo');

  // Entrelacé volontairement : c'est la situation réelle de deux `serve`
  // ouverts côte à côte, pas deux runs successifs.
  for (let i = 0; i < 5; i += 1) {
    dispatchAgentEvent(acpi, createAgentEvent('user_message', {
      origin: 'user', payload: { content: `acpi-${i}` },
    }));
    dispatchAgentEvent(demo, createAgentEvent('user_message', {
      origin: 'user', payload: { content: `demo-${i}` },
    }));
  }

  const acpiEvents = store.listEvents({ workspace: 'acpi' });
  const demoEvents = store.listEvents({ workspace: 'demo' });

  assert.equal(acpiEvents.length, 5);
  assert.equal(demoEvents.length, 5);
  assert.ok(acpiEvents.every((event) => event.payload.content.startsWith('acpi-')));
  assert.ok(demoEvents.every((event) => event.payload.content.startsWith('demo-')));
});

test('a conversation is rebuilt from its own workspace only', () => {
  // C'est ce qui décide de ce qu'affiche un `serve` au chargement. Un mélange
  // ici afficherait les échanges du voisin dans sa fenêtre de chat.
  const store = freshStore();
  const acpi = sessionFor(store, 'acpi');
  const demo = sessionFor(store, 'demo');

  dispatchAgentEvent(acpi, createAgentEvent('user_message', { origin: 'user', payload: { content: 'question acpi' } }));
  dispatchAgentEvent(demo, createAgentEvent('user_message', { origin: 'user', payload: { content: 'question demo' } }));
  dispatchAgentEvent(acpi, createAgentEvent('assistant_message', { origin: 'runtime', payload: { content: 'réponse acpi' } }));

  const projection = reduceAgentEvents(store.listEvents({ workspace: 'acpi' }));

  assert.deepEqual(projection.conversation.map((entry) => entry.content), [
    'question acpi',
    'réponse acpi',
  ]);
});

test('purging one workspace leaves the others intact', () => {
  // `/clear --all` depuis un `serve` ne doit pas vider le runtime du voisin.
  const store = freshStore();
  const acpi = sessionFor(store, 'acpi');
  const demo = sessionFor(store, 'demo');
  dispatchAgentEvent(acpi, createAgentEvent('user_message', { origin: 'user', payload: { content: 'a' } }));
  dispatchAgentEvent(demo, createAgentEvent('user_message', { origin: 'user', payload: { content: 'd' } }));

  store.clearWorkspaceState({ workspace: 'acpi' });

  assert.equal(store.listEvents({ workspace: 'acpi' }).length, 0);
  assert.equal(store.listEvents({ workspace: 'demo' }).length, 1);
});

test('a purge without a workspace wipes EVERY workspace', () => {
  /*
   Comportement délibéré (`/clear --all` global), mais qui n'est sûr que tant
   que l'appelant fournit toujours un workspace. Deux chemins le calculent en
   `?? null` :

     - `slash.js`  : `context.session.workspace ?? null`
     - `serve`     : `runtimePathForWorkspace` omet le paramètre si
                     `WORKSPACE_NAME` est vide, et `docker-compose.yml` le
                     déclare `${WORKSPACE_NAME:-}`.

   Une variable d'environnement absente élargit donc silencieusement la portée
   d'une opération destructrice. Ce test fige le comportement pour que le jour
   où on décide de refuser plutôt que d'élargir, ce soit un choix explicite.
  */
  const store = freshStore();
  dispatchAgentEvent(sessionFor(store, 'acpi'), createAgentEvent('user_message', { origin: 'user', payload: { content: 'a' } }));
  dispatchAgentEvent(sessionFor(store, 'demo'), createAgentEvent('user_message', { origin: 'user', payload: { content: 'd' } }));

  store.clearWorkspaceState({ workspace: null });

  assert.equal(store.listEvents({ workspace: 'acpi' }).length, 0);
  assert.equal(store.listEvents({ workspace: 'demo' }).length, 0);
});

test('the SSE publisher delivers an event only to its own workspace', () => {
  // Réplique exacte du filtre de `server.js`. Le tenir ici évite de démarrer
  // un serveur HTTP pour vérifier une condition d'une ligne — mais un écart
  // entre les deux serait invisible, d'où le test de source ci-dessous.
  const deliver = (clientWorkspace, eventWorkspace) =>
    !(clientWorkspace && eventWorkspace !== clientWorkspace);

  assert.equal(deliver('acpi', 'acpi'), true);
  assert.equal(deliver('acpi', 'demo'), false, 'un client scopé ne doit rien recevoir du voisin');
  assert.equal(deliver('acpi', null), false);
  // Le cas qui fuit : un abonné SANS workspace reçoit tout.
  assert.equal(deliver(null, 'acpi'), true);
  assert.equal(deliver(null, 'demo'), true);
});

test('the publisher filter in server.js is the one tested above', () => {
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  assert.match(source, /if \(client\.workspace && event\.workspace !== client\.workspace\) continue;/);
  assert.match(source, /if \(client\.workspace && client\.workspace !== workspace\) continue;/);
});

test('every client subscribes with the workspace it is scoped to', () => {
  // Les deux consommateurs du flux. S'abonner sans workspace est le seul
  // moyen de recevoir les événements des autres : c'est là que se joue
  // l'isolation, pas dans le filtre.
  const shell = readFileSync(new URL('../shell/useSession.ts', import.meta.url), 'utf8');
  assert.match(shell, /workspace: \(session as any\)\.workspace \?\? null,/);
  // Et il se réabonne quand l'opérateur change de workspace, sinon il
  // continuerait d'écouter le précédent.
  assert.match(shell, /function resyncRuntimeWorkspaceIfChanged\(\)/);
  assert.match(shell, /runtimeStreamAbort\?\.abort\(\);\s*\n\s*syncRuntimeState\(\);\s*\n\s*void subscribeRuntimeEvents\(\);/);
});

test('locks are per run, so one workspace never blocks another', async () => {
  // `ingest_apply` est sérialisé par construction. Si le gestionnaire de
  // verrous était global au processus, deux workspaces ingérant en parallèle
  // se bloqueraient mutuellement — pas une fuite, mais une contention
  // invisible et très difficile à diagnostiquer.
  const { createLockManager } = await import('../orchestrator/lockManager.js');
  const runA = createLockManager();
  const runB = createLockManager();

  assert.ok(runA.acquire({ locks: ['ingest_apply'] }));
  assert.ok(runB.acquire({ locks: ['ingest_apply'] }), 'deux runs distincts ne partagent pas leurs verrous');

  const runner = readFileSync(new URL('./runner.js', import.meta.url), 'utf8');
  assert.match(runner, /const attempts = attemptManager \?\? createAttemptManager\(\);/);
});
