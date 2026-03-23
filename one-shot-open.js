require('dotenv').config();

const { a2aAgentCall } = require('./perp-client');

const AGENT_ID = process.argv[2];
const TICKER   = process.argv[3];
const SIDE     = process.argv[4];
const AMOUNT   = parseInt(process.argv[5], 10);

if (!AGENT_ID || !TICKER || !SIDE || !AMOUNT) {
  console.error('Usage: node one-shot-open.js <agentId> <ticker> <long|short> <amount>');
  process.exit(1);
}

(async () => {
  console.log(`Opening 1x ${SIDE.toUpperCase()} ${TICKER} size=$${AMOUNT} on agent ${AGENT_ID}…`);
  try {
    const data = await a2aAgentCall('markets.open_position', { ticker: TICKER, side: SIDE, amount: AMOUNT, leverage: 1 }, AGENT_ID, AGENT_ID);
    console.log('SUCCESS:', JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('FAILED:', e.message);
    process.exit(1);
  }
})();
