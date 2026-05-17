#!/usr/bin/env node

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (!arg.startsWith('--')) continue;
  const key = arg.slice(2);
  const next = process.argv[i + 1];
  if (next && !next.startsWith('--')) {
    args.set(key, next);
    i += 1;
  } else {
    args.set(key, 'true');
  }
}

const baseUrl = (args.get('base-url') ?? process.env.ALBERT_BASE_URL ?? 'https://albert.api.etalab.gouv.fr/v1').replace(/\/$/, '');
const mode = args.get('mode') ?? 'embeddings';
const count = Number(args.get('count') ?? 12);
const delayMs = Number(args.get('delay-ms') ?? 0);
const tokenA = process.env.ALBERT_TOKEN_A;
const tokenB = process.env.ALBERT_TOKEN_B;

const models = {
  chat: args.get('chat-model') ?? process.env.ALBERT_CHAT_MODEL ?? 'openai/gpt-oss-120b',
  embeddings: args.get('embedding-model') ?? process.env.ALBERT_EMBEDDING_MODEL ?? 'BAAI/bge-m3',
};

if (!tokenA || !tokenB) {
  console.error('Missing ALBERT_TOKEN_A or ALBERT_TOKEN_B.');
  console.error('Example: ALBERT_TOKEN_A=... ALBERT_TOKEN_B=... node tools/albert-rate-test.mjs --mode embeddings --count 12');
  process.exit(2);
}

if (!Number.isFinite(count) || count < 1) {
  console.error('--count must be a positive number.');
  process.exit(2);
}

if (!['embeddings', 'chat'].includes(mode)) {
  console.error('--mode must be either embeddings or chat.');
  process.exit(2);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function interestingHeaders(headers) {
  const out = {};
  for (const [key, value] of headers.entries()) {
    const normalized = key.toLowerCase();
    if (
      normalized === 'retry-after' ||
      normalized.includes('ratelimit') ||
      normalized.includes('request-id') ||
      normalized === 'x-request-id'
    ) {
      out[key] = value;
    }
  }
  return out;
}

function requestBody(label, index) {
  if (mode === 'chat') {
    return {
      model: models.chat,
      messages: [
        { role: 'system', content: 'Answer with one short word.' },
        { role: 'user', content: `ping ${label} ${index}` },
      ],
      max_tokens: 1,
      temperature: 0,
    };
  }
  return {
    model: models.embeddings,
    input: [`rate test ${label} ${index}`],
  };
}

async function oneRequest(label, token, index) {
  const started = Date.now();
  const path = mode === 'chat' ? '/chat/completions' : '/embeddings';
  let status = 0;
  let headers = {};
  let body = '';
  let ok = false;

  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody(label, index)),
    });
    status = res.status;
    headers = interestingHeaders(res.headers);
    ok = res.ok;
    if (!res.ok) {
      body = (await res.text()).slice(0, 300).replace(/\s+/g, ' ');
    } else {
      await res.arrayBuffer();
    }
  } catch (error) {
    body = error instanceof Error ? error.message : String(error);
  }

  return {
    label,
    index,
    ok,
    status,
    ms: Date.now() - started,
    headers,
    error: body,
  };
}

async function runSeries(label, token, n) {
  const results = [];
  for (let i = 1; i <= n; i += 1) {
    const result = await oneRequest(label, token, i);
    results.push(result);
    printResult(result);
    if (delayMs > 0) await wait(delayMs);
  }
  return results;
}

async function runInterleaved(n) {
  const results = [];
  for (let i = 1; i <= n; i += 1) {
    for (const [label, token] of [
      ['A', tokenA],
      ['B', tokenB],
    ]) {
      const result = await oneRequest(label, token, i);
      results.push(result);
      printResult(result);
      if (delayMs > 0) await wait(delayMs);
    }
  }
  return results;
}

function printResult(result) {
  const headers = Object.keys(result.headers).length > 0 ? ` headers=${JSON.stringify(result.headers)}` : '';
  const error = result.error ? ` error="${result.error}"` : '';
  console.log(`${result.label}#${result.index}\tstatus=${result.status}\tok=${result.ok}\tms=${result.ms}${headers}${error}`);
}

function summarize(name, results) {
  const byStatus = new Map();
  for (const result of results) {
    byStatus.set(result.status, (byStatus.get(result.status) ?? 0) + 1);
  }
  const statuses = [...byStatus.entries()]
    .sort(([a], [b]) => a - b)
    .map(([status, total]) => `${status}:${total}`)
    .join(', ');
  console.log(`\n${name}: ${statuses}`);
}

console.log(`baseUrl=${baseUrl}`);
console.log(`mode=${mode}`);
console.log(`count=${count}`);
console.log(`delayMs=${delayMs}`);
console.log('');

console.log('Phase 1: token A only');
const phaseA = await runSeries('A', tokenA, count);
summarize('Phase 1', phaseA);

console.log('\nPhase 2: token B immediately after token A');
const phaseB = await runSeries('B', tokenB, Math.min(3, count));
summarize('Phase 2', phaseB);

console.log('\nPhase 3: interleaved A/B');
const phaseInterleaved = await runInterleaved(Math.ceil(count / 2));
summarize('Phase 3', phaseInterleaved);

console.log('\nReading guide:');
console.log('- If A hits 429 and B also hits 429 immediately, the limit is probably account-wide, IP-wide, or endpoint-wide.');
console.log('- If A hits 429 but B still succeeds, the limit is probably API-key scoped.');
console.log('- If interleaved A/B allows about twice as many requests before 429, the limit is probably per key.');
