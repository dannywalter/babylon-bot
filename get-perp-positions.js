require('dotenv').config();

const BASE_URL = 'https://babylon.market';
const API_KEY = process.env.BABYLON_API_KEY;

async function apiGet(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'x-babylon-api-key': API_KEY },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${path}`);
  return res.json();
}

async function main() {
  // 1. Get current user's ID
  const me = await apiGet('/api/users/me');
  const userId = me.id;
  console.log(`User: ${me.username} (${userId})\n`);

  // 2. Get all positions (predictions + perpetuals)
  const { perpetuals = [], predictions = [] } = await apiGet(`/api/markets/positions/${userId}`);

  if (perpetuals.length === 0) {
    console.log('No open perpetual positions found.');
  } else {
    console.log('=== Perpetual Positions ===');
    for (const p of perpetuals) {
      const pnlSign = p.unrealizedPnL >= 0 ? '+' : '';
      console.log(
        `[${p.side.toUpperCase()}] ${p.ticker}  ` +
        `${p.leverage}x | collateral: ${p.collateral} | ` +
        `entry: ${p.entryPrice} | mark: ${p.markPrice} | ` +
        `uPnL: ${pnlSign}${p.unrealizedPnL}  (id: ${p.id})`
      );
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Perpetuals: ${perpetuals.length} open`);
  console.log(`Predictions: ${predictions.length} open`);
}

main().catch(err => console.error('Error:', err.message));
