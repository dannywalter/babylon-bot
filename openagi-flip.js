/**
 * OPENAGI Position Flipper
 *
 * Polls OPENAGI price and flips direction when thresholds are crossed:
 *   - If holding LONG  and price rises above FLIP_TO_SHORT_ABOVE  → close LONG,  open 1x SHORT
 *   - If holding SHORT and price falls below FLIP_TO_LONG_BELOW   → close SHORT, open 1x LONG
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
 *   OPENAGI_FLIP_TO_SHORT_ABOVE   default 1750
 *   OPENAGI_FLIP_TO_LONG_BELOW    default 200
 *   POLL_INTERVAL_MS              default 30000
 *   DISCORD_WEBHOOK_URL           Discord webhook for flip notifications
 */

require('dotenv').config();

const API_KEY         = process.env.BABYLON_API_KEY;
const USER_ID         = process.env.BABYLON_USER_ID || 'did:privy:cmi9b6ko8011djv0czb0ozbvm';
const BASE_REST       = 'https://play.babylon.market';
const BASE_MCP        = 'https://play.babylon.market/mcp';
const TICKER          = 'OPENAGI';

const FLIP_TO_SHORT_ABOVE   = parseFloat(process.env.OPENAGI_FLIP_TO_SHORT_ABOVE ?? '1750');
const FLIP_TO_LONG_BELOW    = parseFloat(process.env.OPENAGI_FLIP_TO_LONG_BELOW  ?? '200');
const DISCORD_WEBHOOK_URL   = process.env.DISCORD_WEBHOOK_URL;
const POLL_MS             = parseInt(process.env.POLL_INTERVAL_MS ?? '30000', 10);

const args    = process.argv.slice(2);
const WATCH   = args.includes('--watch');
const DRY_RUN = args.includes('--dry-run') || process.env.DRY_RUN === 'true';

// ── Discord notification ─────────────────────────────────────────────────────

async function notifyDiscord(message) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message }),
    });
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

async function getOpenAGIPrice() {
  const data = await restGet('/api/markets/perps');
  const market = data.markets?.find(m => m.ticker === TICKER);
  if (!market) throw new Error(`${TICKER} market not found in /api/markets/perps`);
  return market.markPrice ?? market.currentPrice;
}

async function getOpenAGIPosition() {
  const data = await restGet(`/api/markets/positions/${encodeURIComponent(USER_ID)}`);
  const positions = data?.perpetuals?.positions ?? [];
  return positions.find(p => p.ticker === TICKER) ?? null;
}

async function closePosition(positionId) {
  console.log(`  → Closing position ${positionId}…`);
  if (DRY_RUN) { console.log('  [DRY RUN] skipping close'); return; }

  // Try REST first, fall back to MCP
  try {
    const result = await restPost(`/api/markets/perps/position/${positionId}/close`, {});
    console.log('  Closed via REST:', JSON.stringify(result));
    return result;
  } catch (restErr) {
    console.warn(`  REST close failed (${restErr.message}), trying MCP…`);
    const result = await mcpCall('close_position', { positionId });
    console.log('  Closed via MCP:', JSON.stringify(result));
    return result;
  }
}

async function openPosition(side, size) {
  console.log(`  → Opening 1x ${side.toUpperCase()} ${TICKER} size=${size}…`);
  if (DRY_RUN) { console.log('  [DRY RUN] skipping open'); return; }

  // Try REST first, fall back to MCP
  try {
    const result = await restPost('/api/markets/perps/open', {
      ticker: TICKER,
      side: side.toLowerCase(),
      amount: size,
      leverage: 1,
    });
    console.log('  Opened via REST:', JSON.stringify(result));
    return result;
  } catch (restErr) {
    console.warn(`  REST open failed (${restErr.message}), trying MCP…`);
    const result = await mcpCall('open_position', {
      ticker: TICKER,
      side: side.toUpperCase(),
      amount: size,
      leverage: 1,
    });
    console.log('  Opened via MCP:', JSON.stringify(result));
    return result;
  }
}

// ── Main check ────────────────────────────────────────────────────────────────

async function check() {
  const now = new Date().toISOString();
  const [price, position] = await Promise.all([getOpenAGIPrice(), getOpenAGIPosition()]);

  const side = position?.side ?? 'none';
  const pnlPct = position ? `${position.unrealizedPnLPercent.toFixed(2)}%` : 'n/a';
  const pnl    = position ? `$${position.unrealizedPnL.toFixed(2)}` : 'n/a';

  console.log(`[${now}] ${TICKER} price=$${price.toFixed(2)}  position=${side.toUpperCase()}  uPnL=${pnl} (${pnlPct})`);
  console.log(`  Thresholds: flip-to-SHORT above $${FLIP_TO_SHORT_ABOVE}  |  flip-to-LONG below $${FLIP_TO_LONG_BELOW}`);

  // ── Flip LONG → SHORT ─────────────────────────────────────────────────────
  if (price > FLIP_TO_SHORT_ABOVE && side === 'long') {
    const msg = `🔴 OPENAGI FLIP: LONG → SHORT\nPrice $${price.toFixed(2)} crossed above $${FLIP_TO_SHORT_ABOVE}\nuPnL at close: ${pnl} (${pnlPct})\nSize: $${position.size.toLocaleString()}`;
    console.log(`  *** ${msg.replaceAll('\n', ' | ')} ***`);
    const size = position.size;
    await closePosition(position.id);
    await openPosition('short', size);
    await notifyDiscord(msg);
    return;
  }

  // ── Flip SHORT → LONG ─────────────────────────────────────────────────────
  if (price < FLIP_TO_LONG_BELOW && side === 'short') {
    const msg = `🟢 OPENAGI FLIP: SHORT → LONG\nPrice $${price.toFixed(2)} dropped below $${FLIP_TO_LONG_BELOW}\nuPnL at close: ${pnl} (${pnlPct})\nSize: $${position.size.toLocaleString()}`;
    console.log(`  *** ${msg.replaceAll('\n', ' | ')} ***`);
    const size = position.size;
    await closePosition(position.id);
    await openPosition('long', size);
    await notifyDiscord(msg);
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

  await check();

  if (WATCH) {
    console.log(`\nWatching every ${POLL_MS / 1000}s (Ctrl+C to stop)…\n`);
    setInterval(async () => {
      try { await check(); } catch (e) {
        console.error('[ERROR]', e.message);
        if (e.message.includes('401') || e.message.includes('403')) {
          console.error('  → API key rejected. Check BABYLON_API_KEY in .env.');
        }
      }
    }, POLL_MS);
  }
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
