import { Annotation, END, START, StateGraph } from '@langchain/langgraph';

const AgentState = Annotation.Root({
  input: Annotation(),
  session: Annotation(),
  response: Annotation(),
});

function commandList(session) {
  return session.commands.map((command) => `/${command}`).join(', ');
}

export function buildAgentSystemPrompt(state) {
  const workspace = state.session.workspace ?? 'no workspace selected';
  const wikirc = state.session.wikirc?.profile ?? 'no profile loaded';
  const language = state.session.language ?? 'en-US';
  return [
    'You are Donna, the terminal orchestrator agent for llm-wiki-manager.',
    'The shell is agent-first: every input without a leading slash is routed to you.',
    'Commands starting with / are deterministic primitives you may recommend.',
    `Reply language: ${language}.`,
    `Current workspace: ${workspace}.`,
    `Current wikirc profile: ${wikirc}.`,
    `Available primitives: ${commandList(state.session)}.`,
    'Current mode: step 2, before workspace/compose/MCP/skills tools are fully wired.',
    'If an action requires a tool that is not available yet, explain the limitation and name the expected primitive.',
  ].join('\n');
}

export function buildLimitedAgentResponse(state, reason = 'no workspace loaded with .wikirc.yaml') {
  const workspace = state.session.workspace ?? 'no workspace selected';
  const wikirc = state.session.wikirc?.profile ?? 'no profile loaded';
  const language = state.session.language ?? 'en-US';
  if (language.toLowerCase().startsWith('fr')) {
    return [
      `Donna est active. Workspace courant: ${workspace}.`,
      `Profil wikirc courant: ${wikirc}.`,
      '',
      "Je suis deja la boucle principale du shell: les entrees sans `/` passent par ce graphe LangGraph.",
      `Connexion LLM: mode limite (${reason}).`,
      `Primitives disponibles maintenant: ${commandList(state.session)}.`,
      '',
      "Mode limite: les outils workspace, Docker Compose, MCP et skills seront branches dans les prochains increments.",
      "Utilise `/help` pour voir les commandes deterministes disponibles.",
    ].join('\n');
  }
  return [
    `Donna is active. Current workspace: ${workspace}.`,
    `Current wikirc profile: ${wikirc}.`,
    '',
    'I am already the shell main loop: inputs without `/` are routed through this LangGraph graph.',
    `LLM connection: limited mode (${reason}).`,
    `Available primitives: ${commandList(state.session)}.`,
    '',
    'Limited mode: workspace, Docker Compose, MCP and skill tools will be wired in the next increments.',
    'Use `/help` to see deterministic shell commands.',
  ].join('\n');
}

export function createAgentGraph(options = {}) {
  return new StateGraph(AgentState)
    .addNode('orchestrator', async (state) => {
      const llm = state.session.llm ?? options.llm ?? null;
      if (!llm) {
        return { response: buildLimitedAgentResponse(state) };
      }

      try {
        const response = await llm.complete({
          system: buildAgentSystemPrompt(state),
          input: state.input,
        });
        return { response };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { response: buildLimitedAgentResponse(state, `LLM indisponible: ${message}`) };
      }
    })
    .addEdge(START, 'orchestrator')
    .addEdge('orchestrator', END)
    .compile();
}
