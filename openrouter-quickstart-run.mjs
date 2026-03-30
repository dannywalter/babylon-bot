import 'dotenv/config';
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
  timeout: 90000,
  maxRetries: 1,
});

function summarize(label, resp) {
  const msg = resp?.choices?.[0]?.message || {};
  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
  const usage = resp?.usage || {};
  const totalTokens = usage.total_tokens ?? null;
  return {
    label,
    model: resp?.model || null,
    finishReason: resp?.choices?.[0]?.finish_reason ?? null,
    contentPreview: String(content || '').slice(0, 220),
    hasReasoning: msg.reasoning != null,
    hasReasoningDetails: msg.reasoning_details != null,
    reasoningDetailsCount: Array.isArray(msg.reasoning_details) ? msg.reasoning_details.length : null,
    usage,
    totalTokens,
  };
}

const q1 = "How many r's are in the word 'strawberry'?";

const t1 = Date.now();
const apiResponse = await client.chat.completions.create({
  model: 'nvidia/nemotron-3-super-120b-a12b:free',
  messages: [{ role: 'user', content: q1 }],
  reasoning: { enabled: true },
  max_tokens: 512,
});
const elapsed1Ms = Date.now() - t1;

const response = apiResponse.choices[0].message;
const messages = [
  { role: 'user', content: q1 },
  {
    role: 'assistant',
    content: response.content,
    reasoning_details: response.reasoning_details,
  },
  { role: 'user', content: 'Are you sure? Think carefully.' },
];

const t2 = Date.now();
const response2 = await client.chat.completions.create({
  model: 'nvidia/nemotron-3-super-120b-a12b:free',
  messages,
  max_tokens: 512,
});
const elapsed2Ms = Date.now() - t2;

console.log(JSON.stringify({
  elapsed1Ms,
  elapsed2Ms,
  call1: summarize('call1', apiResponse),
  call2: summarize('call2', response2),
}, null, 2));
