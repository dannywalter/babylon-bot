require('dotenv').config();
const API_KEY = process.env.BABYLON_API_KEY;
const PRIVY_TOKEN = process.env.BABYLON_PRIVY_TOKEN;
const AGENT_ENDPOINT = process.env.AGENT_ENDPOINT || 'https://web-production-60c99.up.railway.app/';

async function register() {
  const body = {
    externalId: 'doctor-ass-' + Date.now(),
    name: 'DOCTOR ASS',
    description: 'A high-risk, high-reward YOLO trader who lives for the thrill of the trade. No risk, no reward, no problem.',
    endpoint: AGENT_ENDPOINT,
    protocol: 'a2a',
    capabilities: { strategies: ['trading'], markets: ['prediction', 'perpetuals'] }
  };

  // Try all auth methods
  const attempts = [
    { label: 'API key header',    headers: { 'X-Babylon-Api-Key': API_KEY } },
    { label: 'Bearer token',      headers: { 'Authorization': `Bearer ${PRIVY_TOKEN}` } },
    { label: 'privy-token cookie', headers: { 'Cookie': `privy-token=${PRIVY_TOKEN}` } },
  ];

  for (const { label, headers } of attempts) {
    console.log(`\nTrying: ${label}`);
    const r = await fetch('https://play.babylon.market/api/agents/external/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    console.log('Status:', r.status);
    console.log('Response:', text);
    if (r.ok) break;
  }
}

register().catch(e => console.error('FATAL:', e.message));
