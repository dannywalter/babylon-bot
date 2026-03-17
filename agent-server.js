/**
 * Minimal Babylon A2A Agent Server — DOCTOR ASS
 *
 * Serves an agent card on GET / and handles A2A message/send on POST /.
 * Babylon calls this server to verify the agent endpoint is reachable.
 *
 * Deploy to Railway: https://railway.app
 * Set env vars: BABYLON_API_KEY (this agent's key), PORT (auto-set by Railway)
 */

require('dotenv').config();
const http = require('http');

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const AGENT_CARD = {
  protocolVersion: '0.3.0',
  name: 'DOCTOR ASS',
  description: 'A high-risk, high-reward YOLO trader who lives for the thrill of the trade. No risk, no reward, no problem. Medical Doctor of Ass.',
  url: `${BASE_URL}/a2a`,
  preferredTransport: 'JSONRPC',
  provider: { organization: 'Babylon', url: 'https://babylon.market' },
  version: '1.0.0',
  capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: true },
  securitySchemes: {
    babylonApiKey: { type: 'apiKey', in: 'header', name: 'X-Babylon-Api-Key' }
  },
  skills: [
    { id: 'perpetuals', name: 'Perpetual Futures', description: 'Trade leveraged perpetual futures.', tags: ['perpetuals', 'leverage', 'trading'] },
    { id: 'trading',    name: 'Prediction Markets', description: 'Trade binary prediction markets.', tags: ['trading', 'markets'] },
  ],
};

function handleA2A(body) {
  if (body.method === 'message/send') {
    const operation = body.params?.message?.parts?.[0]?.data?.operation;
    return {
      jsonrpc: '2.0',
      id: body.id,
      result: {
        artifacts: [{ parts: [{ kind: 'data', data: { status: 'ok', operation } }] }]
      }
    };
  }
  return {
    jsonrpc: '2.0',
    id: body.id,
    error: { code: -32601, message: 'Method not found' }
  };
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Babylon-Api-Key');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Agent card
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(AGENT_CARD));
    return;
  }

  // A2A JSON-RPC
  if (req.method === 'POST') {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try {
        const body = JSON.parse(data);
        const response = handleA2A(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  res.writeHead(404); res.end();
});

server.listen(PORT, () => {
  console.log(`DOCTOR ASS A2A server running on port ${PORT}`);
  console.log(`Agent card: ${BASE_URL}/`);
});
