/**
 * Shared Babylon perp trading HTTP helpers.
 *
 * Reads BABYLON_API_KEY from env (loaded by the entry script).
 * REST base URL defaults to BABYLON_BASE_URL or https://play.babylon.market.
 * A2A base URL defaults to BABYLON_A2A_BASE_URL, then BABYLON_BASE_URL,
 * with an internal fallback to https://babylon.market.
 *
 * Exports: restGet, restPost, mcpCall, a2aAgentCall, notifyDiscord
 */

const DEFAULT_BASE_URL = process.env.BABYLON_BASE_URL ?? 'https://play.babylon.market';
const DEFAULT_A2A_BASE_URL = process.env.BABYLON_A2A_BASE_URL ?? DEFAULT_BASE_URL;
const FALLBACK_A2A_BASE_URL = 'https://babylon.market';
const DEFAULT_MCP_URL  = `${DEFAULT_BASE_URL}/mcp`;
const DEFAULT_TIMEOUT_MS = Number(process.env.BABYLON_HTTP_TIMEOUT_MS) || 15_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWithRetry(url, options = {}, { retries = 0, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fetchWithTimeout(url, options, timeoutMs);
    } catch (err) {
      if (attempt >= retries) {
        throw err;
      }
      attempt += 1;
      await sleep(250 * attempt);
    }
  }
}

function getApiKey() {
  return process.env.BABYLON_API_KEY;
}

async function restGet(path, { apiKey = getApiKey(), baseUrl = DEFAULT_BASE_URL } = {}) {
  const r = await fetchWithRetry(`${baseUrl}${path}`, {
    headers: { 'X-Babylon-Api-Key': apiKey },
  }, { retries: 2 });
  if (!r.ok) throw new Error(`REST GET ${r.status} ${r.statusText} — ${path}`);
  return r.json();
}

async function restPost(path, body, { apiKey = getApiKey(), baseUrl = DEFAULT_BASE_URL } = {}) {
  const r = await fetchWithRetry(`${baseUrl}${path}`, {
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
  const r = await fetchWithRetry(mcpUrl, {
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

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function buildA2aFailureMessage(payload) {
  const textPart = payload?.result?.status?.message?.parts?.find((part) => typeof part?.text === 'string')?.text;
  if (textPart) return textPart;
  if (payload?.error?.message) return payload.error.message;
  if (payload?.result?.status?.message) return JSON.stringify(payload.result.status.message);
  return JSON.stringify(payload);
}

/**
 * Send an A2A data-message to a specific agent.
 * @param {string} operation  e.g. 'markets.open_position'
 * @param {object} params
 * @param {string|null} contextId  DID / account context for the trade
 * @param {string} agentId         numeric agent ID
 * @param {{ apiKey?: string, baseUrl?: string }} opts
 */
async function a2aAgentCall(operation, params = {}, contextId, agentId, { apiKey = getApiKey(), baseUrl = DEFAULT_A2A_BASE_URL } = {}) {
  const id  = ++_msgId;
  const message = {
    messageId: `a2a-${id}`,
    role: 'user',
    parts: [{ kind: 'data', data: { operation, params } }],
  };
  if (contextId != null) message.contextId = contextId;

  const candidates = [];
  for (const candidate of [baseUrl, FALLBACK_A2A_BASE_URL]) {
    if (!candidate) continue;
    if (!candidates.includes(candidate)) candidates.push(candidate);
  }

  let lastError;
  for (const candidateBaseUrl of candidates) {
    try {
      const r = await fetchWithRetry(`${candidateBaseUrl}/api/agents/${agentId}/a2a`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Babylon-Api-Key': apiKey },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'message/send', params: { message }, id }),
      }, { retries: 1 });

      const raw = await r.text();
      const json = parseJsonSafe(raw);

      if (!r.ok) {
        const detail = json ? buildA2aFailureMessage(json) : raw;
        throw new Error(`HTTP ${r.status} from ${candidateBaseUrl}: ${detail}`);
      }

      if (!json) {
        throw new Error(`Invalid JSON response from ${candidateBaseUrl}: ${raw.slice(0, 300)}`);
      }

      if (json.error) {
        throw new Error(`JSON-RPC ${json.error.code ?? 'error'} from ${candidateBaseUrl}: ${json.error.message ?? JSON.stringify(json.error)}`);
      }

      if (json?.result?.status?.state === 'failed') {
        throw new Error(`A2A failed on ${candidateBaseUrl}: ${buildA2aFailureMessage(json)}`);
      }

      if (!json?.result) {
        throw new Error(`A2A missing result from ${candidateBaseUrl}: ${raw.slice(0, 300)}`);
      }

      return json?.result?.artifacts?.[0]?.parts?.[0]?.data ?? json.result;
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(lastError?.message ?? `A2A failed for ${operation} on agent ${agentId}`);
}

async function notifyDiscord(message, webhookUrl = process.env.DISCORD_WEBHOOK_URL) {
  if (!webhookUrl) {
    console.warn('Discord notification skipped: DISCORD_WEBHOOK_URL not set');
    return;
  }
  try {
    const r = await fetchWithRetry(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message }),
    }, { retries: 1, timeoutMs: 10_000 });
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
