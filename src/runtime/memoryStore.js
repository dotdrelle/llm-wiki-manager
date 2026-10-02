import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_FACT_CHARS = 400;

/** Workspace-scoped factual memory, stored in the runtime's SQLite database. */
export function openMemoryStore({ stateDir, fileName = 'runtime.db' } = {}) {
  if (!stateDir) throw new Error('Memory store requires a resolved runtime state directory.');
  const dir = resolve(stateDir);
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, fileName));
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_items (
      workspace TEXT NOT NULL,
      key TEXT NOT NULL,
      text TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('decision','preference','convention','open_question')),
      embedding TEXT,
      conversation_id TEXT,
      turn_id TEXT,
      evidence TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace, key)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_workspace_updated ON memory_items(workspace, updated_at DESC);
    CREATE TABLE IF NOT EXISTS memory_history (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      key TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('ADD','UPDATE','DELETE','RESTORE')),
      previous_value TEXT,
      current_value TEXT,
      conversation_id TEXT,
      turn_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_history_workspace ON memory_history(workspace, created_at DESC);
  `);
  const columns = new Set(db.prepare('PRAGMA table_info(memory_items)').all().map((row) => row.name));
  if (!columns.has('embedding')) db.exec('ALTER TABLE memory_items ADD COLUMN embedding TEXT');
  const get = db.prepare('SELECT * FROM memory_items WHERE workspace = ? AND key = ?');
  const list = db.prepare('SELECT * FROM memory_items WHERE workspace = ? ORDER BY updated_at DESC, key');
  const history = db.prepare('SELECT * FROM memory_history WHERE workspace = ? AND key = ? ORDER BY created_at DESC');
  const insertHistory = db.prepare(`INSERT INTO memory_history
    (id, workspace, key, operation, previous_value, current_value, conversation_id, turn_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  function rowValue(row) {
    if (!row) return null;
    return { key: row.key, text: row.text, kind: row.kind, embedding: row.embedding ? JSON.parse(row.embedding) : null, conversationId: row.conversation_id ?? null,
      turnId: row.turn_id ?? null, evidence: JSON.parse(row.evidence), createdAt: row.created_at, updatedAt: row.updated_at };
  }
  function save({ workspace, key = randomUUID(), text, kind = 'convention', embedding = null, conversationId = null, turnId = null, evidence = [], historyOperation = null }) {
    if (!workspace || typeof workspace !== 'string') throw new Error('A resolved workspace is required for memory writes.');
    const value = String(text ?? '').trim();
    if (!value) throw new Error('Memory text is required.');
    const bounded = value.slice(0, MAX_FACT_CHARS);
    if (!['decision', 'preference', 'convention', 'open_question'].includes(kind)) throw new Error(`Unsupported memory kind: ${kind}`);
    const now = new Date().toISOString();
    const previous = get.get(workspace, key);
    const vector = Array.isArray(embedding) && embedding.length <= 4096 && embedding.every(Number.isFinite) ? embedding : null;
    const next = { key, text: bounded, kind, embedding: vector, conversationId, turnId, evidence: Array.isArray(evidence) ? evidence.slice(0, 8) : [] };
    const operation = previous ? 'UPDATE' : 'ADD';
    db.exec('BEGIN IMMEDIATE');
    try {
      insertHistory.run(randomUUID(), workspace, key, historyOperation ?? operation, previous ? JSON.stringify(rowValue(previous)) : null,
        JSON.stringify(next), conversationId, turnId, now);
      db.prepare(`INSERT INTO memory_items
        (workspace,key,text,kind,embedding,conversation_id,turn_id,evidence,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(workspace,key) DO UPDATE SET text=excluded.text,kind=excluded.kind,
        embedding=excluded.embedding,
        conversation_id=excluded.conversation_id,turn_id=excluded.turn_id,evidence=excluded.evidence,updated_at=excluded.updated_at`)
        .run(workspace, key, bounded, kind, vector ? JSON.stringify(vector) : null, conversationId, turnId, JSON.stringify(next.evidence), previous?.created_at ?? now, now);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return rowValue(get.get(workspace, key));
  }
  function remove({ workspace, key, conversationId = null, turnId = null }) {
    if (!workspace) throw new Error('A resolved workspace is required for memory writes.');
    const previous = get.get(workspace, key);
    if (!previous) return false;
    db.exec('BEGIN IMMEDIATE');
    try {
      insertHistory.run(randomUUID(), workspace, key, 'DELETE', JSON.stringify(rowValue(previous)), null,
        conversationId, turnId, new Date().toISOString());
      db.prepare('DELETE FROM memory_items WHERE workspace = ? AND key = ?').run(workspace, key);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return true;
  }
  function search({ workspace, query, queryEmbedding = null, limit = 8 }) {
    if (!workspace) return [];
    const normalize = (value) => String(value ?? '').toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const terms = normalize(query).split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length > 1);
    if (!terms.length && !Array.isArray(queryEmbedding)) return [];
    const items = list.all(workspace).map(rowValue);
    const normalizedTexts = items.map((item) => normalize(item.text));
    const documentFrequency = new Map(terms.map((term) => [term,
      normalizedTexts.reduce((count, text) => count + (text.includes(term) ? 1 : 0), 0)]));
    const allHaveVectors = Array.isArray(queryEmbedding) && queryEmbedding.length > 0
      && items.length > 0 && items.every((item) => Array.isArray(item.embedding) && item.embedding.length === queryEmbedding.length);
    const cosine = (a, b) => {
      let dot = 0; let normA = 0; let normB = 0;
      for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; normA += a[i] ** 2; normB += b[i] ** 2; }
      return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
    };
    return items.map((item) => ({ item,
      vectorScore: allHaveVectors ? cosine(queryEmbedding, item.embedding) : null,
      score: terms.reduce((score, term) => {
        const text = normalize(item.text);
        if (!text.includes(term)) return score;
        const frequency = documentFrequency.get(term) ?? items.length;
        const inverseFrequency = Math.log(1 + (items.length - frequency + 0.5) / (frequency + 0.5));
        return score + inverseFrequency;
      }, 0),
    })).filter((entry) => allHaveVectors || entry.score > 0)
      .sort((a, b) => allHaveVectors ? b.vectorScore - a.vectorScore || b.score - a.score : b.score - a.score || b.item.updatedAt.localeCompare(a.item.updatedAt))
      .slice(0, Math.max(1, Math.min(20, Number(limit) || 8))).map(({ item, score, vectorScore }) => ({ ...item, score, ...(vectorScore == null ? {} : { vectorScore }) }));
  }
  function extractionNeighbors({ workspace, query, queryEmbedding = null, limit = 8, recentLimit = 30 }) {
    if (!workspace) return [];
    const matched = search({ workspace, query, queryEmbedding, limit });
    const byKey = new Map(matched.map((item) => [item.key, item]));
    // Recent facts are a bounded contradiction-recall lane: after one set of
    // updates, their lexical overlap can crowd a later contradicted fact out
    // of the top-K. Keep a small recent window alongside semantic/lexical
    // matches; the extractor still must name an existing key and quote user
    // evidence before an UPDATE can apply.
    for (const item of list.all(workspace).slice(0, Math.max(0, Math.min(30, recentLimit))).map(rowValue)) {
      if (!byKey.has(item.key)) byKey.set(item.key, item);
    }
    return [...byKey.values()];
  }
  function restore({ workspace, key, historyId }) {
    const version = history.all(workspace, key).find((row) => row.id === historyId);
    if (!version?.previous_value) throw new Error('Selected memory history version cannot be restored.');
    const previous = JSON.parse(version.previous_value);
    return save({ workspace, key, ...previous, conversationId: null, turnId: null, historyOperation: 'RESTORE' });
  }
  function clearWorkspace(workspace) {
    if (!workspace) throw new Error('A resolved workspace is required for memory deletion.');
    db.exec('BEGIN IMMEDIATE');
    try {
      const items = Number(db.prepare('DELETE FROM memory_items WHERE workspace = ?').run(workspace).changes ?? 0);
      const versions = Number(db.prepare('DELETE FROM memory_history WHERE workspace = ?').run(workspace).changes ?? 0);
      db.exec('COMMIT');
      return { items, versions };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return {
    list: (workspace) => workspace ? list.all(workspace).map(rowValue) : [],
    get: (workspace, key) => workspace ? rowValue(get.get(workspace, key)) : null,
    history: (workspace, key) => workspace && key ? history.all(workspace, key).map((row) => ({
      id: row.id, operation: row.operation, previous: row.previous_value ? JSON.parse(row.previous_value) : null,
      current: row.current_value ? JSON.parse(row.current_value) : null, conversationId: row.conversation_id ?? null,
      turnId: row.turn_id ?? null, createdAt: row.created_at,
    })) : [],
    save, remove, search, extractionNeighbors, restore, clearWorkspace, close: () => db.close(),
  };
}
