/**
 * Send a plain-text message to any A2A-compatible Babylon agent.
 *
 * Usage:
 *   node send-a2a.js "Your message here"
 *   node send-a2a.js "Your message here" --agent-id 292584913457119232
 *
 * Or via env:
 *   A2A_AGENT_ID=292584913457119232 node send-a2a.js "Your message here"
 *
 * Required .env vars:
 *   BABYLON_API_KEY   – Babylon API key
 *
 * Optional .env vars:
 *   A2A_AGENT_ID      – Agent ID (numeric part of the URL). Defaults to AlphaBot.
 *   A2A_BASE_URL      – Base URL, default https://play.babylon.market
 */

require('dotenv').config();

const ALPHA_BOT_ID = '292584913457119232';
const BASE_URL     = process.env.A2A_BASE_URL ?? 'https://play.babylon.market';
const API_KEY      = process.env.BABYLON_API_KEY;

const args    = process.argv.slice(2);
const msgText = args.find(a => !a.startsWith('--'));
const idFlag  = args.indexOf('--agent-id');
const agentId = idFlag !== -1 ? args[idFlag + 1] : (process.env.A2A_AGENT_ID ?? ALPHA_BOT_ID);

if (!msgText) {
  console.error('Usage: node send-a2a.js "Your message here" [--agent-id <id>]');
  process.exit(1);
}

if (!API_KEY) {
  console.error('Error: BABYLON_API_KEY is not set.');
  process.exit(1);
}

let msgCounter = 0;

async function sendMessage(text) {
  const id  = ++msgCounter;
  const url = `${BASE_URL}/api/agents/${agentId}/a2a`;

  console.log(`→ Sending to agent ${agentId}:`);
  console.log(`  "${text}"`);

  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'X-Babylon-Api-Key': API_KEY,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method:  'message/send',
      params:  {
        message: {
          messageId: `msg-${id}`,
          contextId: process.env.BABYLON_USER_ID,
          role:      'user',
          parts:     [{ kind: 'text', text }],
        },
      },
      id,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body}`);
  }

  const json = await res.json();

  if (json.error) {
    throw new Error(`JSONRPC error ${json.error.code}: ${json.error.message}`);
  }

  const state = json?.result?.status?.state;
  const parts = json?.result?.status?.message?.parts ?? [];
  const reply = parts.map(p => p.text ?? JSON.stringify(p.data ?? p)).join('\n');

  console.log(`\n← Response (state: ${state ?? 'unknown'}):`);
  console.log(reply || JSON.stringify(json?.result, null, 2));

  return json?.result;
}

sendMessage(msgText).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
