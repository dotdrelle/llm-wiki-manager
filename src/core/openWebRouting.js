import { mentionsAvailableExternalService } from './wikiPresearch.js';

function asksForOpenWeb(input) {
  const text = String(input ?? '').normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  return /\b(internet|web|online|en ligne|site officiel|documentation officielle|sources? officielles|official (?:website|documentation|sources?))\b/.test(text)
    || /\b(weather|meteo|forecast|previsions?)\b/.test(text);
}

function isClarificationPrompt(message) {
  const text = String(message ?? '').trim();
  return /[?？]$/.test(text)
    || /\b(?:il me faut|j'ai besoin de|please provide|i need (?:your|a|an)|tell me your|indique(?:z)?|precise(?:z)?|donne(?:z)?-moi)\b/i.test(text);
}

function continuesOpenWebRequest(input, history) {
  if (asksForOpenWeb(input)) return true;
  const last = history?.at(-1);
  if (last?.role !== 'assistant' || !isClarificationPrompt(last.content)) return false;
  const index = [...(history ?? [])].map((item, i) => ({ item, i }))
    .reverse()
    .find(({ item }) => item.role === 'user' && asksForOpenWeb(item.content))?.i;
  if (index === undefined || history.length - index > 7) return false;
  return history.slice(index + 1).every((item) => item.role !== 'user'
    || String(item.content ?? '').trim().split(/\s+/).length <= 12);
}

// A direct Internet request should not offer a competing intranet/document
// search. Keep the workspace wiki for combined questions. If the user names
// another connected service, preserve its tools for the requested comparison.
export function selectChatToolsForRequest(allowedTools, input, history) {
  const webTools = allowedTools.filter((item) => item.openWorld);
  const webIntent = continuesOpenWebRequest(input, history) && webTools.length > 0;
  if (!webIntent) return { tools: allowedTools, webIntent: false };
  const namedExternalService = mentionsAvailableExternalService(
    input,
    allowedTools.filter((item) => !item.openWorld),
  );
  if (namedExternalService) return { tools: allowedTools, webIntent: true };
  return {
    tools: allowedTools.filter((item) => {
      if (item.openWorld) return true;
      const server = String(item.function?.name ?? '').split('__', 1)[0];
      return ['llm-wiki', 'wiki', 'wiki-production'].includes(server);
    }),
    webIntent: true,
  };
}
