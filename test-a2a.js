#!/usr/bin/env node
// Test external agent authentication via A2A endpoint
require('dotenv').config();

const A2A_ENDPOINT = 'https://babylon.game/api/a2a';

async function a2aRequest(apiKey, operation, params = {}) {
  const res = await fetch(A2A_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Babylon-Api-Key': apiKey,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'message/send',
      params: {
        message: {
          parts: [{ kind: 'data', data: { operation, params } }],
        },
      },
      id: Date.now(),
    }),
  });
  const text = await res.text();
  console.log(`[${operation}] HTTP ${res.status}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function main() {
  const daKey = process.env.DOCTOR_ASS_API_KEY;
  const mainKey = process.env.BABYLON_API_KEY;

  console.log('=== Testing with DOCTOR ASS external agent key ===');
  const balRes = await a2aRequest(daKey, 'portfolio.get_balance');
  console.log(JSON.stringify(balRes, null, 2));

  console.log('\n=== Getting positions for DOCTOR ASS ===');
  const posRes = await a2aRequest(daKey, 'portfolio.get_positions');
  console.log(JSON.stringify(posRes, null, 2));

  // Sanity-check main account still works
  console.log('\n=== Sanity check: main account balance via A2A ===');
  const mainBal = await a2aRequest(mainKey, 'portfolio.get_balance');
  console.log(JSON.stringify(mainBal, null, 2));
}

main().catch(console.error);
