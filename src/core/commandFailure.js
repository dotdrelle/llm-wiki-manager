// Docker and Compose speak to operators in their own vocabulary: exit codes,
// interpolation warnings, daemon socket paths, the full command line with every
// -f and --env-file. The ShellUI used to paste that verbatim into the
// conversation, so a missing image and an unreadable workspace looked identical
// — a wall of flags. Classify the failure into a stable reason code, hand the
// reason to Donna, and keep the raw text for the runtime log lane only.

const SIGNATURES = [
  {
    reason: 'docker-not-installed',
    match: (text) => /docker: (command )?not found|'docker' is not recognized/i.test(text),
  },
  {
    reason: 'docker-daemon-unavailable',
    match: (text) => /cannot connect to the docker daemon|is the docker daemon running|docker daemon is not running/i.test(text),
  },
  {
    reason: 'image-unavailable',
    match: (text) => /manifest unknown|pull access denied|no such image|image .* not found|repository does not exist/i.test(text),
  },
  {
    reason: 'port-already-in-use',
    match: (text) => /port is already allocated|address already in use|bind: permission denied/i.test(text),
  },
  {
    reason: 'unknown-service',
    match: (text) => /no such service|has no service/i.test(text),
  },
  {
    reason: 'permission-denied',
    match: (text) => /permission denied while trying to connect|got permission denied|operation not permitted/i.test(text),
  },
  {
    reason: 'workspace-path-unavailable',
    match: (text) => /no such file or directory|is not a directory|invalid mount config/i.test(text),
  },
  {
    reason: 'configuration-variable-missing',
    // Compose interpolation: only a real failure when the variable is required
    // (`${VAR:?...}`); the plain "not set" form is a warning we now avoid.
    match: (text) => /required variable .* is missing|variable is not set/i.test(text),
  },
  {
    reason: 'network-unreachable',
    match: (text) => /network is unreachable|temporary failure in name resolution|tls handshake timeout|proxyconnect/i.test(text),
  },
];

export function rawFailureText(err) {
  return [err?.stderr, err?.stdout, err?.message]
    .filter(Boolean)
    .map(String)
    .join('\n')
    .trim();
}

export function classifyCommandFailure(err) {
  if (err?.code === 'ENOENT') return 'command-not-found';
  const text = rawFailureText(err);
  if (!text) return 'unknown';
  for (const { reason, match } of SIGNATURES) {
    if (match(text)) return reason;
  }
  return 'unknown';
}

// The single line worth showing an operator when nothing matched: the last
// non-empty output line, stripped of the command echo and of absolute paths
// that only describe this machine's install layout.
export function failureHint(err, { maxLength = 200 } = {}) {
  const lines = rawFailureText(err)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^command failed:/i.test(line))
    .filter((line) => !/^time=".*"\s+level=warning/i.test(line))
    .filter((line) => !/^docker compose /i.test(line));
  const last = lines.at(-1) ?? '';
  const hint = last.replace(/(^|\s)(\/[^\s]+)/g, (match, prefix, path) => `${prefix}${path.split('/').at(-1)}`);
  return hint.length > maxLength ? `${hint.slice(0, maxLength - 1)}…` : hint;
}
