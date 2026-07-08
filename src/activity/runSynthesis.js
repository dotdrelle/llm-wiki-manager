export function initialSynthesisFromEvents(events = []) {
  for (const event of [...(events ?? [])].reverse()) {
    const synthesis = event.payload?.fragment?.summary?.initialSynthesis
      ?? event.payload?.normalizedFragment?.summary?.initialSynthesis
      ?? event.payload?.summary?.initialSynthesis;
    if (Array.isArray(synthesis)) return synthesis.map(String);
  }
  return [];
}

export function initialSynthesisFromState(state = {}, events = []) {
  const direct = state.summary?.initialSynthesis ?? state.activity?.initialSynthesis;
  if (Array.isArray(direct)) return direct.map(String);
  return initialSynthesisFromEvents(events);
}
