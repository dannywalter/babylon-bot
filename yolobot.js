/**
 * YOLObot - Autonomous perp trader
 * Identity: yolobot-1773783207865 (on your main account)
 * Auth: main BABYLON_API_KEY + x-agent-id header
 */
require('dotenv').config({ quiet: true });

const { notifyDiscord } = require('./perp-client');

const A2A_URL = 'https://babylon.market/api/a2a';
const API_KEY = process.env.BABYLON_API_KEY;
const AGENT_ID = process.env.YOLOBOT_AGENT_ID;
const DRY_RUN = process.env.DRY_RUN !== 'false';

let msgId = 0;

function fmtUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '$0.00';
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function buildYoloAlert({ emoji, ticker, event, side, price, trigger, pnl, size, reason, error }) {
  const lines = [`${emoji} [YOLObot] ${ticker} ${event}`];
  if (side) lines.push(`Side: ${side}`);
  if (price) lines.push(`Price: ${price}`);
  if (trigger) lines.push(`Trigger: ${trigger}`);
  if (pnl) lines.push(`PnL: ${pnl}`);
  if (size) lines.push(`Size: ${size}`);
  if (reason) lines.push(`Reason: ${reason}`);
  if (error) lines.push(`Error: ${error}`);
  return lines.join('\n');
}

async function a2a(operation, params = {}) {
  const res = await fetch(A2A_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Babylon-Api-Key': API_KEY,
      'x-agent-id': AGENT_ID,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'message/send',
      params: { message: { messageId: `yb-${++msgId}-${Date.now()}`, parts: [{ kind: 'data', data: { operation, params } }] } },
      id: msgId,
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`A2A error: ${JSON.stringify(json.error)}`);
  // Result artifact or agent message
  const artifact = json?.result?.artifacts?.[0]?.parts?.[0]?.data;
  const agentMsg = json?.result?.history?.find(m => m.role === 'agent')?.parts?.[0]?.text;
  if (!artifact && agentMsg) throw new Error(`Agent error: ${agentMsg}`);
  return artifact ?? json.result;
}

async function notify(msg) {
  console.log('[discord]', msg.replaceAll('\n', ' | '));
  await notifyDiscord(msg);
}

async function getBalance() {
  const data = await a2a('portfolio.get_balance');
  return data.balance;
}

async function getPositions() {
  const data = await a2a('portfolio.get_positions');
  const candidates = [
    data?.perpPositions,
    data?.perpetuals?.positions,
    data?.perpetuals,
    data?.positions,
  ];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;

    // Keep only perp-like entries and only currently open positions.
    const perps = candidate.filter((position) => {
      const ticker = String(position?.ticker ?? '').trim();
      const size = Number(position?.size ?? position?.collateral ?? 0);
      return Boolean(ticker) && Number.isFinite(size) && size > 0 && !position?.closedAt;
    });

    if (perps.length > 0) {
      return perps;
    }
  }

  return [];
}

async function getPerps() {
  const data = await a2a('markets.list_perpetuals', { limit: 100 });
  return data.perpetuals ?? data.markets ?? [];
}

async function openPosition(ticker, side, amount, leverage = 1) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would open ${side.toUpperCase()} ${ticker} $${amount} @ ${leverage}x`);
    return null;
  }
  return a2a('markets.open_position', { ticker, side, amount, leverage });
}

async function closePosition(positionId) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would close position ${positionId}`);
    return null;
  }
  return a2a('markets.close_position', { positionId });
}

// ─── Strategy ──────────────────────────────────────────────────────────────

// Configurable via env
const TICKERS = (process.env.YOLO_TICKERS || 'METAI').split(',').map(t => t.trim());
const TRADE_SIZE = parseFloat(process.env.YOLO_TRADE_SIZE || '1000');
const STOP_LOSS_PCT = parseFloat(process.env.YOLO_STOP_LOSS_PCT || '10');   // close if loss > X%
const TAKE_PROFIT_PCT = parseFloat(process.env.YOLO_TAKE_PROFIT_PCT || '20'); // close if profit > X%
const MIN_24H_MOVE = parseFloat(process.env.YOLO_MIN_24H_MOVE || '5');       // % move needed to open

async function runLoop() {
  console.log(`\n[${new Date().toISOString()}] YOLObot tick`);
  console.log(`DRY_RUN=${DRY_RUN} | tickers=${TICKERS} | size=$${TRADE_SIZE} | SL=${STOP_LOSS_PCT}% TP=${TAKE_PROFIT_PCT}%`);

  const [balance, positions, perps] = await Promise.all([getBalance(), getPositions(), getPerps()]);
  console.log(`Balance: $${balance.toFixed(2)} | Open perp positions: ${positions.length}`);

  // ── 1. Manage existing positions ──────────────────────────────────────
  for (const pos of positions) {
    const ticker = String(pos.ticker || '').toUpperCase();
    if (!TICKERS.includes(ticker)) continue;

    const size = Number(pos.size ?? pos.collateral ?? 0);
    const pnl = Number(pos.unrealizedPnL ?? 0);
    const pnlPct = size > 0 ? (pnl / size) * 100 : 0;
    const positionId = pos.id ?? pos.positionId;
    console.log(`  ${ticker} ${String(pos.side || '').toUpperCase()} $${size} | PnL: ${pnlPct.toFixed(2)}%`);

    if (pnlPct <= -STOP_LOSS_PCT) {
      const baseMsg = `Stop loss hit on ${ticker} ${pos.side} (${pnlPct.toFixed(1)}%) - closing`;
      console.log(baseMsg);
      const result = positionId ? await closePosition(positionId) : null;
      if (result) {
        await notify(buildYoloAlert({
          emoji: '🟡',
          ticker,
          event: 'EXIT',
          side: String(pos.side || '').toUpperCase(),
          pnl: `${fmtUsd(result.realizedPnL)} (${pnlPct.toFixed(1)}%)`,
          size: fmtUsd(size),
          trigger: `<= -${STOP_LOSS_PCT}%`,
          reason: 'Stop loss hit',
        }));
      }
    } else if (pnlPct >= TAKE_PROFIT_PCT) {
      const baseMsg = `Take profit hit on ${ticker} ${pos.side} (+${pnlPct.toFixed(1)}%) - closing`;
      console.log(baseMsg);
      const result = positionId ? await closePosition(positionId) : null;
      if (result) {
        await notify(buildYoloAlert({
          emoji: '🟢',
          ticker,
          event: 'EXIT',
          side: String(pos.side || '').toUpperCase(),
          pnl: `${fmtUsd(result.realizedPnL)} (+${pnlPct.toFixed(1)}%)`,
          size: fmtUsd(size),
          trigger: `>= +${TAKE_PROFIT_PCT}%`,
          reason: 'Take profit hit',
        }));
      }
    }
  }

  // ── 2. Look for new entries ────────────────────────────────────────────
  const openTickers = new Set(positions.map((p) => String(p.ticker || '').toUpperCase()));

  for (const ticker of TICKERS) {
    if (openTickers.has(ticker)) continue; // already in position

    const market = perps.find(p => p.ticker === ticker);
    if (!market) { console.log(`  ${ticker}: not found in perp markets`); continue; }

    const changePct = market.currentPrice > 0
      ? (market.priceChange24h / (market.currentPrice - market.priceChange24h)) * 100
      : 0;
    console.log(`  ${ticker}: price=$${market.currentPrice} 24h change = ${changePct.toFixed(2)}%`);

    if (Math.abs(changePct) < MIN_24H_MOVE) {
      console.log(`  ${ticker}: move too small, skipping`);
      continue;
    }

    // Trend-following: go with the direction of 24h move
    const side = changePct > 0 ? 'long' : 'short';
    const msg = `Opening ${side.toUpperCase()} ${ticker} $${TRADE_SIZE} (24h: ${changePct.toFixed(1)}%)`;
    console.log(msg);
    const result = await openPosition(ticker, side, TRADE_SIZE);
    if (result) {
      await notify(buildYoloAlert({
        emoji: '🔵',
        ticker,
        event: 'OPEN',
        side: side.toUpperCase(),
        price: fmtUsd(result.position?.entryPrice),
        size: fmtUsd(TRADE_SIZE),
        trigger: `${changePct.toFixed(1)}% 24h move`,
        reason: 'Trend-following entry',
      }));
    }
  }
}

// Run once then exit (designed for cron/GitHub Actions)
runLoop().then(() => {
  console.log('\nDone.');
}).catch(async (err) => {
  console.error('Fatal error:', err.message);
  await notify(buildYoloAlert({
    emoji: '❌',
    ticker: 'SYSTEM',
    event: 'ERROR',
    reason: 'Run loop aborted',
    error: err.message,
  })).catch(() => {});
  process.exit(1);
});
