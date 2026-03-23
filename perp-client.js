/**
 * Shared Babylon perp trading HTTP helpers.
 *
 * Reads BABYLON_API_KEY from env (loaded by the entry script).
 * REST base URL defaults to BABYLON_BASE_URL or https://play.babylon.market.
 * A2A calls always go to https://babylon.market (production agent endpoint).
 *
 * Exports: restGet, restPost, mcpCall, a2aAgentCall, notifyDiscord
 */

const DEFAULT_BASE_URL = process.env.BABYLON_BASE_URL ?? 'https://play.babylon.market';
const DEFAULT_MCP_URL  = `${DEFAULT_BASE_URL}/mcp`;

function getApiKey() {
  return process.env.BABYLON_API_KEY;
}

async function restGet(path, { apiKey = getApiKey(), baseUrl = DEFAULT_BASE_URL } = {}) {
  const r = await fetch(`${baseUrl}${path}`, {
    headers: { 'X-Babylon-Api-Key': apiKey },
  });
  if (!r.ok) throw new Error(`REST GET ${r.status} ${r.statusText} — ${path}`);
  return r.json();
}

async function restPost(path, body, { apiKey = getApiKey(), baseUrl = DEFAULT_BASE_URL } = {}) {
  const r = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'X-Babylon-Api-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`REST POST ${r.status} — ${path}: ${JSON.stringify(data)}`);
  return data;
}

async function mcpCall(toolName, toolArgs = {}, { apiKey = getApiKey(), mcpUrl = DEFAULT_MCP_URL } = {}) {
  const r = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Babylon-Api-Key': apiKey },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method:  'tools/call',
      params:  { name: toolName, arguments: toolArgs },
      id:      Date.now(),
    }),
  });
  const payload = await r.json();
  if (payload.error) throw new Error(`MCP error: ${payload.error.message}`);
  const text = payload?.result?.content?.find(c => c.type === 'text')?.text;
  try { return JSON.parse(text); } catch { return text; }
}

let _msgId = 0;

/**
 * Send an A2A data-message to a specific agent.
 * @param {string} operation  e.g. 'markets.open_position'
 * @param {object} params
 * @param {string|null} contextId  DID / account context for the trade
 * @param {string} agentId         numeric agent ID
 * @param {{ apiKey?: string, baseUrl?: string }} opts
 */
async function a2aAgentCall(operation, params = {}, contextId, agentId, { apiKey = getApiKey(), baseUrl = 'https://babylon.market' } = {}) {
  const id  = ++_msgId;
  const message = {
    messageId: `a2a-${id}`,
    role: 'user',
    parts: [{ kind: 'data', data: { operation, params } }],
  };
  if (contextId != null) message.contextId = contextId;

  const r = await fetch(`${baseUrl}/api/agents/${agentId}/a2a`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Babylon-Api-Key': apiKey },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'message/send', params: { message }, id }),
  });
  const json = await r.json();
  if (json?.result?.status?.state === 'failed') {
    const msg = json?.result?.status?.message?.parts?.[0]?.text ?? JSON.stringify(json);
    throw new Error(`A2A failed: ${msg}`);
  }
  return json?.result?.artifacts?.[0]?.parts?.[0]?.data ?? json?.result;
}

async function notifyDiscord(message, webhookUrl = process.env.DISCORD_WEBHOOK_URL) {
  if (!webhookUrl) {
    console.warn('Discord notification skipped: DISCORD_WEBHOOK_URL not set');
    return;
  }
  try {
    const r = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message }),
    });
    if (!r.ok) {
      console.warn(`Discord notification failed: HTTP ${r.status} — ${await r.text()}`);
    } else {
      console.log('  Discord notification sent.');
    }
  } catch (e) {
    console.warn('Discord notification failed:', e.message);
  }
}

module.exports = { restGet, restPost, mcpCall, a2aAgentCall, notifyDiscord };
