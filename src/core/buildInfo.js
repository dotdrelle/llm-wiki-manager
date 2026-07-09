import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..', '..');

let cachedCommit;

// Short git commit identifying the code actually running. Resolution order:
// 1. Live git HEAD when running from the development repository — accurate
//    even between releases (dirty trees still show the base commit).
// 2. buildInfo.json generated at pack time (scripts/check-versions.js) —
//    what a published/global install carries.
// 3. null — displayed as "+dev" so an untraceable build is visible at a
//    glance instead of silently pretending to match the repo.
export function buildCommit() {
  if (cachedCommit !== undefined) return cachedCommit;
  cachedCommit = liveGitCommit() ?? packagedCommit();
  return cachedCommit;
}

export function versionWithBuild(packageJson) {
  const version = String(packageJson?.version ?? '').trim();
  const commit = buildCommit();
  return commit ? `${version}+${commit}` : `${version}+dev`;
}

function liveGitCommit() {
  try {
    // Guard against walking up into an unrelated parent repository when the
    // package is installed under a directory that happens to be git-tracked.
    const toplevel = git(['rev-parse', '--show-toplevel']);
    if (!toplevel || resolve(toplevel) !== packageRoot) return null;
    return git(['rev-parse', '--short', 'HEAD']);
  } catch {
    return null;
  }
}

function git(args) {
  const output = execFileSync('git', args, {
    cwd: packageRoot,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 2000,
  }).toString().trim();
  return output || null;
}

function packagedCommit() {
  try {
    const info = JSON.parse(readFileSync(join(here, 'buildInfo.json'), 'utf8'));
    return info?.commit ? String(info.commit) : null;
  } catch {
    return null;
  }
}
