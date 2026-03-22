/**
 * Multi-ticker Position Flipper
 *
 * Polls perp prices and flips position direction when thresholds are crossed:
 *   - If holding LONG  and price rises above {TICKER}_FLIP_TO_SHORT_ABOVE  → close LONG,  open 1x SHORT
 *   - If holding SHORT and price falls below {TICKER}_FLIP_TO_LONG_BELOW   → close SHORT, open 1x LONG
 *
 * Usage:
 *   node openagi-flip.js            # one-shot check
 *   node openagi-flip.js --watch    # poll every POLL_INTERVAL_MS (default 30s)
 *   node openagi-flip.js --dry-run  # simulate without trading
 *
 * Required .env vars:
 *   BABYLON_API_KEY       – Babylon API key (permanent, no expiry)
 *   BABYLON_USER_ID       – did:privy:... identifier
 *
 * Optional .env vars:
 *   TICKERS                         comma-separated list, default "OPENAGI"
 *   {TICKER}_FLIP_TO_SHORT_ABOVE    e.g. OPENAGI_FLIP_TO_SHORT_ABOVE=1750
 *   {TICKER}_FLIP_TO_LONG_BELOW     e.g. OPENAGI_FLIP_TO_LONG_BELOW=200
 *   POLL_INTERVAL_MS                default 30000
 *   DISCORD_WEBHOOK_URL             Discord webhook for flip notifications
 *   DIRECTOR_AGENT_ID               Default director agent ID (e.g. YOLObot)
 *   DIRECTOR_TRADE_SIZE             Default dollar size for director trades (e.g. 900000)
 *   DIRECTOR_TICKERS                comma-separated tickers to manage on director agents ONLY (no user position needed)
 *   {TICKER}_DIRECTOR_AGENT_ID      per-ticker agent ID (falls back to DIRECTOR_AGENT_ID)
 *   {TICKER}_DIRECTOR_AGENT_NAME    display name for logs/Discord (e.g. YOLObot, PatrickBatemAIn)
 *   {TICKER}_DIRECTOR_FLIP_TO_SHORT_ABOVE   e.g. AIPHB_DIRECTOR_FLIP_TO_SHORT_ABOVE=600
 *   {TICKER}_DIRECTOR_FLIP_TO_LONG_BELOW    e.g. AIPHB_DIRECTOR_FLIP_TO_LONG_BELOW=130
 *   {TICKER}_DIRECTOR_TRADE_SIZE            per-ticker size override (falls back to DIRECTOR_TRADE_SIZE)
 *   DRY_RUN                         set to true to simulate without trading
 */

require('dotenv').config();

const API_KEY             = process.env.BABYLON_API_KEY;
const USER_ID             = process.env.BABYLON_USER_ID || 'did:privy:cmi9b6ko8011djv0czb0ozbvm';
const BASE_REST           = 'https://play.babylon.market';
const BASE_MCP            = 'https://play.babylon.market/mcp';
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const POLL_MS             = parseInt(process.env.POLL_INTERVAL_MS ?? '30000', 10);
let   a2aMsgId            = 0;

// Parse ticker list — supports TICKERS env var or falls back to all known tickers
const TICKERS = (process.env.TICKERS ?? 'OPENAGI,SPCX').split(',').map(t => t.trim().toUpperCase());

const TICKER_DEFAULTS = {
  OPENAGI: { flipToShortAbove: 1750, flipToLongBelow: 200  },
  SPCX:    { flipToShortAbove: 600,  flipToLongBelow: 100  },
};

// Director-only tickers: YOLObot positions managed independently of the user's own
const DIRECTOR_TICKERS = process.env.DIRECTOR_TICKERS
  ? process.env.DIRECTOR_TICKERS.split(',').map(t => t.trim().toUpperCase())
  : [];

const DIRECTOR_TICKER_DEFAULTS = {
  AIPHB: { flipToShortAbove: 600,      flipToLongBelow: 130 },
  AIPPL: { flipToShortAbove: 700,      flipToLongBelow: 100 },
};

function getDirectorAgentId(ticker) {
  return process.env[`${ticker}_DIRECTOR_AGENT_ID`] ?? DIRECTOR_AGENT_ID;
}

function getDirectorAgentName(ticker) {
  const id = getDirectorAgentId(ticker);
  return process.env[`${ticker}_DIRECTOR_AGENT_NAME`] ?? id ?? 'Director';
}

function getDirectorThresholds(ticker) {
  const defaults = DIRECTOR_TICKER_DEFAULTS[ticker] ?? { flipToShortAbove: Infinity, flipToLongBelow: -Infinity };
  return {
    flipToShortAbove: parseFloat(process.env[`${ticker}_DIRECTOR_FLIP_TO_SHORT_ABOVE`] ?? defaults.flipToShortAbove),
    flipToLongBelow:  parseFloat(process.env[`${ticker}_DIRECTOR_FLIP_TO_LONG_BELOW`]  ?? defaults.flipToLongBelow),
  };
}

function getDirectorTradeSize(ticker) {
  return parseInt(process.env[`${ticker}_DIRECTOR_TRADE_SIZE`] ?? DIRECTOR_TRADE_SIZE, 10);
}

function getThresholds(ticker) {
  const defaults = TICKER_DEFAULTS[ticker] ?? { flipToShortAbove: Infinity, flipToLongBelow: -Infinity };
  return {
    flipToShortAbove: parseFloat(process.env[`${ticker}_FLIP_TO_SHORT_ABOVE`] ?? defaults.flipToShortAbove),
    flipToLongBelow:  parseFloat(process.env[`${ticker}_FLIP_TO_LONG_BELOW`]  ?? defaults.flipToLongBelow),
  };
}

const args    = process.argv.slice(2);
const WATCH   = args.includes('--watch');
const DRY_RUN = args.includes('--dry-run') || process.env.DRY_RUN === 'true';

// ── Director: execute trades directly on YOLObot's A2A endpoint ───────────────
// Calls markets.open/close_position on YOLObot's own A2A server so trades
// execute against YOLObot's separately-capped balance, not our main account.
// Set DIRECTOR_AGENT_ID=292539064819646464 in .env / GitHub Actions secrets.

const DIRECTOR_AGENT_ID  = process.env.DIRECTOR_AGENT_ID;
const DIRECTOR_TRADE_SIZE = parseInt(process.env.DIRECTOR_TRADE_SIZE ?? '0', 10);

// contextId: the DID/ID that determines which account trades execute in.
// agentId: which agent's A2A endpoint to send the command to.
async function yoloA2a(operation, params = {}, contextId = USER_ID, agentId = DIRECTOR_AGENT_ID) {
  const id = ++a2aMsgId;

  // Babylon A2A agents use kind:data with a nested params object and contextId.
  // kind:text is JSON.parsed server-side (not plain LLM dispatch).
  const message = {
    messageId: `dir-${id}`,
    role: 'user',
    parts: [{ kind: 'data', data: { operation, params } }],
  };
  if (contextId != null) message.contextId = contextId;

  const r = await fetch(`https://babylon.market/api/agents/${agentId}/a2a`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Babylon-Api-Key': API_KEY },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'message/send',
      params: { message },
      id,
    }),
  });
  const json = await r.json();
  if (json?.result?.status?.state === 'failed') {
    const msg = json?.result?.status?.message?.parts?.[0]?.text ?? JSON.stringify(json);
    throw new Error(`YoloA2A failed: ${msg}`);
  }
  return json?.result?.artifacts?.[0]?.parts?.[0]?.data ?? json?.result;
}

async function directAgent(side, ticker, mainPositionId) {
  if (!DIRECTOR_AGENT_ID || !DIRECTOR_TRADE_SIZE) return;
  if (DRY_RUN) { console.log(`  [YOLObot] [DRY RUN] would flip ${side.toUpperCase()} ${ticker} size=$${DIRECTOR_TRADE_SIZE}`); return; }

  try {
    // Close existing position via REST positions endpoint (more reliable than A2A portfolio query)
    const posData = await restGet(`/api/markets/positions/${encodeURIComponent(DIRECTOR_AGENT_ID)}`);
    const existing = (posData?.perpetuals?.positions ?? []).find(p => p.ticker === ticker);
    if (existing) {
      console.log(`  [YOLObot] Closing existing ${existing.side.toUpperCase()} ${ticker} pos=${existing.id}…`);
      await yoloA2a('markets.close_position', { positionId: existing.id });
    }

    // Open new position with configured size
    console.log(`  [YOLObot] Opening 1x ${side.toUpperCase()} ${ticker} size=$${DIRECTOR_TRADE_SIZE}…`);
    const result = await yoloA2a('markets.open_position', { ticker, side, amount: DIRECTOR_TRADE_SIZE, leverage: 1 });
    console.log(`  [YOLObot] Done:`, JSON.stringify(result));
  } catch (e) {
    console.warn(`  [YOLObot] Director trade failed: ${e.message}`);
  }
}

// ── Director-only ticker check ──────────────────────────────────────────────
// Watches YOLObot's own position for a ticker and flips it when thresholds
// are crossed — no user-side position required.

async function checkDirectorTicker(ticker) {
  const directorAgentId = getDirectorAgentId(ticker);
  const agentLabel = getDirectorAgentName(ticker);

  if (!directorAgentId) {
    console.warn(`  [Director] No agent ID for ${ticker} — set ${ticker}_DIRECTOR_AGENT_ID or DIRECTOR_AGENT_ID`);
    return;
  }

  const { flipToShortAbove, flipToLongBelow } = getDirectorThresholds(ticker);
  const tradeSize = getDirectorTradeSize(ticker);
  if (!tradeSize) {
    console.warn(`  [Director] No trade size for ${ticker} — set ${ticker}_DIRECTOR_TRADE_SIZE or DIRECTOR_TRADE_SIZE`);
    return;
  }

  const now = new Date().toISOString();
  const price = await getPrice(ticker);

  // Get the director agent's own position for this ticker
  const posData = await restGet(`/api/markets/positions/${encodeURIComponent(directorAgentId)}`);
  const position = (posData?.perpetuals?.positions ?? []).find(p => p.ticker === ticker) ?? null;
  const side = position?.side ?? 'none';
  const pnl = position ? `$${position.unrealizedPnL?.toFixed(2)}` : 'n/a';
  const pnlPct = position ? `${position.unrealizedPnLPercent?.toFixed(2)}%` : 'n/a';

  console.log(`[${now}] [${agentLabel}] ${ticker} price=$${price.toFixed(2)}  position=${side.toUpperCase()}  uPnL=${pnl} (${pnlPct})`);
  console.log(`  Director thresholds: flip-to-SHORT above $${flipToShortAbove}  |  flip-to-LONG below $${flipToLongBelow}`);

  // Agent-owned positions must be closed with the agent's own numeric ID as contextId.
  // Falls back to USER_ID for positions previously opened in user context.
  async function tryClose(pos, label) {
    if (!pos) return;
    console.log(`  [${agentLabel}] Closing ${label} pos=${pos.id}…`);
    try {
      await yoloA2a('markets.close_position', { positionId: pos.id }, directorAgentId, directorAgentId);
      console.log(`  [${agentLabel}] Closed via agent context.`);
      return;
    } catch (e1) {
      console.warn(`  [${agentLabel}] Close (agent ctx) failed: ${e1.message}`);
    }
    try {
      await yoloA2a('markets.close_position', { positionId: pos.id }, USER_ID, directorAgentId);
      console.log(`  [${agentLabel}] Closed via user context.`);
      return;
    } catch (e2) {
      console.warn(`  [${agentLabel}] Close (user ctx) also failed: ${e2.message} — proceeding to open anyway.`);
    }
  }

  // Flip LONG → SHORT
  if (price > flipToShortAbove && side === 'long') {
    const header = `🔴 [${agentLabel}] ${ticker} FLIP: LONG → SHORT\nPrice $${price.toFixed(2)} crossed above $${flipToShortAbove}\nuPnL at signal: ${pnl} (${pnlPct})`;
    console.log(`  *** ${header.replaceAll('\n', ' | ')} ***`);
    try {
      if (!DRY_RUN) {
        await tryClose(position, `${ticker} LONG`);
        console.log(`  [${agentLabel}] Opening 1x SHORT ${ticker} size=$${tradeSize}…`);
        const result = await yoloA2a('markets.open_position', { ticker, side: 'short', amount: tradeSize, leverage: 1 }, directorAgentId, directorAgentId);
        console.log(`  [${agentLabel}] Done:`, JSON.stringify(result));
      } else {
        console.log(`  [${agentLabel}] [DRY RUN] would close ${ticker} LONG and open SHORT size=$${tradeSize}`);
      }
      await notifyDiscord(header);
    } catch (e) {
      console.error(`  [${agentLabel}] FLIP ERROR: ${e.message}`);
      await notifyDiscord(`❌ [${agentLabel}] ${ticker} FLIP FAILED: LONG → SHORT\n${e.message}`);
    }
    return;
  }

  // Flip SHORT → LONG
  if (price < flipToLongBelow && side === 'short') {
    const header = `🟢 [${agentLabel}] ${ticker} FLIP: SHORT → LONG\nPrice $${price.toFixed(2)} dropped below $${flipToLongBelow}\nuPnL at signal: ${pnl} (${pnlPct})`;
    console.log(`  *** ${header.replaceAll('\n', ' | ')} ***`);
    try {
      if (!DRY_RUN) {
        await tryClose(position, `${ticker} SHORT`);
        console.log(`  [${agentLabel}] Opening 1x LONG ${ticker} size=$${tradeSize}…`);
        const result = await yoloA2a('markets.open_position', { ticker, side: 'long', amount: tradeSize, leverage: 1 }, directorAgentId, directorAgentId);
        console.log(`  [${agentLabel}] Done:`, JSON.stringify(result));
      } else {
        console.log(`  [${agentLabel}] [DRY RUN] would close ${ticker} SHORT and open LONG size=$${tradeSize}`);
      }
      await notifyDiscord(header);
    } catch (e) {
      console.error(`  [${agentLabel}] FLIP ERROR: ${e.message}`);
      await notifyDiscord(`❌ [${agentLabel}] ${ticker} FLIP FAILED: SHORT → LONG\n${e.message}`);
    }
    return;
  }

  console.log('  No action needed.');
}

// ── Discord notification ─────────────────────────────────────────────────────

async function notifyDiscord(message) {
  if (!DISCORD_WEBHOOK_URL) {
    console.warn('Discord notification skipped: DISCORD_WEBHOOK_URL not set');
    return;
  }
  try {
    const r = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message }),
    });
    if (!r.ok) {
      const body = await r.text();
      console.warn(`Discord notification failed: HTTP ${r.status} — ${body}`);
    } else {
      console.log('  Discord notification sent.');
    }
  } catch (e) {
    console.warn('Discord notification failed:', e.message);
  }
}

// ── REST helpers ──────────────────────────────────────────────────────────────

async function restGet(path) {
  const r = await fetch(`${BASE_REST}${path}`, {
    headers: { 'X-Babylon-Api-Key': API_KEY },
  });
  if (!r.ok) throw new Error(`REST ${r.status} ${r.statusText} — ${path}`);
  return r.json();
}

async function restPost(path, body) {
  const r = await fetch(`${BASE_REST}${path}`, {
    method: 'POST',
    headers: {
      'X-Babylon-Api-Key': API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`REST POST ${r.status} — ${path}: ${JSON.stringify(data)}`);
  return data;
}

// ── MCP helper (for open_position / close_position) ───────────────────────────

async function mcpCall(toolName, toolArgs = {}) {
  const r = await fetch(BASE_MCP, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Babylon-Api-Key': API_KEY,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: toolName, arguments: toolArgs },
      id: Date.now(),
    }),
  });
  const payload = await r.json();
  if (payload.error) throw new Error(`MCP error: ${payload.error.message}`);
  const text = payload?.result?.content?.find(c => c.type === 'text')?.text;
  try { return JSON.parse(text); } catch { return text; }
}

// ── Domain logic ──────────────────────────────────────────────────────────────

async function getPrice(ticker) {
  const data = await restGet('/api/markets/perps');
  const market = data.markets?.find(m => m.ticker === ticker);
  if (!market) throw new Error(`${ticker} market not found in /api/markets/perps`);
  return market.markPrice ?? market.currentPrice;
}

async function getPosition(ticker) {
  const data = await restGet(`/api/markets/positions/${encodeURIComponent(USER_ID)}`);
  const positions = data?.perpetuals?.positions ?? [];
  // Exclude agent-owned positions (isAgentPosition:true) so we only act on our own positions.
  return positions.find(p => p.ticker === ticker && !p.isAgentPosition) ?? null;
}

async function closePosition(positionId) {
  console.log(`  → Closing position ${positionId}…`);
  if (DRY_RUN) { console.log('  [DRY RUN] skipping close'); return; }

  const result = await mcpCall('close_position', { positionId });
  console.log('  Closed via MCP:', JSON.stringify(result));
  return result;
}

async function openPosition(ticker, side, size) {
  console.log(`  → Opening 1x ${side.toUpperCase()} ${ticker} size=${size}…`);
  if (DRY_RUN) { console.log('  [DRY RUN] skipping open'); return; }

  const result = await mcpCall('open_position', {
    ticker,
    side: side.toUpperCase(),
    amount: size,
    leverage: 1,
  });
  console.log('  Opened via MCP:', JSON.stringify(result));
  return result;
}

// ── Per-ticker check ──────────────────────────────────────────────────────────

async function checkTicker(ticker) {
  const { flipToShortAbove, flipToLongBelow } = getThresholds(ticker);
  const now = new Date().toISOString();
  const [price, position] = await Promise.all([getPrice(ticker), getPosition(ticker)]);

  const side   = position?.side ?? 'none';
  const pnlPct = position ? `${position.unrealizedPnLPercent.toFixed(2)}%` : 'n/a';
  const pnl    = position ? `$${position.unrealizedPnL.toFixed(2)}` : 'n/a';

  console.log(`[${now}] ${ticker} price=$${price.toFixed(2)}  position=${side.toUpperCase()}  uPnL=${pnl} (${pnlPct})`);
  console.log(`  Thresholds: flip-to-SHORT above $${flipToShortAbove}  |  flip-to-LONG below $${flipToLongBelow}`);

  // ── Flip LONG → SHORT ─────────────────────────────────────────────────────
  if (price > flipToShortAbove && side === 'long') {
    const header = `🔴 ${ticker} FLIP: LONG → SHORT\nPrice $${price.toFixed(2)} crossed above $${flipToShortAbove}\nuPnL at close: ${pnl} (${pnlPct})\nSize: $${position.size.toLocaleString()}`;
    console.log(`  *** ${header.replaceAll('\n', ' | ')} ***`);
    const size = position.size;
    try {
      await closePosition(position.id);
      await openPosition(ticker, 'short', size);
      await directAgent('short', ticker);
      await notifyDiscord(header);
    } catch (e) {
      console.error(`  [FLIP ERROR] ${e.message}`);
      await notifyDiscord(`❌ ${ticker} FLIP FAILED: LONG → SHORT\n${e.message}`);
      throw e;
    }
    return;
  }

  // ── Flip SHORT → LONG ─────────────────────────────────────────────────────
  if (price < flipToLongBelow && side === 'short') {
    const header = `🟢 ${ticker} FLIP: SHORT → LONG\nPrice $${price.toFixed(2)} dropped below $${flipToLongBelow}\nuPnL at close: ${pnl} (${pnlPct})\nSize: $${position.size.toLocaleString()}`;
    console.log(`  *** ${header.replaceAll('\n', ' | ')} ***`);
    const size = position.size;
    try {
      await closePosition(position.id);
      await openPosition(ticker, 'long', size);
      await directAgent('long', ticker);
      await notifyDiscord(header);
    } catch (e) {
      console.error(`  [FLIP ERROR] ${e.message}`);
      await notifyDiscord(`❌ ${ticker} FLIP FAILED: SHORT → LONG\n${e.message}`);
      throw e;
    }
    return;
  }

  console.log('  No action needed.');
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  if (!API_KEY) {
    console.error('ERROR: BABYLON_API_KEY is not set in .env');
    process.exit(1);
  }

  if (DRY_RUN) console.log('[DRY RUN MODE — no trades will execute]\n');
  if (TICKERS.length)         console.log(`Monitoring tickers: ${TICKERS.join(', ')}`);
  if (DIRECTOR_TICKERS.length) console.log(`Director tickers:   ${DIRECTOR_TICKERS.join(', ')} (YOLObot-only)`);
  console.log();

  async function checkAll() {
    for (const ticker of TICKERS) {
      try { await checkTicker(ticker); } catch (e) {
        console.error(`[ERROR] ${ticker}:`, e.message);
        if (e.message.includes('401') || e.message.includes('403')) {
          console.error('  → API key rejected. Check BABYLON_API_KEY in .env.');
        }
      }
    }
    for (const ticker of DIRECTOR_TICKERS) {
      try { await checkDirectorTicker(ticker); } catch (e) {
        console.error(`[ERROR] [Director] ${ticker}:`, e.message);
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
