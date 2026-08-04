import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  isActive,
  isCancelled,
  isFailed,
  isPending,
  isSkipped,
  isSuccessful,
  isTerminal,
  isUnknownStatus,
  isUnsuccessfulTerminal,
  normalizeTaskStatus,
} from './taskStatuses.js';

test('les alias des agents externes tombent sur le même statut canonique', () => {
  for (const status of ['done', 'complete', 'completed', 'success', 'succeeded', 'DONE', ' Success ']) {
    assert.equal(normalizeTaskStatus(status), 'done', status);
  }
  for (const status of ['failed', 'error', 'stalled']) {
    assert.equal(normalizeTaskStatus(status), 'failed', status);
  }
  for (const status of ['cancelled', 'canceled']) {
    assert.equal(normalizeTaskStatus(status), 'cancelled', status);
  }
  for (const status of ['running', 'in_progress', 'started', 'starting']) {
    assert.equal(normalizeTaskStatus(status), 'running', status);
  }
});

test('les statuts d’attente restent distincts les uns des autres', () => {
  // Les confondre ferait disparaître les demandes d'approbation : une tâche
  // `waiting_approval` réduite à `pending` serait ordonnancée sans accord.
  assert.equal(normalizeTaskStatus('pending'), 'pending');
  assert.equal(normalizeTaskStatus('pending_approval'), 'pending_approval');
  assert.equal(normalizeTaskStatus('waiting_approval'), 'waiting_approval');
  for (const status of ['pending', 'pending_approval', 'waiting_approval']) {
    assert.equal(isPending(status), true, status);
    assert.equal(isTerminal(status), false, status);
  }
});

test('un statut inconnu vaut null, et null n’est ni un succès ni un échec', () => {
  // C'est tout l'objet du module : l'inconnu doit rester inconnu au lieu
  // d'être rangé du côté qui arrange l'appelant.
  assert.equal(normalizeTaskStatus('brouette'), null);
  assert.equal(isUnknownStatus('brouette'), true);
  assert.equal(isSuccessful('brouette'), false);
  assert.equal(isFailed('brouette'), false);
  assert.equal(isTerminal('brouette'), false);
  // Une absence de statut n'est pas un statut inconnu : c'est une absence.
  assert.equal(isUnknownStatus(''), false);
  assert.equal(isUnknownStatus(null), false);
  assert.equal(normalizeTaskStatus(undefined), null);
});

test('skipped est terminal, et terminal sans succès', () => {
  assert.equal(isSkipped('skipped'), true);
  assert.equal(isTerminal('skipped'), true);
  assert.equal(isSuccessful('skipped'), false);
  assert.equal(isUnsuccessfulTerminal('skipped'), true);
  for (const status of ['failed', 'error', 'cancelled', 'canceled']) {
    assert.equal(isUnsuccessfulTerminal(status), true, status);
  }
  assert.equal(isUnsuccessfulTerminal('done'), false);
  assert.equal(isActive('running'), true);
  assert.equal(isCancelled('canceled'), true);
});

/*
 Le vocabulaire ne vaut que s'il est le seul. Ce test échoue dès qu'un module
 réintroduit sa propre liste — c'est exactement par là que la divergence est
 revenue la première fois, une liste à la fois, chacune raisonnable seule.
*/
test('aucun module ne redéclare sa propre liste de statuts', () => {
  const root = new URL('../..', import.meta.url).pathname;
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith('.js') || entry.name.endsWith('.test.js')) continue;
      if (path.endsWith(join('orchestrator', 'taskStatuses.js'))) continue;
      const source = readFileSync(path, 'utf8');
      /*
       Une dérogation se déclare DANS le fichier concerné, pas dans une liste
       de chemins tenue ici. Un run peut être `interrupted`, un job de la file
       peut expirer : ces vocabulaires sont légitimement distincts. Mais une
       liste d'exceptions centralisée vieillit mal — elle survit au fichier
       qu'elle excusait, et redevient la liste locale qu'on voulait supprimer.
       Le marqueur vit à côté du code, se déplace avec lui et se lit avec lui.
      */
      if (source.includes('@statuses-vocabulary')) continue;
      // Une liste de statuts se reconnaît à la cohabitation de deux marqueurs
      // qui n'ont aucune raison de se croiser ailleurs.
      const suspicious = /['"](?:done|failed)['"][^\n]{0,120}['"](?:cancelled|canceled|succeeded|completed|error)['"]/;
      for (const line of source.split('\n')) {
        if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) continue;
        if (suspicious.test(line)) offenders.push(`${path.slice(root.length)}: ${line.trim().slice(0, 100)}`);
      }
    }
  };
  walk(join(root, 'src'));

  assert.deepEqual(offenders, []);
});
