// OpenAI-style function calling accepts only an object schema at the top
// level, without oneOf/anyOf/allOf/enum/const/not there — a gpt-5/6 endpoint
// answers HTTP 400 for the WHOLE turn when one tool breaks the rule (agent-
// production's agent_status declares `oneOf: [{required:[jobId]}, …]`). The
// model receives the schema without those keys, and an alternative of
// required fields is stated in the description instead; the MCP server still
// validates the real arguments against its own schema.
const TOP_LEVEL_COMBINATORS = ['oneOf', 'anyOf', 'allOf', 'enum', 'const', 'not'];

export function llmToolParameters(inputSchema) {
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    return { parameters: { type: 'object', properties: {} }, note: '' };
  }
  const dropped = TOP_LEVEL_COMBINATORS.filter((key) => Object.hasOwn(inputSchema, key));
  if (!dropped.length && inputSchema.type === 'object') return { parameters: inputSchema, note: '' };
  const parameters = { ...inputSchema, type: 'object' };
  for (const key of dropped) delete parameters[key];
  if (!parameters.properties || typeof parameters.properties !== 'object') parameters.properties = {};
  const alternatives = [...(inputSchema.oneOf ?? []), ...(inputSchema.anyOf ?? [])]
    .map((branch) => (Array.isArray(branch?.required) && branch.required.length ? branch.required.join(' + ') : ''))
    .filter(Boolean);
  const note = alternatives.length ? `Arguments: provide ${alternatives.join(', or ')}.` : '';
  return { parameters, note };
}

export function llmToolFunction(name, description, inputSchema) {
  const { parameters, note } = llmToolParameters(inputSchema);
  return { name, description: [description, note].filter(Boolean).join(' '), parameters };
}

// MCP servers should declare openWorldHint. Some deployed servers omit or
// misstate it, so recover a clearly described web operation from the
// server-published name/description as well.
export function toolReachesOpenWeb(tool) {
  const declared = tool?.annotations?.openWorldHint;
  if (declared === true) return true;
  const text = `${tool?.name ?? ''} ${tool?.description ?? ''}`
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
  return /\b(web|internet|online|website|webpage)\b/.test(text)
    && /\b(search|fetch|crawl|read|retrieve|open)\b/.test(text);
}

// The tools that reach the open web, from their MCP annotation or an
// unambiguous server-published web operation description — no connector named
// in code. Listed without this, "cherche sur internet" went to an intranet
// search (a Confluence connector) that never reaches the internet.
export function openWebToolsRule(tools) {
  const names = (Array.isArray(tools) ? tools : []).filter((item) => item?.openWorld).map((item) => item.function?.name).filter(Boolean);
  if (!names.length) return '';
  return `Tools that reach the open web: ${names.join(', ')}. For an internet/web request, call one of these before answering — another connector's search (an intranet, a document store, the wiki) does not reach the internet and is never a substitute.`;
}
