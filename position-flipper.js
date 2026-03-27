/**
 * Multi-ticker Position Flipper
 *
 * Polls perp prices and flips position direction when thresholds are crossed:
 *   - If holding LONG  and price rises above {TICKER}_FLIP_TO_SHORT_ABOVE  → close LONG,  open 1x SHORT
 *   - If holding SHORT and price falls below {TICKER}_FLIP_TO_LONG_BELOW   → close SHORT, open 1x LONG
 *
 * Usage:
 *   node position-flipper.js            # one-shot check
 *   node position-flipper.js --watch    # poll every POLL_INTERVAL_MS (default 30s)
 *   node position-flipper.js --dry-run  # simulate without trading
 *
 * Required .env vars:
 *   BABYLON_API_KEY       – Babylon API key (permanent, no expiry)
 *   BABYLON_USER_ID       – did:privy:... identifier
 *
 * Optional .env vars:
 *   BABYLON_BASE_URL                override base URL (default https://play.babylon.market)
 *   TICKERS                         comma-separated list, default "OPENAGI,SPCX"
 *   {TICKER}_FLIP_TO_SHORT_ABOVE    e.g. OPENAGI_FLIP_TO_SHORT_ABOVE=1750
 *   {TICKER}_FLIP_TO_LONG_BELOW     e.g. OPENAGI_FLIP_TO_LONG_BELOW=200 *   {TICKER}_DEFAULT_OPEN_SIZE      fallback size for user-ticker recovery when no position exists *   POLL_INTERVAL_MS                default 30000
 *   DISCORD_WEBHOOK_URL             Discord webhook for flip notifications
 *   DIRECTOR_AGENT_ID               Default director agent ID
 *   DIRECTOR_TRADE_SIZE             Default dollar size for director trades (e.g. 900000)
 *   DIRECTOR_TICKERS                comma-separated tickers to manage on director agents ONLY (no user position needed)
 *   {TICKER}_DIRECTOR_AGENT_ID      per-ticker agent ID (falls back to DIRECTOR_AGENT_ID)
 *   {TICKER}_DIRECTOR_AGENT_NAME    display name for logs/Discord (e.g. Director, PatrickBatemAIn)
 *   {TICKER}_DIRECTOR_FLIP_TO_SHORT_ABOVE   e.g. AIPHB_DIRECTOR_FLIP_TO_SHORT_ABOVE=600
 *   {TICKER}_DIRECTOR_FLIP_TO_LONG_BELOW    e.g. AIPHB_DIRECTOR_FLIP_TO_LONG_BELOW=130
 *   {TICKER}_DIRECTOR_TRADE_SIZE            per-ticker size override (falls back to DIRECTOR_TRADE_SIZE)
 *   DRY_RUN                         set to true to simulate without trading
 */

require('dotenv').config();

const { restGet, mcpCall, a2aAgentCall, notifyDiscord } = require('./perp-client');
const { parseNumber, parseCsv } = require('./trading-core');

const API_KEY  = process.env.BABYLON_API_KEY;
const USER_ID  = process.env.BABYLON_USER_ID || 'did:privy:cmi9b6ko8011djv0czb0ozbvm';
const POLL_MS  = parseNumber(process.env.POLL_INTERVAL_MS, 30_000);
const args     = process.argv.slice(2);
const WATCH    = args.includes('--watch');
const DRY_RUN  = args.includes('--dry-run') || process.env.DRY_RUN === 'true';

const TICKERS          = parseCsv(process.env.TICKERS  || 'OPENAGI,SPCX').map(t => t.toUpperCase());
const DIRECTOR_KEYS = parseCsv(process.env.DIRECTOR_TICKERS).map(t => t.toUpperCase());

const DIRECTOR_AGENT_ID   = process.env.DIRECTOR_AGENT_ID;
const DIRECTOR_TRADE_SIZE = parseNumber(process.env.DIRECTOR_TRADE_SIZE, 0);

// ── Threshold config ──────────────────────────────────────────────────────────

const TICKER_DEFAULTS = {
  OPENAGI: { flipToShortAbove: 1750, flipToLongBelow: 200 },
  SPCX:    { flipToShortAbove: 600,  flipToLongBelow: 100 },
};

const DIRECTOR_TICKER_DEFAULTS = {
  AIPHB:   { flipToShortAbove: 600,  flipToLongBelow: 130 },
  AIPPL:   { flipToShortAbove: 700,  flipToLongBelow: 100 },
  TSLAI:   { flipToShortAbove: 800,  flipToLongBelow: 120 },
  SPCX:    { flipToShortAbove: 700,  flipToLongBelow:  80 },
  OPENAGI: { flipToShortAbove: 1800, flipToLongBelow: 350 },
};

function getThresholds(ticker) {
  const d = TICKER_DEFAULTS[ticker] ?? { flipToShortAbove: Infinity, flipToLongBelow: -Infinity };
  return {
    flipToShortAbove: parseNumber(process.env[`${ticker}_FLIP_TO_SHORT_ABOVE`], d.flipToShortAbove),
    flipToLongBelow:  parseNumber(process.env[`${ticker}_FLIP_TO_LONG_BELOW`],  d.flipToLongBelow),
  };
}

function getDirectorThresholds(ticker) {
  const d = DIRECTOR_TICKER_DEFAULTS[ticker] ?? { flipToShortAbove: Infinity, flipToLongBelow: -Infinity };
  return {
    flipToShortAbove: parseNumber(process.env[`${ticker}_DIRECTOR_FLIP_TO_SHORT_ABOVE`], d.flipToShortAbove),
    flipToLongBelow:  parseNumber(process.env[`${ticker}_DIRECTOR_FLIP_TO_LONG_BELOW`],  d.flipToLongBelow),
  };
}

function splitDirectorKey(directorKey) {
  const [ticker] = String(directorKey || '').split('__');
  return { marketTicker: String(ticker || '').toUpperCase() };
}

function getDirectorThresholdsForKey(directorKey) {
  const { marketTicker } = splitDirectorKey(directorKey);
  const d = DIRECTOR_TICKER_DEFAULTS[marketTicker] ?? { flipToShortAbove: Infinity, flipToLongBelow: -Infinity };
  return {
    flipToShortAbove: parseNumber(
      process.env[`${directorKey}_DIRECTOR_FLIP_TO_SHORT_ABOVE`],
      parseNumber(process.env[`${marketTicker}_DIRECTOR_FLIP_TO_SHORT_ABOVE`], d.flipToShortAbove)
    ),
    flipToLongBelow: parseNumber(
      process.env[`${directorKey}_DIRECTOR_FLIP_TO_LONG_BELOW`],
      parseNumber(process.env[`${marketTicker}_DIRECTOR_FLIP_TO_LONG_BELOW`], d.flipToLongBelow)
    ),
  };
}

function getDirectorAgentId(ticker) {
  return process.env[`${ticker}_DIRECTOR_AGENT_ID`] ?? DIRECTOR_AGENT_ID;
}

function getDirectorAgentIdForKey(directorKey) {
  const { marketTicker } = splitDirectorKey(directorKey);
  return (
    process.env[`${directorKey}_DIRECTOR_AGENT_ID`] ??
    process.env[`${marketTicker}_DIRECTOR_AGENT_ID`] ??
    DIRECTOR_AGENT_ID
  );
}

function getDirectorAgentName(ticker) {
  return process.env[`${ticker}_DIRECTOR_AGENT_NAME`] ?? getDirectorAgentId(ticker) ?? 'Director';
}

function getDirectorAgentNameForKey(directorKey, agentId) {
  const { marketTicker } = splitDirectorKey(directorKey);
  return (
    process.env[`${directorKey}_DIRECTOR_AGENT_NAME`] ??
    process.env[`${marketTicker}_DIRECTOR_AGENT_NAME`] ??
    agentId ??
    'Director'
  );
}

function getDirectorTradeSize(ticker) {
  return parseNumber(process.env[`${ticker}_DIRECTOR_TRADE_SIZE`], DIRECTOR_TRADE_SIZE);
}

function getDirectorTradeSizeForKey(directorKey) {
  const { marketTicker } = splitDirectorKey(directorKey);
  return parseNumber(
    process.env[`${directorKey}_DIRECTOR_TRADE_SIZE`],
    parseNumber(process.env[`${marketTicker}_DIRECTOR_TRADE_SIZE`], DIRECTOR_TRADE_SIZE)
  );
}

function fmtUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '$0.00';
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function buildAlert({ emoji, label, ticker, event, side, price, trigger, pnl, size, reason, error }) {
  const lines = [`${emoji} [${label}] ${ticker} ${event}`];
  if (side) lines.push(`Side: ${side}`);
  if (price) lines.push(`Price: ${price}`);
  if (trigger) lines.push(`Trigger: ${trigger}`);
  if (pnl) lines.push(`PnL: ${pnl}`);
  if (size) lines.push(`Size: ${size}`);
  if (reason) lines.push(`Reason: ${reason}`);
  if (error) lines.push(`Error: ${error}`);
  return lines.join('\n');
}

// ── Price / position fetchers ─────────────────────────────────────────────────

async function getPrice(ticker) {
  const data = await restGet('/api/markets/perps');
  const market = data.markets?.find(m => m.ticker === ticker);
  if (!market) throw new Error(`${ticker} market not found in /api/markets/perps`);
  return market.markPrice ?? market.currentPrice;
}

async function getUserPosition(ticker) {
  const data = await restGet(`/api/markets/positions/${encodeURIComponent(USER_ID)}`);
  // Exclude agent-owned positions so we only act on our own.
  return (data?.perpetuals?.positions ?? [])
    .find(p => p.ticker === ticker && !p.isAgentPosition) ?? null;
}

// ── Core flip engine ──────────────────────────────────────────────────────────

/**
 * Check a ticker and flip its position when a threshold is crossed.
 * @param {object} opts
 * @param {string} opts.ticker
 * @param {string} opts.label        display name for logs / Discord
 * @param {{ flipToShortAbove: number, flipToLongBelow: number }} opts.thresholds
 * @param {() => Promise<object|null>} opts.getPos    resolves current position or null
 * @param {(pos: object) => Promise<void>} opts.closePos
 * @param {(side: string, pos: object) => Promise<void>} opts.openPos
 */
async function checkFlip({ ticker, label, thresholds, getPos, closePos, openPos }) {
  const { flipToShortAbove, flipToLongBelow } = thresholds;
  const [price, position] = await Promise.all([getPrice(ticker), getPos()]);

  const side    = position?.side ?? 'none';
  const pnl     = position ? fmtUsd(position.unrealizedPnL) : 'n/a';
  const pnlPct  = position ? `${(position.unrealizedPnLPercent ?? 0).toFixed(2)}%` : 'n/a';
  const sizeVal = position?.size ? fmtUsd(position.size) : null;
  const priceStr = fmtUsd(price);
  const flipShortStr = fmtUsd(flipToShortAbove);
  const flipLongStr = fmtUsd(flipToLongBelow);

  console.log(`[${new Date().toISOString()}] [${label}] ${ticker} price=${priceStr}  position=${side.toUpperCase()}  uPnL=${pnl} (${pnlPct})`);
  console.log(`  Thresholds: flip-to-SHORT above ${flipShortStr}  |  flip-to-LONG below ${flipLongStr}`);

  if (price > flipToShortAbove && side === 'long') {
    const header = buildAlert({
      emoji: '🔴',
      label,
      ticker,
      event: 'FLIP',
      side: 'LONG -> SHORT',
      price: priceStr,
      trigger: `above ${flipShortStr}`,
      pnl: `${pnl} (${pnlPct})`,
      size: sizeVal,
      reason: `Price crossed above threshold ${flipShortStr}`,
    });
    console.log(`  *** ${header.replaceAll('\n', ' | ')} ***`);
    try {
      if (!DRY_RUN) {
        await closePos(position);
        await openPos('short', position);
        await notifyDiscord(header);
      } else {
        console.log(`  [${label}] [DRY RUN] would close ${ticker} LONG and open SHORT`);
      }
    } catch (e) {
      console.error(`  [FLIP ERROR] ${e.message}`);
      await notifyDiscord(buildAlert({
        emoji: '❌',
        label,
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
    const header = buildAlert({
      emoji: '🟢',
      label,
      ticker,
      event: 'FLIP',
      side: 'SHORT -> LONG',
      price: priceStr,
      trigger: `below ${flipLongStr}`,
      pnl: `${pnl} (${pnlPct})`,
      size: sizeVal,
      reason: `Price dropped below threshold ${flipLongStr}`,
    });
    console.log(`  *** ${header.replaceAll('\n', ' | ')} ***`);
    try {
      if (!DRY_RUN) {
        await closePos(position);
        await openPos('long', position);
        await notifyDiscord(header);
      } else {
        console.log(`  [${label}] [DRY RUN] would close ${ticker} SHORT and open LONG`);
      }
    } catch (e) {
      console.error(`  [FLIP ERROR] ${e.message}`);
      await notifyDiscord(buildAlert({
        emoji: '❌',
        label,
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

  if (side === 'none') {
    const targetSide = price > flipToShortAbove ? 'short' : 'long';
    const header = buildAlert({
      emoji: '🟡',
      label,
      ticker,
      event: 'RECOVER',
      side: targetSide.toUpperCase(),
      price: priceStr,
      reason: 'No position found — opening to restore coverage',
    });
    console.log(`  *** ${header.replaceAll('\n', ' | ')} ***`);
    try {
      if (!DRY_RUN) {
        await openPos(targetSide, null);
        await notifyDiscord(header);
      } else {
        console.log(`  [${label}] [DRY RUN] no position found, would open ${targetSide.toUpperCase()}`);
      }
    } catch (e) {
      console.error(`  [RECOVER ERROR] ${e.message}`);
      await notifyDiscord(buildAlert({
        emoji: '❌',
        label,
        ticker,
        event: 'RECOVER FAILED',
        side: targetSide.toUpperCase(),
        price: priceStr,
        error: e.message,
      }));
    }
    return;
  }

  console.log('  No action needed.');
}

// ── User account ticker check ─────────────────────────────────────────────────

async function checkUserTicker(ticker) {
  await checkFlip({
    ticker,
    label: ticker,
    thresholds: getThresholds(ticker),
    getPos: () => getUserPosition(ticker),
    closePos: async (pos) => {
      console.log(`  → Closing position ${pos.id}…`);
      const result = await mcpCall('close_position', { positionId: pos.id });
      console.log('  Closed via MCP:', JSON.stringify(result));
    },
    openPos: async (side, prevPos) => {
      const size = prevPos?.size ?? parseNumber(process.env[`${ticker}_DEFAULT_OPEN_SIZE`], 0);
      if (!size) {
        console.warn(`  [${ticker}] Cannot recover: no position size reference. Set ${ticker}_DEFAULT_OPEN_SIZE to enable.`);
        return;
      }
      console.log(`  → Opening 1x ${side.toUpperCase()} ${ticker} size=${size}…`);
      const result = await mcpCall('open_position', { ticker, side: side.toUpperCase(), amount: size, leverage: 1 });
      console.log('  Opened via MCP:', JSON.stringify(result));
      await syncDirectorAgent(side, ticker);
    },
  });
}

// ── Director agent sync ───────────────────────────────────────────────────────
// Called after a user flip to keep the configured director agent in sync.

async function syncDirectorAgent(side, ticker) {
  if (!DIRECTOR_AGENT_ID || !DIRECTOR_TRADE_SIZE) return;
  const directorLabel = getDirectorAgentName(ticker);
  if (DRY_RUN) {
    console.log(`  [${directorLabel}] [DRY RUN] would flip ${side.toUpperCase()} ${ticker} size=$${DIRECTOR_TRADE_SIZE}`);
    return;
  }
  try {
    const posData = await restGet(`/api/markets/positions/${encodeURIComponent(DIRECTOR_AGENT_ID)}`);
    const existing = (posData?.perpetuals?.positions ?? []).find(p => p.ticker === ticker);
    if (existing) {
      console.log(`  [${directorLabel}] Closing existing ${existing.side.toUpperCase()} ${ticker} pos=${existing.id}…`);
      await a2aAgentCall('markets.close_position', { positionId: existing.id }, DIRECTOR_AGENT_ID, DIRECTOR_AGENT_ID);
    }
    console.log(`  [${directorLabel}] Opening 1x ${side.toUpperCase()} ${ticker} size=$${DIRECTOR_TRADE_SIZE}…`);
    const result = await a2aAgentCall('markets.open_position', { ticker, side, amount: DIRECTOR_TRADE_SIZE, leverage: 1 }, DIRECTOR_AGENT_ID, DIRECTOR_AGENT_ID);
    console.log(`  [${directorLabel}] Done:`, JSON.stringify(result));
  } catch (e) {
    console.warn(`  [${directorLabel}] Director sync failed: ${e.message}`);
  }
}

// ── Director-only ticker check ────────────────────────────────────────────────
// Watches an agent's own position and flips it — no user-side position required.

async function checkDirectorTicker(directorKey) {
  const { marketTicker: ticker } = splitDirectorKey(directorKey);
  const agentId    = getDirectorAgentIdForKey(directorKey);
  const agentLabel = getDirectorAgentNameForKey(directorKey, agentId);
  const tradeSize  = getDirectorTradeSizeForKey(directorKey);

  if (!agentId) {
    console.warn(`  [Director] No agent ID for ${ticker} — set ${ticker}_DIRECTOR_AGENT_ID or DIRECTOR_AGENT_ID`);
    return;
  }
  if (!tradeSize) {
    console.warn(`  [Director] No trade size for ${ticker} — set ${ticker}_DIRECTOR_TRADE_SIZE or DIRECTOR_TRADE_SIZE`);
    return;
  }

  // Try agent context first, then fall back to user context.
  async function tryClose(pos) {
    if (!pos) return;
    console.log(`  [${agentLabel}] Closing ${ticker} ${pos.side.toUpperCase()} pos=${pos.id}…`);
    for (const ctxId of [agentId, USER_ID]) {
      try {
        await a2aAgentCall('markets.close_position', { positionId: pos.id }, ctxId, agentId);
        console.log(`  [${agentLabel}] Closed via context ${ctxId}.`);
        return;
      } catch (e) {
        console.warn(`  [${agentLabel}] Close (ctx=${ctxId}) failed: ${e.message}`);
      }
    }
    console.warn(`  [${agentLabel}] All close attempts failed — proceeding to open anyway.`);
  }

  await checkFlip({
    ticker,
    label: agentLabel,
    thresholds: getDirectorThresholdsForKey(directorKey),
    getPos: async () => {
      const data = await restGet(`/api/markets/positions/${encodeURIComponent(agentId)}`);
      return (data?.perpetuals?.positions ?? []).find(p => p.ticker === ticker) ?? null;
    },
    closePos: tryClose,
    openPos: async (side) => {
      console.log(`  [${agentLabel}] Opening 1x ${side.toUpperCase()} ${ticker} size=$${tradeSize}…`);
      const result = await a2aAgentCall('markets.open_position', { ticker, side, amount: tradeSize, leverage: 1 }, agentId, agentId);
      console.log(`  [${agentLabel}] Done:`, JSON.stringify(result));
    },
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  if (!API_KEY) {
    console.error('ERROR: BABYLON_API_KEY is not set in .env');
    process.exit(1);
  }

  if (DRY_RUN) console.log('[DRY RUN MODE — no trades will execute]\n');
  if (TICKERS.length)          console.log(`Monitoring tickers: ${TICKERS.join(', ')}`);
  if (DIRECTOR_KEYS.length) console.log(`Director tickers:   ${DIRECTOR_KEYS.join(', ')} (agent-only)`);
  console.log();

  async function checkAll() {
    for (const ticker of TICKERS) {
      try { await checkUserTicker(ticker); } catch (e) {
        console.error(`[ERROR] ${ticker}:`, e.message);
        if (e.message.includes('401') || e.message.includes('403')) {
          console.error('  → API key rejected. Check BABYLON_API_KEY in .env.');
        }
      }
    }
    for (const directorKey of DIRECTOR_KEYS) {
      try { await checkDirectorTicker(directorKey); } catch (e) {
        console.error(`[ERROR] [Director] ${directorKey}:`, e.message);
      }
    }
  }

  await checkAll();

  if (WATCH) {
    console.log(`\nWatching every ${POLL_MS / 1000}s (Ctrl+C to stop)…\n`);
    setInterval(checkAll, POLL_MS);
  }
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
