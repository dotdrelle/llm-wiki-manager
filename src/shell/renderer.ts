export function stripAnsi(value: string) {
  return String(value).replace(/\u001b\[[0-9;]*m/g, '');
}

export function stripDsmlArtifacts(value: string) {
  return String(value ?? '')
    .replace(/<\s*[|｜]{2}\s*DSML\s*[|｜]{2}[^>\r\n]*(?:>|$)/gi, '')
    .replace(/^[^\S\r\n]*.*[|｜]{2}\s*DSML\s*[|｜]{2}.*(?:\r?\n|$)/gim, '')
    .replace(/\n{3,}/g, '\n\n');
}

export function renderPlainMarkdown(value: string) {
  return stripAnsi(stripDsmlArtifacts(value))
    .replace(/\r\n/g, '\n')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')
    // table: remove separator rows (| :--- | --- |), then convert data rows
    .replace(/^\|[\s|:-]+\|$/gm, '')
    .replace(/^\|(.+)\|$/gm, (_match, inner) => {
      const cells = inner.split('|').map((c: string) => c.trim()).filter(Boolean);
      if (cells.length === 0) return '';
      if (cells.length === 2) return `${cells[0]}: ${cells[1]}`;
      return cells.join('  ');
    })
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    // collapse consecutive blank lines left by removed elements
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

export function colorForRenderedLine(line: string, role: string) {
  const text = String(line ?? '').trim();
  if (!text) return '#D6DEE8';
  if (role === 'user') return '#5DADE2';
  if (/^[●◐○]/.test(text)) {
    if (/\bconnected\b/i.test(text)) return '#8BD5CA';
    if (/\bconfigured\b/i.test(text)) return '#9CA3AF';
    return '#7F8C8D';
  }
  return '#D6DEE8';
}

export function helpCommandParts(line: string) {
  const trimmed = String(line ?? '').trim();
  if (!/^(\/[a-z0-9_-]+|Ctrl\+|-[a-z-]|--[a-z-])/i.test(trimmed)) return null;
  const parts = trimmed.split(/\s{2,}/).filter(Boolean);
  if (parts.length < 2) return null;
  if (!/^(\/[a-z0-9_-]+|Ctrl\+|-[a-z-]|--[a-z-])/i.test(parts[0])) return null;
  return parts;
}

export function keyValueParts(line: string) {
  // Matches KEY=value, Key: value, or "Multi Word Key: value" (up to 4 words, max 40 chars before separator)
  // Optionally preceded by a list marker (- or *)
  const match = String(line ?? '').match(/^(\s*(?:[-*]\s+)?)([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9_.() -]{0,38}?(?:=|:[ \t]+))(.*)$/);
  if (!match) return null;
  // Reject if key part looks like prose (more than 4 space-separated words)
  const keyPart = match[2].replace(/[=:].*/, '').trim();
  if (keyPart.split(/\s+/).length > 4) return null;
  return { prefix: match[1], key: match[2], value: match[3] ?? '' };
}

export function truncate(value: string, max = 96) {
  const text = stripAnsi(String(value ?? '')).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}
