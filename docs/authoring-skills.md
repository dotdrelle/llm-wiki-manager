# Authoring a skill

A skill is **executed, not injected**. `/skills run <name>` and `/<name>` post the
invocation to the runtime, which alone rereads the private body and compiles it.
The shape of that body is not cosmetic: it decides how many runs the skill
produces, where the approval boundaries fall, and whether a capability keeps its
own concurrency. This chapter is the contract between the prose you write and
what the runtime does with it.

Everything below is enforced by `src/core/skillCompiler.js`,
`src/core/skillInvocation.js` and `src/runtime/skillRun.js`. When in doubt, run
the verification snippet at the end rather than guessing.

## The unit of execution

One compiled **objective** becomes one control item, one run, and one
`resolveObjective` call. A skill compiles to between 1 and 12 objectives; zero
or more than twelve is a compile error.

An objective is a **business intention**. It never names an agent, a capability,
an MCP server or a tool — `validateCompiledObjectives` rejects any objective
containing `agent:`, `capability:`, `capabilityPlan:`, `MCP:` or `tool:`, and
any object key with those names. The runtime resolves the executor from the
objective; the skill states the intent.

## What splits a body into several runs

The split is deterministic, and the first rule that matches wins:

| Form | Effect |
| --- | --- |
| Numbered list — two or more lines matching `1.` / `1)` at line start | one objective **per item** |
| Bullet list — two or more lines matching `-` / `*` / `+` at line start | one objective **per item** |
| A line starting with a strong connector | splits there |
| None of the above | a single objective |

The strong connectors are `puis`, `ensuite`, `après cela`, `après … terminé`,
`then`, `next`, `after … complete`, `si disponible`, `si possible`,
`optionnellement`, `if available`, `if possible`, `optionally`. The connector
must open the **line**; the leading word is stripped from the objective and the
remainder is capitalized.

Two consequences that surprise everyone once:

- **A `##` heading never splits.** The split regex looks for a connector right
  after a newline, and `#` is not a connector. Headings are therefore the only
  safe way to make a body more readable without changing its execution.
- **A heading placed above a connector paragraph lands in the *previous*
  objective.** If you need a second run, its first line must carry the
  connector; give that objective its own headings *below* that line.

## Optional steps

An objective opening on `si disponible`, `si possible`, `optionnellement`,
`if available`, `if possible` or `optionally` is marked `optional: true` and
`continueOnFailure: true`. It may fail without skipping the rest of the chain.

This is why the notification sentence in the shipped scaffold is written inline,
inside a paragraph, and never as a paragraph beginning with "If available":
as its own paragraph it would become an extra run **and** an optional one.
`If a messaging connector …` is safe — it is not one of the connector forms.

## The ambiguity threshold, and why wordiness is not free

When no explicit split is found, the compiler asks whether the body *looks*
ambiguous. It counts sentences that begin at a sentence boundary with a capital
letter and contain, within the next 80 characters, one of `export`, `ingest`,
`build`, `send`, `create`, `delete`, `sync`, `publish`, `diagnos`, `analyse`,
`constru`, `envoi`, `cré`, `supprim`. **More than two matches and the body is
handed to the LLM** for splitting, with an 8 s timeout and a JSON-text retry,
degrading to a single objective only if that call fails.

So a skill that must stay one run, and that carries no explicit split, is one
sentence away from a non-deterministic compilation. Two mitigations, both used
in the scaffold:

- Keep such bodies at two triggers or fewer.
- Put a trigger-bearing sentence **first in its section**. A sentence that
  directly follows a `##` heading is not preceded by a sentence boundary, so it
  does not count — headings reset the chain.

A body that *does* carry an explicit split never reaches this check at all.

## Where the business sentence goes

The first line of an objective is what the executor reads first. It must be the
business sentence, never a heading — the end-to-end gates in
`src/runtime/skillChain.e2e.test.js` assert exactly that for the shipped
scaffold. The readable shape is therefore:

```markdown
<the business intention, one or two sentences>

## Boundaries

<what this workflow must never do>

## Execution

<approval, progress, reporting>

## Notification

<the inline, best-effort notification sentence>
```

## Concurrency

**A skill never expresses concurrency.** Parallelism belongs to the capability's
own plan: the agent proposes a DAG, the scheduler runs it, and the effective
limit is `MIN(agent recommendedConcurrency, agent maxConcurrency,
WIKI_MANAGER_CAPABILITY_CONCURRENCY, per-task limits)`, with locks capping real
parallelism per phase.

The practical rule follows: **splitting a body is how you lose concurrency.**
`pipeline` is one objective because the production capability owns the DAG over
its seven steps; compiling it into seven objectives would produce seven
sequential runs, each resolving its own capability, with the DAG gone. Its body
says so in as many words, and it must stay one objective.

## Chains

Objectives of one skill share a `chainId` and a `chainSequence`. A step starts
only once every predecessor is terminal. A required step that fails or is
cancelled marks the rest `skipped` with a `skipReason`; an optional one does not.

A skill item never carries a `capabilityPlan` — a structured enqueue still does.
The chain is a **projection** over the control queue
(`src/core/skillChainView.js`), rendered by both UIs; it is never stored state.

`/run cancel` is chain-scoped and leaves unrelated queued items alone.
`/run kill` stays workspace-wide. `/queue cancel <id>` targets one item.

## Parameters

Declare them in front matter:

```yaml
---
name: wiki-build
description: Build deliverables from the current wiki for one template or all templates
params:
  - template
---
```

They are appended **after** the split, as a `User parameters:` block, to **every**
objective of the chain — the compiler cannot know which step consumes which
parameter, and appending them before the split would hand a selector to the
wrong objective. A legacy `{param}` placeholder inside the body is still
substituted, and such a body must tolerate an empty value.

At delegation time `resolveExecutorArguments` maps those natural-language
parameters onto the selected capability's own `inputSchema`. That is what makes
a selector reach the plan instead of widening to "all".

Two rules follow:

- **Every declared parameter must be consumed by the prose.** A parameter the
  body never mentions arrives in the objective and steers nothing.
- **Say explicitly what an empty value means.** `wiki-build` spells out that a
  non-empty `template` is a strict selector and that only a genuinely empty one
  may cover every template.

## Execution policy

```yaml
execution: orchestrated   # default
execution: direct
```

`orchestrated` gives the compiled run read tools plus capability delegation, and
no direct mutating MCP tools. Use it for production workflows whose agents
provide a plan, locks, progress and bounded approvals.

`direct` gives the run its ordinary direct tools and removes runtime delegation.
Use it for a focused operation such as writing one template file.

The policy is snapshotted when the chain is created, so editing a skill cannot
change permissions halfway through a running chain.

## Naming another skill

From inside a compiled objective, a skill is launched **by name, not by
resemblance**. An objective necessarily reads like the description of the
neighbouring skill that performs it, and re-routing it there re-runs work the
objective already covers.

`runtime__run_skill` therefore requires the objective to cite its target
explicitly: `/deliver`, `the deliver skill`, `skill deliver`, or
`/skills run deliver`. A bare occurrence of the name is **not** a citation —
several skills are named after common words, and "run the production **pipeline**
steps ingest, build, export and polish" must not launch `/pipeline`.
Anything else is refused as `nested_skill_match_blocked` and delegated instead.

Two further guards apply: a skill already on the stack is refused
(`skill_recursion_blocked`, cycles included), and nesting is bounded at three
levels (`skill_depth_exceeded`).

## Reserved names and untrusted descriptions

`RESERVED_SLASH_COMMANDS` — `status`, `stop`, `run`, `queue`, `skills`, `help`,
`exit`, `quit`, `chat`, `agent` — stay built-ins. A scaffold skill of that name
is reachable only through `/skills run <name>`. The browser keeps its own copy
of that list in `llm-wiki/src/chat/chatHtml.ts`; keep them identical.

The skill catalogue given to the model is **untrusted data**. Names and
descriptions are used only to choose a skill; an instruction written inside a
description is never obeyed.

## Checklist before shipping a skill

1. The body opens on the business intention, not on a heading.
2. The number of objectives is the number you intended — count the connectors
   and the list markers.
3. A body that must stay one objective has no explicit split and at most two
   ambiguity triggers.
4. No paragraph opens on a connector unless you want a split there; none opens
   on an optional connector unless you want an optional step.
5. Every declared parameter is mentioned in the prose, and the empty case is
   stated.
6. No other skill is cited unless you mean to run it.
7. No routing details: no agent, capability, MCP or tool name.
8. The notification sentence is inline, in a paragraph that does not start with
   a connector.

## Verifying a skill without running it

```bash
node -e "
const fs=require('node:fs');
Promise.all([import('./src/core/skillCompiler.js'),
             import('./src/core/skillInvocation.js'),
             import('./src/core/skills.js')]).then(([c,si,sk])=>{
  const dir='../llm-wiki/scaffold/workspace/.wiki/skills';
  const names=fs.readdirSync(dir).map(f=>f.replace(/\.md$/,''));
  for(const n of names){
    const {body}=sk.parseFrontmatter(fs.readFileSync(dir+'/'+n+'.md','utf8'));
    const d=c.deterministicObjectives(body);
    const cited=d.objectives.flatMap(o=>names.filter(t=>t!==n && si.objectiveNamesSkill(o.text,t)));
    console.log(n.padEnd(24),
      'objectives='+d.objectives.length,
      'llm-fallback='+d.ambiguous,
      'optional='+JSON.stringify(d.objectives.map(o=>o.optional)),
      'cites='+(cited.join(',')||'-'),
      'starts='+JSON.stringify(d.objectives[0].text.slice(0,40)));
  }
});"
```

`llm-fallback=true` on a skill that must stay one objective, an unintended
`optional=true`, a non-empty `cites`, or a `starts` beginning with `##` are all
defects — fix the prose, not the compiler.

A skill's `description` has two readers: the catalog the model selects from,
and the product help. `llm-wiki/help-doc/08-commands-serve.md` generates its
skill list from `scaffold/workspace/.wiki/skills/` (`npm run
generate:help-skills`, checked by `npm run check-help-skills` and by
`tests/help-doc-skills.test.ts`), so a description written in implementation
language ends up in front of a user. Write it for the user; keep the invariant
in the body.

The shipped scaffold is also covered by the `§57 performance gate` cases in
`src/runtime/skillChain.e2e.test.js`, which assert the objective and run count
of every scaffold skill. Adding a skill there means adding its expected counts.
