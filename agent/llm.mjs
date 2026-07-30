// llm.mjs — the model client (the only network I/O in the agent). BYOK and
// provider-agnostic: the user brings their own key/endpoint. Given a
// { system, messages } request it returns ONE normalized browser_action call.
// It is deliberately thin: it does not decide anything — the returned call is
// normalized by tools.toIntent and then gated by the Governor.

import { ACTION_TOOL } from './tools.mjs';

// makeLLM(config) -> async ({ system, messages }) => normalizedCall
// config: { provider, apiKey, model?, endpoint?, maxTokens?, fetchImpl?, script? }
export function makeLLM(config = {}) {
  switch (config.provider || 'anthropic') {
    case 'mock': return mockLLM(config.script || []);
    case 'anthropic': return anthropicLLM(config);
    case 'openai': return openaiLLM(config);        // any OpenAI-compatible endpoint (incl. local)
    default: throw new Error(`unknown LLM provider: ${config.provider}`);
  }
}

// A scripted model — no network. Returns calls in order, then finishes. For the
// deterministic demo and tests, and for a WebLLM/local adapter to slot into.
export function mockLLM(script) {
  let i = 0;
  return async () => (i < script.length ? script[i++] : { op: 'done', done_reason: 'script exhausted' });
}

// Latest Claude via the Messages API, forced to call the single browser_action tool.
function anthropicLLM({ apiKey, model = 'claude-sonnet-5', endpoint = 'https://api.anthropic.com/v1/messages', maxTokens = 1024, fetchImpl }) {
  const f = fetchImpl || globalThis.fetch;
  return async ({ system, messages }) => {
    const res = await f(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model, max_tokens: maxTokens, system, messages,
        tools: [ACTION_TOOL], tool_choice: { type: 'tool', name: ACTION_TOOL.name },
      }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text().catch(() => '')}`);
    const data = await res.json();
    const tool = (data.content || []).find(b => b.type === 'tool_use' && b.name === ACTION_TOOL.name);
    if (!tool) throw new Error('model returned no browser_action');
    return normalizeCall(tool.input);
  };
}

// Any OpenAI-compatible chat/completions endpoint (OpenAI, local llama.cpp, etc.).
function openaiLLM({ apiKey, model = 'gpt-4o', endpoint = 'https://api.openai.com/v1/chat/completions', maxTokens = 1024, fetchImpl }) {
  const f = fetchImpl || globalThis.fetch;
  const fnTool = { type: 'function', function: { name: ACTION_TOOL.name, description: ACTION_TOOL.description, parameters: ACTION_TOOL.input_schema } };
  return async ({ system, messages }) => {
    const res = await f(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model, max_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, ...messages],
        tools: [fnTool], tool_choice: { type: 'function', function: { name: ACTION_TOOL.name } },
      }),
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text().catch(() => '')}`);
    const data = await res.json();
    const call = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.tool_calls && data.choices[0].message.tool_calls[0];
    if (!call) throw new Error('model returned no tool call');
    let args = {}; try { args = JSON.parse(call.function.arguments); } catch { /* leave empty -> toIntent handles */ }
    return normalizeCall(args);
  };
}

function normalizeCall(input) {
  const c = (input && typeof input === 'object') ? input : {};
  return { op: c.op, ref: c.ref, text: c.text, target: c.target, rationale: c.rationale, done_reason: c.done_reason };
}
