function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

export function createLlmClientFromWikiConfig(config) {
  const llmConfig = config?.llm;
  const apiKey = llmConfig?.apiKey;
  const model = llmConfig?.model;
  const baseUrl = llmConfig?.baseUrl ? trimTrailingSlash(llmConfig.baseUrl) : undefined;

  if (!apiKey || !model || !baseUrl) {
    return null;
  }

  return {
    async complete({ system, input }) {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: input },
          ],
          temperature: typeof llmConfig.temperature === 'number' ? llmConfig.temperature : 0.2,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`HTTP ${response.status} ${body.slice(0, 240)}`);
      }

      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content || typeof content !== 'string') {
        throw new Error('reponse LLM sans contenu texte');
      }
      return content;
    },
    async completeWithTools({ system, tools = [], messages = [] }) {
      const allMessages = [
        { role: 'system', content: system },
        ...messages,
      ];
      const body = {
        model,
        messages: allMessages,
        temperature: typeof llmConfig.temperature === 'number' ? llmConfig.temperature : 0.2,
      };
      if (tools.length > 0) {
        body.tools = tools;
        body.tool_choice = 'auto';
      }
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status} ${text.slice(0, 240)}`);
      }
      const data = await response.json();
      const msg = data?.choices?.[0]?.message;
      return {
        content: msg?.content ?? null,
        tool_calls: msg?.tool_calls?.length > 0 ? msg.tool_calls : null,
        message: { role: 'assistant', content: msg?.content ?? null, tool_calls: msg?.tool_calls },
      };
    },
    async *stream({ system, messages = [] }) {
      const allMessages = [
        { role: 'system', content: system },
        ...messages,
      ];
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: allMessages,
          temperature: typeof llmConfig.temperature === 'number' ? llmConfig.temperature : 0.2,
          stream: true,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`HTTP ${response.status} ${body.slice(0, 240)}`);
      }

      if (!response.body) {
        const fallback = await this.completeWithTools({ system, messages });
        yield fallback.content ?? '';
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice('data:'.length).trim();
          if (!data || data === '[DONE]') continue;
          const parsed = JSON.parse(data);
          const delta = parsed?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) yield delta;
        }
      }
    },
  };
}
