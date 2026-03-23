/**
 * Agent Perp Flipper
 *
 * Runs threshold-based perp flips for a dedicated registered agent identity.
 * Uses BABYLON_AGENT_API_KEY for auth and BABYLON_AGENT_ID as position context.
 *
 * Flip logic:
 *   - If holding LONG and price > {TICKER}_AGENT_FLIP_TO_SHORT_ABOVE => close LONG, open SHORT
 *   - If holding SHORT and price < {TICKER}_AGENT_FLIP_TO_LONG_BELOW => close SHORT, open LONG
 *
 * Usage:
 *   node agent-flipper.js            # one-shot check
 *   node agent-flipper.js --watch    # poll every POLL_INTERVAL_MS (default 30s)
 *   node agent-flipper.js --dry-run  # simulate without trading
 */

require('dotenv').config();

// Reuse shared clients that read BABYLON_API_KEY.
if (process.env.BABYLON_AGENT_API_KEY) {
  process.env.BABYLON_API_KEY = process.env.BABYLON_AGENT_API_KEY;
}

const { restGet, a2aAgentCall, notifyDiscord } = require('./perp-client');
const { parseNumber, parseCsv } = require('./trading-core');

const API_KEY = process.env.BABYLON_API_KEY;
const AGENT_ID = process.env.BABYLON_AGENT_ID;
const AGENT_LABEL = process.env.AGENT_LABEL || 'DOCTOR ASS';
const POLL_MS = parseNumber(process.env.POLL_INTERVAL_MS, 30_000);
const args = process.argv.slice(2);
const WATCH = args.includes('--watch');
const DRY_RUN = args.includes('--dry-run') || process.env.DRY_RUN === 'true';

const TICKERS = parseCsv(process.env.AGENT_TICKERS || 'TSLAI').map((t) => t.toUpperCase());
const AGENT_TRADE_SIZE = parseNumber(process.env.AGENT_TRADE_SIZE, 900_000);

const AGENT_TICKER_DEFAULTS = {
  TSLAI: { flipToShortAbove: 970, flipToLongBelow: 120 },
};

function getAgentThresholds(ticker) {
  const d = AGENT_TICKER_DEFAULTS[ticker] ?? { flipToShortAbove: Infinity, flipToLongBelow: -Infinity };
  return {
    flipToShortAbove: parseNumber(process.env[`${ticker}_AGENT_FLIP_TO_SHORT_ABOVE`], d.flipToShortAbove),
    flipToLongBelow: parseNumber(process.env[`${ticker}_AGENT_FLIP_TO_LONG_BELOW`], d.flipToLongBelow),
  };
}

function fmtUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '$0.00';
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function buildAlert({ emoji, ticker, event, side, price, trigger, pnl, size, reason, error }) {
  const lines = [`${emoji} [${AGENT_LABEL}] ${ticker} ${event}`];
  if (side) lines.push(`Side: ${side}`);
  if (price) lines.push(`Price: ${price}`);
  if (trigger) lines.push(`Trigger: ${trigger}`);
  if (pnl) lines.push(`PnL: ${pnl}`);
  if (size) lines.push(`Size: ${size}`);
  if (reason) lines.push(`Reason: ${reason}`);
  if (error) lines.push(`Error: ${error}`);
  return lines.join('\n');
}

async function getPrice(ticker) {
  const data = await restGet('/api/markets/perps');
  const market = data.markets?.find((m) => m.ticker === ticker);
  if (!market) throw new Error(`${ticker} market not found in /api/markets/perps`);
  return market.markPrice ?? market.currentPrice;
}

async function getAgentPosition(ticker) {
  const data = await restGet(`/api/markets/positions/${encodeURIComponent(AGENT_ID)}`);
  return (data?.perpetuals?.positions ?? []).find((p) => p.ticker === ticker) ?? null;
}

async function closeAgentPosition(position) {
  if (!position) return;
  console.log(`  [${AGENT_LABEL}] Closing ${position.ticker} ${String(position.side || '').toUpperCase()} pos=${position.id}...`);
  await a2aAgentCall('markets.close_position', { positionId: position.id }, AGENT_ID, AGENT_ID);
}

async function openAgentPosition(ticker, side, size) {
  console.log(`  [${AGENT_LABEL}] Opening 1x ${String(side).toUpperCase()} ${ticker} size=${fmtUsd(size)}...`);
  return a2aAgentCall('markets.open_position', { ticker, side, amount: size, leverage: 1 }, AGENT_ID, AGENT_ID);
}

async function checkAgentTicker(ticker) {
  const { flipToShortAbove, flipToLongBelow } = getAgentThresholds(ticker);
  const [price, position] = await Promise.all([getPrice(ticker), getAgentPosition(ticker)]);

  const side = position?.side ?? 'none';
  const pnl = position ? fmtUsd(position.unrealizedPnL) : 'n/a';
  const pnlPct = position ? `${(position.unrealizedPnLPercent ?? 0).toFixed(2)}%` : 'n/a';
  const sizeVal = position?.size ? fmtUsd(position.size) : null;
  const priceStr = fmtUsd(price);
  const flipShortStr = fmtUsd(flipToShortAbove);
  const flipLongStr = fmtUsd(flipToLongBelow);

  console.log(`[${new Date().toISOString()}] [${AGENT_LABEL}] ${ticker} price=${priceStr} position=${String(side).toUpperCase()} uPnL=${pnl} (${pnlPct})`);
  console.log(`  Thresholds: flip-to-SHORT above ${flipShortStr} | flip-to-LONG below ${flipLongStr}`);

  if (price > flipToShortAbove && side === 'long') {
    const alert = buildAlert({
      emoji: '🔴',
      ticker,
      event: 'FLIP',
      side: 'LONG -> SHORT',
      price: priceStr,
      trigger: `above ${flipShortStr}`,
      pnl: `${pnl} (${pnlPct})`,
      size: sizeVal,
      reason: `Price crossed above threshold ${flipShortStr}`,
    });
    console.log(`  *** ${alert.replaceAll('\n', ' | ')} ***`);
    try {
      if (!DRY_RUN) {
        await closeAgentPosition(position);
        const nextSize = position?.size ?? AGENT_TRADE_SIZE;
        await openAgentPosition(ticker, 'short', nextSize);
      } else {
        console.log(`  [${AGENT_LABEL}] [DRY RUN] would close ${ticker} LONG and open SHORT`);
      }
      await notifyDiscord(alert);
    } catch (e) {
      console.error(`  [FLIP ERROR] ${e.message}`);
      await notifyDiscord(buildAlert({
        emoji: '❌',
        ticker,
        event: 'FLIP FAILED',
        side: 'LONG -> SHORT',
        price: priceStr,
        trigger: `above ${flipShortStr}`,
        pnl: `${pnl} (${pnlPct})`,
        size: sizeVal,
        error: e.message,
      }));
    }
    return;
  }

  if (price < flipToLongBelow && side === 'short') {
    const alert = buildAlert({
      emoji: '🟢',
      ticker,
      event: 'FLIP',
      side: 'SHORT -> LONG',
      price: priceStr,
      trigger: `below ${flipLongStr}`,
      pnl: `${pnl} (${pnlPct})`,
      size: sizeVal,
      reason: `Price dropped below threshold ${flipLongStr}`,
    });
    console.log(`  *** ${alert.replaceAll('\n', ' | ')} ***`);
    try {
      if (!DRY_RUN) {
        await closeAgentPosition(position);
        const nextSize = position?.size ?? AGENT_TRADE_SIZE;
        await openAgentPosition(ticker, 'long', nextSize);
      } else {
        console.log(`  [${AGENT_LABEL}] [DRY RUN] would close ${ticker} SHORT and open LONG`);
      }
      await notifyDiscord(alert);
    } catch (e) {
      console.error(`  [FLIP ERROR] ${e.message}`);
      await notifyDiscord(buildAlert({
        emoji: '❌',
        ticker,
        event: 'FLIP FAILED',
        side: 'SHORT -> LONG',
        price: priceStr,
        trigger: `below ${flipLongStr}`,
        pnl: `${pnl} (${pnlPct})`,
        size: sizeVal,
        error: e.message,
      }));
    }
    return;
  }

  console.log('  No action needed.');
}

async function main() {
  if (!API_KEY) {
    console.error('ERROR: Missing API key. Set BABYLON_AGENT_API_KEY or BABYLON_API_KEY.');
    process.exit(1);
  }

  if (!AGENT_ID) {
    console.error('ERROR: BABYLON_AGENT_ID is not set.');
    process.exit(1);
  }

  if (!TICKERS.length) {
    console.error('ERROR: AGENT_TICKERS is empty.');
    process.exit(1);
  }

  if (DRY_RUN) console.log('[DRY RUN MODE - no trades will execute]\n');
  console.log(`Agent: ${AGENT_LABEL} (${AGENT_ID})`);
  console.log(`Monitoring tickers: ${TICKERS.join(', ')}`);
  console.log();

  async function checkAll() {
    for (const ticker of TICKERS) {
      try {
        await checkAgentTicker(ticker);
      } catch (e) {
        console.error(`[ERROR] [${AGENT_LABEL}] ${ticker}: ${e.message}`);
        if (e.message.includes('401') || e.message.includes('403')) {
          console.error('  -> Agent API key rejected. Check BABYLON_AGENT_API_KEY.');
        }
      }
    }
  }

  await checkAll();

  if (WATCH) {
    console.log(`\nWatching every ${POLL_MS / 1000}s (Ctrl+C to stop)...\n`);
    setInterval(checkAll, POLL_MS);
  }
}

main().catch((e) => {
  console.error('[FATAL]', e.message);
  process.exit(1);
});
