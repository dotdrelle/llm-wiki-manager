export function stripDsmlArtifacts(value) {
  return String(value ?? '')
    .replace(/<\s*[|｜]{2}\s*DSML\s*[|｜]{2}[^>\r\n]*(?:>|$)/gi, '')
    .replace(/^[^\S\r\n]*.*[|｜]{2}\s*DSML\s*[|｜]{2}.*(?:\r?\n|$)/gim, '')
    .replace(/\n{3,}/g, '\n\n');
}
