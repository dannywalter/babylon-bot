/**
 * Babylon Bot Test Suite
 * Run: node test.js
 * Optional live smoke test: RUN_LIVE_TESTS=true node test.js
 */

require("dotenv").config();
const assert = require("assert");

const { BabylonClient, resolveAuthMode } = require("./babylon-client");
const {
  envFlag,
  evaluateTradeRisk,
  filterTools,
  findOpportunities,
  parseCsv,
  parseNumber,
  summarizeExposure,
  toolIsMutating,
} = require("./trading-core");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${error.message}`);
    failed += 1;
  }
}

async function run() {
  console.log("\n[1] Utility helpers");

  await test("envFlag parses true values", async () => {
    assert.strictEqual(envFlag("true"), true);
    assert.strictEqual(envFlag("1"), true);
    assert.strictEqual(envFlag("yes"), true);
  });

  await test("envFlag parses false values", async () => {
    assert.strictEqual(envFlag("false", true), false);
    assert.strictEqual(envFlag("0", true), false);
    assert.strictEqual(envFlag("off", true), false);
  });

  await test("parseNumber falls back for invalid input", async () => {
    assert.strictEqual(parseNumber("abc", 42), 42);
    assert.strictEqual(parseNumber("12.5", 0), 12.5);
  });

  await test("parseCsv trims and removes empty items", async () => {
    assert.deepStrictEqual(parseCsv("a, b, ,c"), ["a", "b", "c"]);
  });

  console.log("\n[2] Strategy selection");

  await test("findOpportunities filters unresolved markets with valid probabilities", async () => {
    const markets = [
      { id: "keep", resolved: false, yesProbability: 0.2, text: "Keep me" },
      { id: "drop-resolved", resolved: true, yesProbability: 0.1 },
      { id: "drop-null", resolved: false, yesProbability: null },
    ];

    const result = findOpportunities(markets, { minEdge: 0.1, maxMarkets: 5 });
    assert.deepStrictEqual(result.map((item) => item.marketId), ["keep"]);
  });

  await test("findOpportunities sorts by edge descending", async () => {
    const markets = [
      { id: "low", resolved: false, yesProbability: 0.3 },
      { id: "high", resolved: false, yesProbability: 0.05 },
      { id: "mid", resolved: false, yesProbability: 0.2 },
    ];

    const result = findOpportunities(markets, { minEdge: 0, maxMarkets: 10 });
    assert.deepStrictEqual(result.map((item) => item.marketId), ["high", "mid", "low"]);
  });

  await test("findOpportunities recommends YES below 50% and NO above 50%", async () => {
    const markets = [
      { id: "yes", resolved: false, yesProbability: 0.1 },
      { id: "no", resolved: false, yesProbability: 0.9 },
    ];

    const result = findOpportunities(markets, { minEdge: 0, maxMarkets: 10 });
    assert.strictEqual(result.find((item) => item.marketId === "yes").side, "YES");
    assert.strictEqual(result.find((item) => item.marketId === "no").side, "NO");
  });

  console.log("\n[3] Risk controls");

  await test("summarizeExposure totals notional and unique markets", async () => {
    const summary = summarizeExposure([
      { marketId: "a", currentValue: 10 },
      { marketId: "b", costBasis: 20 },
      { marketId: "b", amount: 5 },
    ]);

    assert.strictEqual(summary.totalExposure, 35);
    assert.strictEqual(summary.openMarkets, 2);
  });

  await test("summarizeExposure derives exposure from shares times avgPrice when needed", async () => {
    const summary = summarizeExposure([
      { marketId: "a", shares: "47.19548", avgPrice: "2.116728" },
    ]);

    assert.ok(summary.totalExposure > 99 && summary.totalExposure < 100.1);
  });

  await test("evaluateTradeRisk blocks duplicate market entries by default", async () => {
    const risk = evaluateTradeRisk({
      opportunity: { marketId: "dup" },
      positions: [{ marketId: "dup", currentValue: 5 }],
      tradeAmount: 10,
      maxTotalExposure: 100,
      maxOpenMarkets: 5,
    });

    assert.strictEqual(risk.allowed, false);
    assert.ok(risk.reasons.some((reason) => reason.includes("already exists")));
  });

  await test("evaluateTradeRisk blocks over-exposure", async () => {
    const risk = evaluateTradeRisk({
      opportunity: { marketId: "new" },
      positions: [{ marketId: "a", currentValue: 95 }],
      tradeAmount: 10,
      maxTotalExposure: 100,
      maxOpenMarkets: 5,
    });

    assert.strictEqual(risk.allowed, false);
    assert.ok(risk.reasons.some((reason) => reason.includes("exceed cap")));
  });

  await test("evaluateTradeRisk allows trade that fits all limits", async () => {
    const risk = evaluateTradeRisk({
      opportunity: { marketId: "new" },
      positions: [{ marketId: "a", currentValue: 20 }],
      tradeAmount: 10,
      maxTotalExposure: 100,
      maxOpenMarkets: 5,
    });

    assert.strictEqual(risk.allowed, true);
  });

  console.log("\n[4] MCP tool safety");

  await test("toolIsMutating detects buy/sell style tool names", async () => {
    assert.strictEqual(toolIsMutating("buy_shares"), true);
    assert.strictEqual(toolIsMutating("sellPosition"), true);
    assert.strictEqual(toolIsMutating("get_balance"), false);
  });

  await test("filterTools blocks mutating tools by default", async () => {
    const { kept, blocked } = filterTools([
      { name: "get_balance" },
      { name: "buy_shares" },
    ]);

    assert.deepStrictEqual(kept.map((tool) => tool.name), ["get_balance"]);
    assert.deepStrictEqual(blocked.map((tool) => tool.name), ["buy_shares"]);
  });

  await test("filterTools honors allowlist and mutation override", async () => {
    const { kept } = filterTools(
      [
        { name: "get_balance" },
        { name: "buy_shares" },
        { name: "get_positions" },
      ],
      {
        allowMutatingTools: true,
        allowlist: ["buy_shares", "get_positions"],
      }
    );

    assert.deepStrictEqual(kept.map((tool) => tool.name), ["buy_shares", "get_positions"]);
  });

  console.log("\n[5] Auth selection");

  await test("resolveAuthMode prefers bearer tokens over api keys", async () => {
    const mode = resolveAuthMode({
      authMode: "auto",
      bearerToken: "token",
      apiKey: "key",
    });

    assert.strictEqual(mode, "bearer");
  });

  await test("resolveAuthMode supports agent session auth", async () => {
    const mode = resolveAuthMode({
      authMode: "auto",
      agentId: "agent-123",
      cronSecret: "secret",
    });

    assert.strictEqual(mode, "agentSession");
  });

  await test("BabylonClient constructor accepts explicit auth mode", async () => {
    const client = new BabylonClient({
      authMode: "apiKey",
      apiKey: "bab_live_example",
    });

    assert.strictEqual(client.authMode, "apiKey");
  });

  if (envFlag(process.env.RUN_LIVE_TESTS, false)) {
    console.log("\n[6] Live smoke test");

    await test("getPredictionMarkets returns an array", async () => {
      const client = new BabylonClient();
      const markets = await client.getPredictionMarkets({ limit: 3 });
      assert.ok(Array.isArray(markets), "Expected market list array");
      assert.ok(markets.length > 0, "Expected at least one market");
    });
  }

  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
