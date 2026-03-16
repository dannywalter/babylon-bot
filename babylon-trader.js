require("dotenv").config();

const { BabylonClient } = require("./babylon-client");
const {
  envFlag,
  evaluateTradeRisk,
  findOpportunities,
  parseCsv,
  parseNumber,
} = require("./trading-core");

function resolveExecutionMode() {
  if (process.env.EXECUTION_MODE) {
    return process.env.EXECUTION_MODE;
  }

  if (process.env.DRY_RUN != null) {
    return envFlag(process.env.DRY_RUN, true) ? "dry-run" : "live";
  }

  return "dry-run";
}

function loadConfig() {
  return {
    authMode: process.env.BABYLON_AUTH_MODE || "auto",
    executionMode: resolveExecutionMode(),
    pollIntervalMs: parseNumber(process.env.POLL_INTERVAL_MS, 60_000),
    runOnce: envFlag(process.env.RUN_ONCE, true),
    limit: parseNumber(process.env.MARKET_LIMIT, 50),
    tradeAmount: parseNumber(process.env.TRADE_AMOUNT, 10),
    minEdge: parseNumber(process.env.MIN_EDGE, 0.15),
    minVolume: parseNumber(process.env.MIN_VOLUME, 0),
    maxMarkets: parseNumber(process.env.MAX_MARKETS, 5),
    maxOpenMarkets: parseNumber(process.env.MAX_OPEN_MARKETS, 5),
    maxTotalExposure: parseNumber(process.env.MAX_TOTAL_EXPOSURE, 100),
    allowlist: parseCsv(process.env.MARKET_ALLOWLIST),
    onePositionPerMarket: envFlag(process.env.ONE_POSITION_PER_MARKET, true),
  };
}

function sanitizeConfig(config) {
  return {
    ...config,
    authMode: config.authMode,
  };
}

async function runOnce(client, config) {
  const [marketsResult, positionsResult, balanceResult] = await Promise.allSettled([
    client.getPredictionMarkets({ limit: config.limit }),
    client.getPositions(),
    client.getBalance(),
  ]);

  if (marketsResult.status !== "fulfilled") {
    throw marketsResult.reason;
  }

  const markets = marketsResult.value;
  const positions = positionsResult.status === "fulfilled" ? positionsResult.value : [];
  const balance = balanceResult.status === "fulfilled" ? balanceResult.value : null;

  const opportunities = findOpportunities(markets, {
    minEdge: config.minEdge,
    maxMarkets: config.maxMarkets,
    minVolume: config.minVolume,
    allowlist: config.allowlist,
  });

  if (opportunities.length === 0) {
    const result = {
      event: "no-opportunity",
      marketCount: markets.length,
      positionCount: positions.length,
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  for (const opportunity of opportunities) {
    const risk = evaluateTradeRisk({
      opportunity,
      positions,
      tradeAmount: config.tradeAmount,
      maxTotalExposure: config.maxTotalExposure,
      maxOpenMarkets: config.maxOpenMarkets,
      onePositionPerMarket: config.onePositionPerMarket,
    });

    const candidate = {
      event: "trade-candidate",
      executionMode: config.executionMode,
      opportunity: {
        marketId: opportunity.marketId,
        label: opportunity.label,
        side: opportunity.side,
        probability: opportunity.probability,
        edge: opportunity.edge,
        volume: opportunity.volume,
      },
      risk,
      balance,
    };

    if (!risk.allowed) {
      console.log(JSON.stringify(candidate, null, 2));
      continue;
    }

    if (config.executionMode !== "live") {
      console.log(
        JSON.stringify(
          {
            ...candidate,
            event: "dry-run-trade-plan",
            tradeAmount: config.tradeAmount,
          },
          null,
          2
        )
      );
      return candidate;
    }

    const execution = await client.buyPredictionShares(
      opportunity.marketId,
      opportunity.side,
      config.tradeAmount
    );

    const result = {
      ...candidate,
      event: "live-trade-executed",
      tradeAmount: config.tradeAmount,
      execution,
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  const result = {
    event: "no-trade-passed-risk",
    attemptedCandidates: opportunities.length,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function main() {
  const config = loadConfig();
  const client = new BabylonClient({ authMode: config.authMode });

  console.log(
    JSON.stringify(
      {
        event: "startup",
        config: sanitizeConfig(config),
      },
      null,
      2
    )
  );

  if (config.runOnce) {
    await runOnce(client, config);
    return;
  }

  while (true) {
    try {
      await runOnce(client, config);
    } catch (error) {
      console.error(error.message);
    }

    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  loadConfig,
  runOnce,
};
