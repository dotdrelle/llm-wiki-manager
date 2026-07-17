const HTTP_URL = /https?:\/\/[^\s<>"'`]+/giu;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/u;

function trimUrlEnd(value) {
  let url = value.replace(TRAILING_PUNCTUATION, '');
  while (url.endsWith(')') && (url.match(/\)/g)?.length ?? 0) > (url.match(/\(/g)?.length ?? 0)) {
    url = url.slice(0, -1);
  }
  while (url.endsWith(']') && (url.match(/\]/g)?.length ?? 0) > (url.match(/\[/g)?.length ?? 0)) {
    url = url.slice(0, -1);
  }
  return url;
}

export function httpLinkParts(value) {
  const text = String(value ?? '');
  const parts = [];
  let cursor = 0;
  for (const match of text.matchAll(HTTP_URL)) {
    const start = match.index ?? 0;
    const candidate = match[0];
    const url = trimUrlEnd(candidate);
    if (!url) continue;
    try {
      const parsed = new URL(url);
      if (!parsed.hostname || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) continue;
    } catch {
      continue;
    }
    if (start > cursor) parts.push({ text: text.slice(cursor, start) });
    parts.push({ text: url, url });
    cursor = start + url.length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts.length > 0 ? parts : [{ text }];
}

export function wrapHttpLinks(value, width) {
  const columns = Math.max(12, Number(width) || 12);
  const rows = [[]];
  let used = 0;
  for (const part of httpLinkParts(value)) {
    if (part.url) {
      const parsed = new URL(part.url);
      const label = `[link: ${parsed.hostname}]`;
      if (used > 0 && used + label.length > columns) {
        rows.push([]);
        used = 0;
      }
      rows.at(-1).push({ text: label, url: part.url });
      used += label.length;
      continue;
    }
    let rest = part.text;
    while (rest.length > 0) {
      if (used === columns) {
        rows.push([]);
        used = 0;
      }
      const piece = rest.slice(0, columns - used);
      rows.at(-1).push({ text: piece });
      used += piece.length;
      rest = rest.slice(piece.length);
    }
  }
  return rows;
}
