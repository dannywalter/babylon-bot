import 'dotenv/config';
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
  timeout: 120000,
  maxRetries: 1,
});

function summarize(label, resp, elapsedMs) {
  const msg = resp?.choices?.[0]?.message || {};
  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
  return {
    label,
    elapsedMs,
    model: resp?.model || null,
    finishReason: resp?.choices?.[0]?.finish_reason ?? null,
    contentPreview: String(content || '').slice(0, 200),
    hasReasoning: msg.reasoning != null,
    hasReasoningDetails: msg.reasoning_details != null,
    reasoningDetailsCount: Array.isArray(msg.reasoning_details) ? msg.reasoning_details.length : null,
    usage: resp?.usage || null,
  };
}

const q1 = 'Answer with one digit only: How many r letters are in strawberry?';

const t1 = Date.now();
const call1 = await client.chat.completions.create({
  model: 'nvidia/nemotron-3-super-120b-a12b:free',
  messages: [{ role: 'user', content: q1 }],
  reasoning: { enabled: true },
  max_tokens: 120,
  temperature: 0,
});
const elapsed1Ms = Date.now() - t1;

const m1 = call1.choices?.[0]?.message || {};

const t2 = Date.now();
const call2 = await client.chat.completions.create({
  model: 'nvidia/nemotron-3-super-120b-a12b:free',
  messages: [
    { role: 'user', content: q1 },
    {
      role: 'assistant',
      content: m1.content,
      reasoning_details: m1.reasoning_details,
    },
    { role: 'user', content: 'Are you sure? Reply with one digit only.' },
  ],
  reasoning: { enabled: true },
  max_tokens: 120,
  temperature: 0,
});
const elapsed2Ms = Date.now() - t2;

console.log(JSON.stringify({
  call1: summarize('call1', call1, elapsed1Ms),
  call2: summarize('call2', call2, elapsed2Ms),
}, null, 2));
