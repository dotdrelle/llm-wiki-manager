const collections = ['requests', 'reservations', 'cycles', 'events'];
const key = (name, row) => String(name === 'events' ? row.seq : row.id);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Versioned transport over the existing workspace SSE connection. */
export function maintenanceDelta(before, after) {
  const fields = {}, rows = {};
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (collections.includes(name)) continue;
    if (!equal(before[name], after[name])) fields[name] = after[name] ?? null;
  }
  for (const name of collections) {
    const previous = new Map((before[name] ?? []).map(row => [key(name, row), row]));
    const current = new Map((after[name] ?? []).map(row => [key(name, row), row]));
    const upserts = [...current].filter(([id, row]) => !equal(previous.get(id), row)).map(([, row]) => row);
    const removed = [...previous.keys()].filter(id => !current.has(id));
    const oldOrder = [...previous.keys()], order = [...current.keys()];
    if (upserts.length || removed.length || !equal(oldOrder, order)) {
      rows[name] = { upserts, removed, ...(!equal(oldOrder, order) ? { order } : {}) };
    }
  }
  return Object.keys(fields).length || Object.keys(rows).length ? { fields, rows } : null;
}

export function applyMaintenanceUpdate(state, update) {
  const stream = { epoch: update.epoch, revision: update.revision };
  if (update.kind === 'snapshot') return { ...update.snapshot, stream };
  if (state?.stream?.epoch !== update.epoch || update.baseRevision !== state.stream.revision) {
    if (state?.stream?.epoch === update.epoch && update.revision <= state.stream.revision) return state;
    throw new Error('maintenance_stream_gap');
  }
  const next = { ...state, ...update.delta.fields, stream };
  for (const [name, patch] of Object.entries(update.delta.rows)) {
    if (!collections.includes(name)) throw new Error('maintenance_stream_unknown_collection');
    const rows = new Map((state[name] ?? []).map(row => [key(name, row), row]));
    for (const id of patch.removed) rows.delete(id);
    for (const row of patch.upserts) rows.set(key(name, row), row);
    next[name] = patch.order ? patch.order.map(id => rows.get(id)).filter(Boolean) : [...rows.values()];
  }
  return next;
}
