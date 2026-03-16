#!/usr/bin/env node
// Proxies MCP stdio <-> Babylon HTTP, silently dropping outgoing notifications
// (messages with no "id") which the Babylon server incorrectly rejects.

const https = require('https');
const readline = require('readline');

const API_KEY = process.env.BABYLON_API_KEY;
const MCP_URL = 'https://play.babylon.market/mcp';

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  // Drop notifications (no "id" field) - Babylon server rejects them
  if (msg.id === undefined || msg.id === null) return;

  const body = JSON.stringify(msg);
  const url = new URL(MCP_URL);

  const options = {
    hostname: url.hostname,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'x-babylon-api-key': API_KEY,
    },
  };

  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      if (data.trim()) process.stdout.write(data.trim() + '\n');
    });
  });

  req.on('error', (e) => {
    process.stderr.write(`Proxy error: ${e.message}\n`);
  });

  req.write(body);
  req.end();
});
