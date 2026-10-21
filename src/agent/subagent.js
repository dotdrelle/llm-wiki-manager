import { createAgentEvent, dispatchAgentEvent } from '../core/agentEvents.js';
import { buildLlmTools, callMcpTool, formatMcpToolResult, parseToolCallName } from '../core/mcp.js';
import { runBoundedToolLoop } from '../core/toolLoop.js';

/*
 A temporary, read-only subagent Donna can create for one bounded objective.

 This is the generic form of "ask another pair of eyes": the manager gives the
 child the same read-only tool contract as the parent, a fresh role prompt and
 a hard iteration cap, then returns its answer. The child cannot write, start a
 job, delegate or approve — actions stay with Donna and the normal approval
 path. The child's tool list is the parent's read-only pool, optionally
 narrowed by the caller; nothing is hardcoded per connector.
*/

export const RUNTIME_SPAWN_AGENT_TOOL = {
  type: 'function',
  function: {
    name: 'runtime__spawn_agent',
    description: 'Create a temporary read-only subagent for one bounded question or analysis, run it with the offered read tools, and return its answer and the tools it called. Use it to split research, verify a claim from several pages, or get a second reading. The subagent cannot mutate the workspace, start a job, approve, or delegate; actions remain yours. Give it a role, a complete objective, and optionally the subset of read tools it may use.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        role: { type: 'string', description: 'Short role name, e.g. researcher, verifier, analyst.' },
        objective: { type: 'string', description: 'The complete question or task, with scope, constraints and the expected output.' },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional subset of the read tools offered this turn. Omit to use the whole read-only pool.',
        },
        maxIterations: {
          type: 'integer',
          minimum: 1,
          maximum: 6,
          description: 'Bounded tool rounds for the child. Default 3.',
        },
      },
      required: ['role', 'objective'],
    },
  },
};

function selectReadTools(session, requested, parentToolNames) {
  const allowed = new Set(
    (parentToolNames ?? []).filter((name) => typeof name === 'string' && name),
  );
  const requestedNames = new Set(
    (Array.isArray(requested) ? requested : [])
      .map((name) => String(name ?? '').trim())
      .filter(Boolean),
  );
  return buildLlmTools(session.mcp).filter((item) => {
    const name = item.function?.name ?? '';
    const { server, tool } = parseToolCallName(name);
    if (!server || ['production', 'runtime', 'shell', 'memory', 'conversation'].includes(server)) return false;
    if (item.readOnly !== true) return false;
    if (server === 'wiki' && (tool === 'plan_set' || tool === 'plan_done')) return false;
    if (allowed.size > 0 && !allowed.has(name)) return false;
    if (requestedNames.size > 0) {
      const bare = tool;
      if (!requestedNames.has(name) && !requestedNames.has(bare)) return false;
    }
    return true;
  });
}

function childSystemPrompt(role, objective) {
  return [
    `You are a temporary read-only subagent created by Donna. Role: ${role}.`,
    `Objective: ${objective}`,
    'Use only the tools offered. They are read-only: you cannot modify the workspace, start a job, approve, delegate or ask the user a question.',
    'Work in bounded steps. Read what the objective needs, cite the exact paths or sections you used, and say plainly when the evidence does not establish a claim.',
    'Return a concise result for Donna: the answer, the evidence paths, and any uncertainty or missing reference. Do not repeat your tool transcript.',
  ].join('\n');
}

function inputBudgetChars(session) {
  const configured = Number(session?.wikircConfig?.limits?.maxInputTokensPerCall);
  const tokens = Number.isFinite(configured) && configured > 0 ? configured : 50_000;
  return Math.max(10_000, Math.floor(tokens * 3.5));
}

export async function handleSpawnAgent(session, llm, args = {}, parentToolNames = null, parentCallId = null) {
  const role = String(args.role ?? '').trim().slice(0, 120);
  const objective = String(args.objective ?? '').trim();
  if (!role || !objective) {
    return JSON.stringify({ ok: false, error: 'spawn_agent requires a role and an objective.' });
  }
  if (!llm || (typeof llm.completeWithTools !== 'function' && typeof llm.streamWithTools !== 'function')) {
    return JSON.stringify({ ok: false, error: 'No model is attached to this session; cannot spawn a subagent.' });
  }
  const tools = selectReadTools(session, args.tools, parentToolNames);
  if (tools.length === 0) {
    return JSON.stringify({ ok: false, error: 'No read-only tool is available to the subagent in this turn.' });
  }
  const maxIterations = Math.min(6, Math.max(1, Math.floor(Number(args.maxIterations) || 3)));
  const subagentId = `subagent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  const emit = (type, payload) => dispatchAgentEvent(session, createAgentEvent(type, {
    origin: 'runtime',
    payload: { subagentId, subagent: role, parentCallId, ...payload },
  }));
  const toolCalls = [];
  const executeCall = async (call) => {
    const name = String(call?.function?.name ?? '');
    const offered = new Set(tools.map((item) => item.function?.name));
    if (!offered.has(name)) return `Refused: ${name} is not offered to this subagent.`;
    const { server, tool } = parseToolCallName(name);
    let callArgs = {};
    try { callArgs = call?.function?.arguments ? JSON.parse(call.function.arguments) : {}; } catch { callArgs = {}; }
    const step = toolCalls.length + 1;
    emit('subagent_step', { step, maxSteps: maxIterations, tool: name, status: 'running' });
    try {
      const result = await callMcpTool(session.mcp, server, tool, callArgs, session._abortSignal);
      const text = formatMcpToolResult(result);
      toolCalls.push({ name, arguments: JSON.stringify(callArgs).slice(0, 1200), ok: true, result: text.slice(0, 1800) });
      emit('subagent_step', { step, maxSteps: maxIterations, tool: name, status: 'done' });
      return text;
    } catch (error) {
      if (error?.name === 'AbortError' && session._abortSignal?.aborted) throw error;
      const text = `Error [${name}]: ${error instanceof Error ? error.message : String(error)}`;
      toolCalls.push({ name, arguments: JSON.stringify(callArgs).slice(0, 1200), ok: false, result: text.slice(0, 1800) });
      emit('subagent_step', { step, maxSteps: maxIterations, tool: name, status: 'failed', error: text.slice(0, 300) });
      return text;
    }
  };

  emit('subagent_started', { objective, maxSteps: maxIterations });
  session._onStep?.(`Agent: subagent ${role} starting…`);
  try {
    const result = await runBoundedToolLoop({
      llm,
      system: childSystemPrompt(role, objective),
      messages: [{ role: 'user', content: objective }],
      tools,
      executeCall,
      maxIterations,
      inputBudgetChars: inputBudgetChars(session),
      resultMaxChars: () => 16_000,
      signal: session._abortSignal,
      onStep: (iteration, cap) => session._onStep?.(`Agent: subagent ${role} — step ${iteration}/${cap}…`),
    });
    const answer = String(result?.content ?? '').trim();
    emit('subagent_finished', {
      status: answer ? 'done' : 'failed',
      step: toolCalls.length,
      maxSteps: maxIterations,
      toolCount: toolCalls.length,
      durationMs: Date.now() - startedAt,
      answerPreview: answer.slice(0, 300),
      ...(answer ? {} : { error: 'The subagent returned no answer.' }),
    });
    session._onStep?.(`Agent: subagent ${role} finished${result?.capped ? ' (bounded)' : ''}.`);
    return JSON.stringify({
      ok: Boolean(answer),
      role,
      objective,
      answer: answer.slice(0, 12_000),
      toolCalls,
      iterations: result?.iterations ?? 0,
      capped: result?.capped === true,
      ...(result?.failure ? { failure: result.failure } : {}),
      ...(answer ? {} : { error: 'The subagent returned no answer.' }),
    });
  } catch (error) {
    if (error?.name === 'AbortError' && session._abortSignal?.aborted) {
      emit('subagent_finished', {
        status: 'failed',
        step: toolCalls.length,
        maxSteps: maxIterations,
        toolCount: toolCalls.length,
        durationMs: Date.now() - startedAt,
        error: 'aborted',
      });
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    emit('subagent_finished', {
      status: 'failed',
      step: toolCalls.length,
      maxSteps: maxIterations,
      toolCount: toolCalls.length,
      durationMs: Date.now() - startedAt,
      error: message.slice(0, 300),
    });
    return JSON.stringify({
      ok: false,
      role,
      objective,
      error: message,
      toolCalls,
    });
  }
}
