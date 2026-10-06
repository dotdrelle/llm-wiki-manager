/*
 * Per-model LLM capabilities the manager's own client must honour.
 *
 * The manager talks to the same OpenAI-compatible endpoint as the engine
 * (`llm-wiki`), but with its own client (`src/agent/llm.js`). The engine already
 * models reasoning-model temperature support in
 * `llm-wiki/src/config/engineCapabilities.ts`; this is the manager-side mirror,
 * so its client stops sending a parameter the model rejects. Keep the two rules
 * identical — the manager is a separate package and cannot import the engine.
 *
 * `provider` says WHERE requests go (direct server or AI gateway); `engine`
 * says HOW that server behaves. Behind a gateway there is one engine per model,
 * so a reasoning model routed there may still refuse `temperature`.
 */

/** The final segment of a model name: `openai/gpt-5-mini` → `gpt-5-mini`. */
export function bareModelName(model) {
  const value = String(model ?? '');
  return value.slice(value.lastIndexOf('/') + 1);
}

/**
 * OpenAI gpt-5 and gpt-6-luna refuse non-default `temperature` (error: "does not
 * support 0.1 with this model. Only the default (1) value is supported"). The test targets
 * the bare model name so it holds both directly and behind a gateway prefix.
 */
/**
 * What `wiki doctor --apply` measured for THIS model (`llm.capabilities`, see
 * the engine's `config/modelProbe.ts`); a probe of another model is ignored.
 */
export function probedCapabilities(llmConfig) {
  const probed = llmConfig?.capabilities;
  return probed && typeof probed === 'object' && probed.model === llmConfig?.model ? probed : undefined;
}

export function supportsTemperature(llmConfig) {
  const probed = probedCapabilities(llmConfig)?.temperature;
  if (typeof probed === 'boolean') return probed;
  const isReasoningModel = /^gpt-(?:5|6)(?:[.-]|$)/i.test(bareModelName(llmConfig?.model));
  if (!isReasoningModel) return true;
  return !(llmConfig?.provider === 'ai-gateway' || llmConfig?.engine === 'openai');
}

/**
 * A forced (named) `tool_choice` becomes `auto` when the model was measured to
 * refuse it — thinking mode answers HTTP 400 "Thinking mode does not support
 * this tool_choice". `auto` itself is never removed: agent mode and the
 * maintenance agent need it.
 */
export function effectiveToolChoice(llmConfig, toolChoice) {
  if (toolChoice && typeof toolChoice === 'object' && probedCapabilities(llmConfig)?.toolChoice === 'auto') return 'auto';
  return toolChoice;
}

/**
 * The `reasoning_effort` to send (`llm.reasoningEffort`, the thinking-mode
 * knob), unless the doctor measured that this model refuses the parameter.
 * Mirror of the engine's `reasoningEffortParam`.
 */
export function reasoningEffortParam(llmConfig) {
  const value = typeof llmConfig?.reasoningEffort === 'string' ? llmConfig.reasoningEffort : '';
  if (!value) return undefined;
  return probedCapabilities(llmConfig)?.reasoningEffort === false ? undefined : value;
}
