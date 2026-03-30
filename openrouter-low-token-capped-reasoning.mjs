import 'dotenv/config';
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
  timeout: 120000,
  maxRetries: 1,
});

const t = Date.now();
const resp = await client.chat.completions.create({
  model: 'nvidia/nemotron-3-super-120b-a12b:free',
  messages: [
    { role: 'user', content: 'Answer with one digit only: How many r letters are in strawberry?' },
  ],
  reasoning: { enabled: true, max_tokens: 24 },
  max_tokens: 180,
  temperature: 0,
});

const elapsedMs = Date.now() - t;
const msg = resp?.choices?.[0]?.message || {};

console.log(JSON.stringify({
  elapsedMs,
  finishReason: resp?.choices?.[0]?.finish_reason ?? null,
  model: resp?.model || null,
  content: msg.content,
  hasReasoningDetails: msg.reasoning_details != null,
  reasoningDetailsCount: Array.isArray(msg.reasoning_details) ? msg.reasoning_details.length : null,
  usage: resp?.usage || null,
}, null, 2));
