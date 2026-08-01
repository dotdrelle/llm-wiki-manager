import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DISCOVERY_TIMEOUT_MS,
  classifyModelEntry,
  describeFetchError,
  fetchServerCatalog,
  fallbackModels,
  fetchGatewayCatalog,
  fetchModels,
  requiresBaseUrl,
  transportSummary,
} from './modelFetch.js';

test('fetchModels returns remote OpenAI-compatible model ids', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ data: [{ id: 'b-model' }, { id: 'a-model' }] }),
  });
  try {
    const result = await fetchModels('openai', 'http://models.local', 'key', { timeoutMs: 100 });
    assert.deepEqual(result, { ok: true, models: ['a-model', 'b-model'], source: 'remote' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchModels falls back on invalid remote response', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ data: [] }),
  });
  try {
    const result = await fetchModels('openai', 'http://models.local', 'key', { timeoutMs: 100 });
    assert.equal(result.ok, false);
    assert.equal(result.source, 'fallback');
    assert.ok(result.models.includes('gpt-5.4-mini'));
    assert.match(result.error, /No models returned/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fallbackModels leaves custom-model to the wizard append action', () => {
  assert.deepEqual(fallbackModels('generic'), ['gpt-4.1-mini', 'llama3.2']);
});

test('fetchGatewayCatalog types models from /model/info', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, 'http://gw:4000/model/info');
    return {
      ok: true,
      json: async () => ({
        data: [
          { model_name: 'anthropic/claude-sonnet-4-5', model_info: { mode: 'chat' } },
          { model_name: 'infinity/bge-m3', model_info: { mode: 'embedding' } },
          { model_name: 'infinity/bge-reranker', model_info: { mode: 'rerank' } },
          { model_name: 'dalle', model_info: { mode: 'image_generation' } },
        ],
      }),
    };
  };
  try {
    const result = await fetchGatewayCatalog('http://gw:4000/v1', 'key', { timeoutMs: 100 });
    assert.equal(result.ok, true);
    assert.equal(result.typed, true);
    assert.deepEqual(result.chat, ['anthropic/claude-sonnet-4-5']);
    assert.deepEqual(result.embedding, ['infinity/bge-m3']);
    assert.deepEqual(result.rerank, ['infinity/bge-reranker']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchGatewayCatalog degrades to an untyped /v1/models list', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.endsWith('/model/info')) return { ok: false, status: 404 };
    return { ok: true, json: async () => ({ data: [{ id: 'b' }, { id: 'a' }] }) };
  };
  try {
    const result = await fetchGatewayCatalog('http://gw:4000/v1', 'key', { timeoutMs: 100 });
    assert.equal(result.ok, true);
    assert.equal(result.typed, false);
    // Non typé : les trois listes reçoivent la même chose, à charge du wizard
    // de le signaler.
    assert.deepEqual(result.chat, ['a', 'b']);
    assert.deepEqual(result.embedding, ['a', 'b']);
    assert.deepEqual(result.rerank, ['a', 'b']);
    assert.match(result.error, /HTTP 404/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchGatewayCatalog reports an unreachable gateway without inventing models', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  try {
    const result = await fetchGatewayCatalog('http://gw:4000/v1', 'key', { timeoutMs: 100 });
    assert.equal(result.ok, false);
    assert.equal(result.source, 'unreachable');
    assert.deepEqual(result.chat, []);
    assert.match(result.error, /ECONNREFUSED/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchGatewayCatalog queries /model/info and /v1/models in parallel', async () => {
  const originalFetch = globalThis.fetch;
  const started = [];
  let releaseModelInfo;
  const modelInfoGate = new Promise((resolve) => { releaseModelInfo = resolve; });
  globalThis.fetch = async (url) => {
    started.push(url);
    if (url.endsWith('/model/info')) {
      await modelInfoGate;
      return { ok: false, status: 404 };
    }
    return { ok: true, json: async () => ({ data: [{ id: 'a' }] }) };
  };
  try {
    const pending = fetchGatewayCatalog('http://gw:4000/v1', 'key', { timeoutMs: 100 });
    // Le repli ne doit pas attendre la fin du chemin typé : les deux requêtes
    // sont déjà parties quand /model/info est encore en vol.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started.length, 2);
    releaseModelInfo();
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.typed, false);
    assert.deepEqual(result.chat, ['a']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('HTTP failures name the likely cause instead of a bare status', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 401 });
  try {
    const result = await fetchModels('openai', 'https://api.openai.com/v1', 'bad', {
      timeoutMs: 50,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /HTTP 401/);
    assert.match(result.error, /API key rejected/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('describeFetchError turns transport codes into an actionable sentence', () => {
  const tls = Object.assign(new Error('fetch failed'), {
    cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' },
  });
  assert.match(describeFetchError(tls, { url: 'https://gw:4000/v1/models' }), /--cacert/);

  const refused = Object.assign(new Error('fetch failed'), {
    cause: { code: 'ECONNREFUSED' },
  });
  assert.match(describeFetchError(refused, { url: 'http://gw:4000/v1' }), /gw:4000/);

  const dns = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  assert.match(describeFetchError(dns, { url: 'http://nope.local/v1' }), /host not found/);

  // Le délai en millisecondes est un détail d'implémentation : le message
  // nomme l'hôte muet et les causes probables, pas la valeur du timeout.
  const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const timedOut = describeFetchError(aborted, { url: 'http://gw:4000/v1', timeoutMs: 8000 });
  assert.match(timedOut, /gw:4000 did not answer in time/);
  assert.match(timedOut, /proxy or firewall/);
  assert.doesNotMatch(timedOut, /\d+ ms/);
});

test('transportSummary warns when a declared proxy is not actually used', () => {
  assert.match(
    transportSummary({ HTTPS_PROXY: 'http://proxy:3128' }),
    /NODE_USE_ENV_PROXY not set/,
  );
  assert.match(
    transportSummary({ HTTPS_PROXY: 'http://proxy:3128', NODE_USE_ENV_PROXY: '1' }),
    /proxy http:\/\/proxy:3128/,
  );
  assert.match(transportSummary({}), /direct connection/);
  assert.match(transportSummary({ WIKI_MANAGER_CACERT_PATH: '/ca.pem' }), /CA \/ca\.pem/);
});

test('the discovery timeout only bounds silent failures, never a healthy endpoint', () => {
  // Assez long pour un endpoint distant lent, assez court pour qu'un proxy qui
  // avale la connexion finisse par se dénoncer. Il n'est jamais attendu par
  // une étape du wizard : la découverte tourne en tâche de fond.
  assert.ok(DISCOVERY_TIMEOUT_MS >= 5000 && DISCOVERY_TIMEOUT_MS <= 15000);
});

test('the gateway hands over the flat list before /model/info completes', async () => {
  const originalFetch = globalThis.fetch;
  let releaseModelInfo;
  const modelInfoGate = new Promise((resolve) => { releaseModelInfo = resolve; });
  globalThis.fetch = async (url) => {
    if (url.endsWith('/model/info')) {
      await modelInfoGate;
      return {
        ok: true,
        json: async () => ({
          data: [{ model_name: 'chat-a', model_info: { mode: 'chat' } }],
        }),
      };
    }
    return { ok: true, json: async () => ({ data: [{ id: 'chat-a' }, { id: 'embed-b' }] }) };
  };
  try {
    const partials = [];
    const pending = fetchGatewayCatalog('http://gw:4000/v1', 'key', {
      timeoutMs: 100,
      onPartial: (partial) => partials.push(partial),
    });
    // La liste plate doit être livrée pendant que /model/info est encore en vol.
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(partials.length, 1);
    assert.equal(partials[0].typed, false);
    assert.deepEqual(partials[0].chat, ['chat-a', 'embed-b']);

    releaseModelInfo();
    const result = await pending;
    assert.equal(result.typed, true);
    assert.deepEqual(result.chat, ['chat-a']);
    // Le typage arrivé, plus aucune livraison partielle ne doit suivre.
    assert.equal(partials.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('classifyModelEntry reads the type hints real servers actually send', () => {
  // Albert.
  assert.equal(classifyModelEntry({ type: 'text-generation' }), 'chat');
  assert.equal(classifyModelEntry({ type: 'text-embeddings-inference' }), 'embedding');
  assert.equal(classifyModelEntry({ type: 'text-classification' }), 'rerank');
  // Hors périmètre : absent des trois listes plutôt que mal classé.
  assert.equal(classifyModelEntry({ type: 'automatic-speech-recognition' }), null);
  // LiteLLM.
  assert.equal(classifyModelEntry({ model_info: { mode: 'embedding' } }), 'embedding');
  // OpenAI ne type rien : `object: "model"` ne doit pas être pris pour un type.
  assert.equal(classifyModelEntry({ id: 'gpt-4.1', object: 'model' }), null);
});

test('fetchServerCatalog splits a direct server catalog by model type', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      data: [
        { id: 'openai/gpt-oss-120b', type: 'text-generation' },
        { id: 'bge-m3', type: 'text-embeddings-inference' },
        { id: 'bge-reranker-v2-m3', type: 'text-classification' },
        { id: 'whisper-large-v3', type: 'automatic-speech-recognition' },
      ],
    }),
  });
  try {
    const result = await fetchServerCatalog('openai-compatible', 'https://albert.example/v1', 'key', {
      engine: 'albert',
      timeoutMs: 100,
    });
    assert.equal(result.ok, true);
    assert.equal(result.typed, true);
    assert.deepEqual(result.chat, ['openai/gpt-oss-120b']);
    assert.deepEqual(result.embedding, ['bge-m3']);
    assert.deepEqual(result.rerank, ['bge-reranker-v2-m3']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchServerCatalog stays untyped when the server types nothing', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ data: [{ id: 'b', object: 'model' }, { id: 'a', object: 'model' }] }),
  });
  try {
    const result = await fetchServerCatalog('openai-compatible', 'https://api.openai.com/v1', 'key', {
      engine: 'openai',
      timeoutMs: 100,
    });
    assert.equal(result.typed, false);
    assert.deepEqual(result.chat, ['a', 'b']);
    assert.deepEqual(result.embedding, ['a', 'b']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a partially typed catalog falls back to the full list, never to an empty one', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      data: [{ id: 'embed-only', type: 'text-embeddings-inference' }, { id: 'mystery' }],
    }),
  });
  try {
    const result = await fetchServerCatalog('openai-compatible', 'https://x/v1', 'key', {
      timeoutMs: 100,
    });
    assert.equal(result.typed, true);
    assert.deepEqual(result.embedding, ['embed-only']);
    // Aucun modèle annoncé comme chat : proposer toute la liste vaut mieux
    // qu'une étape sans aucune suggestion.
    assert.deepEqual(result.chat, ['embed-only', 'mystery']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('requiresBaseUrl follows the engine, and the gateway always needs one', () => {
  assert.equal(requiresBaseUrl('openai-compatible', 'ollama'), true);
  assert.equal(requiresBaseUrl('openai-compatible', 'openai'), false);
  assert.equal(requiresBaseUrl('openai-compatible', 'anthropic'), false);
  assert.equal(requiresBaseUrl('ai-gateway', 'openai'), true);
});
