export function stripDsmlArtifacts(value) {
  return String(value ?? '')
    // Whole lines first: removing the tags alone left their values behind.
    .replace(/^[^\S\r\n]*.*[|｜]{1,2}\s*DSML\s*[|｜]{1,2}.*(?:\r?\n|$)/gim, '')
    .replace(/<\s*\/?\s*[|｜]{1,2}\s*DSML\s*[|｜]{1,2}[^>\r\n]*(?:>|$)/gi, '')
    .replace(/\n{3,}/g, '\n\n');
}

// DeepSeek's native tool-call markup (DSML), written as TEXT instead of a
// structured tool_call:
//   <｜DSML｜function_calls>
//   <｜DSML｜invoke name="runtime__run_skill">
//   <｜DSML｜parameter name="skillName" string="true">new-template</｜DSML｜parameter>
//   </｜DSML｜invoke>
//   </｜DSML｜function_calls>
// Shown as an answer it reads like garbage (or an attack) and runs nothing.
// The bars may be ASCII or fullwidth, single or doubled.
const DSML_BAR = '\\s*[|｜]{1,2}\\s*DSML\\s*[|｜]{1,2}\\s*';
const DSML_INVOKE = new RegExp(`<${DSML_BAR}invoke\\s+name\\s*=\\s*"([^"]+)"\\s*>([\\s\\S]*?)<\\s*/${DSML_BAR}invoke\\s*>`, 'gi');
const DSML_PARAMETER = new RegExp(`<${DSML_BAR}parameter\\s+name\\s*=\\s*"([^"]+)"([^>]*)>([\\s\\S]*?)<\\s*/${DSML_BAR}parameter\\s*>`, 'gi');
const DSML_ANY = new RegExp(`<\\s*/?${DSML_BAR}`, 'i');

export function hasDsmlMarkup(value) {
  return DSML_ANY.test(String(value ?? ''));
}

// The name of the first tool a DSML block invokes, complete or not.
export function dsmlInvokedName(value) {
  const match = String(value ?? '').match(new RegExp(`<${DSML_BAR}invoke\\s+name\\s*=\\s*"([^"]+)"`, 'i'));
  return match ? match[1] : null;
}

// Complete DSML invocations → OpenAI-shaped tool calls. `string="true"` marks a
// raw string; any other value is JSON. Returns null when a block is
// incomplete or a value does not parse: a guessed argument is worse than a retry.
export function dsmlToolCalls(value) {
  const text = String(value ?? '');
  const calls = [];
  for (const invoke of text.matchAll(DSML_INVOKE)) {
    const args = {};
    for (const parameter of invoke[2].matchAll(DSML_PARAMETER)) {
      const raw = parameter[3];
      if (/\bstring\s*=\s*"true"/i.test(parameter[2])) {
        args[parameter[1]] = raw;
        continue;
      }
      try {
        args[parameter[1]] = JSON.parse(raw.trim());
      } catch {
        return null;
      }
    }
    calls.push({
      id: `dsml_${calls.length + 1}_${Date.now().toString(36)}`,
      type: 'function',
      function: { name: invoke[1].trim(), arguments: JSON.stringify(args) },
    });
  }
  return calls.length ? calls : null;
}
