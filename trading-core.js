const MUTATING_TOOL_PATTERN =
  /(^|_)(place|buy|sell|close|open|create|delete|update|set|follow|unfollow|accept|decline|leave|claim|deposit|withdraw|transfer)(_|$)/i;

function envFlag(value, defaultValue = false) {
  if (value == null || value === "") {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseCsv(value) {
  if (!value) {
    return [];
  }

  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeProbability(market) {
  const candidates = [
    market?.yesProbability,
    market?.yes_probability,
    market?.probability,
    market?.probabilityYes,
    market?.prob_yes,
    market?.odds?.yes,
  ];

  for (const candidate of candidates) {
    if (candidate == null || candidate === "") {
      continue;
    }

    const value = Number(candidate);
    if (Number.isFinite(value) && value >= 0 && value <= 1) {
      return value;
    }
  }

  return null;
}

function getMarketLabel(market) {
  return (
    market?.text ||
    market?.question ||
    market?.title ||
    market?.name ||
    market?.symbol ||
    market?.id ||
    "unknown-market"
  );
}

function getMarketId(market) {
  return market?.id || market?.marketId || market?.market_id || market?.symbol || getMarketLabel(market);
}

function getMarketVolume(market) {
  const candidates = [
    market?.volume,
    market?.volume24h,
    market?.liquidity,
    market?.totalVolume,
    market?.volumeUsd,
  ];

  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value >= 0) {
      return value;
    }
  }

  return 0;
}

function isResolvedMarket(market) {
  if (market?.resolved === true) {
    return true;
  }

  const status = String(market?.status || "").toUpperCase();
  return ["RESOLVED", "CLOSED", "SETTLED", "FINALIZED"].includes(status);
}

function findOpportunities(markets, options = {}) {
  const minEdge = parseNumber(options.minEdge, 0.15);
  const maxMarkets = parseNumber(options.maxMarkets, 5);
  const minVolume = parseNumber(options.minVolume, 0);
  const allowlist = new Set((options.allowlist || []).map((item) => String(item).toLowerCase()));

  return (markets || [])
    .filter((market) => !isResolvedMarket(market))
    .map((market) => {
      const probability = normalizeProbability(market);
      if (probability == null) {
        return null;
      }

      const marketId = getMarketId(market);
      const label = getMarketLabel(market);
      const volume = getMarketVolume(market);

      if (allowlist.size > 0) {
        const candidates = [marketId, label, market?.symbol]
          .filter(Boolean)
          .map((value) => String(value).toLowerCase());
        const allowed = candidates.some((value) => allowlist.has(value));
        if (!allowed) {
          return null;
        }
      }

      if (volume < minVolume) {
        return null;
      }

      const edge = Math.abs(0.5 - probability);
      if (edge < minEdge) {
        return null;
      }

      return {
        marketId,
        label,
        probability,
        edge,
        volume,
        side: probability < 0.5 ? "YES" : "NO",
        market,
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.edge - left.edge)
    .slice(0, maxMarkets);
}

function getPositionMarketId(position) {
  return (
    position?.marketId ||
    position?.market_id ||
    position?.questionId ||
    position?.id ||
    position?.symbol
  );
}

function getPositionExposure(position) {
  const candidates = [
    position?.currentValue,
    position?.costBasis,
    position?.notional,
    position?.sizeUsd,
    position?.amount,
    position?.size,
  ];

  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }

  const shares = Number(position?.shares);
  const avgPrice = Number(position?.avgPrice);
  if (Number.isFinite(shares) && shares > 0 && Number.isFinite(avgPrice) && avgPrice > 0) {
    return shares * avgPrice;
  }

  return 0;
}

function summarizeExposure(positions) {
  const uniqueMarketIds = new Set();
  let totalExposure = 0;

  for (const position of positions || []) {
    const marketId = getPositionMarketId(position);
    if (marketId) {
      uniqueMarketIds.add(String(marketId));
    }
    totalExposure += getPositionExposure(position);
  }

  return {
    totalExposure,
    openMarkets: uniqueMarketIds.size,
  };
}

function evaluateTradeRisk({ opportunity, positions = [], tradeAmount, maxTotalExposure, maxOpenMarkets, onePositionPerMarket = true }) {
  const reasons = [];
  const { totalExposure, openMarkets } = summarizeExposure(positions);
  const amount = parseNumber(tradeAmount, 0);
  const cap = parseNumber(maxTotalExposure, Number.POSITIVE_INFINITY);
  const maxMarkets = parseNumber(maxOpenMarkets, Number.POSITIVE_INFINITY);
  const targetMarketId = String(opportunity?.marketId || "");
  const hasExistingPosition = (positions || []).some((position) => String(getPositionMarketId(position) || "") === targetMarketId);

  if (!(amount > 0)) {
    reasons.push("TRADE_AMOUNT must be positive.");
  }

  if (onePositionPerMarket && hasExistingPosition) {
    reasons.push(`Position already exists for market ${targetMarketId}.`);
  }

  if (totalExposure + amount > cap) {
    reasons.push(`Total exposure ${totalExposure + amount} would exceed cap ${cap}.`);
  }

  if (!hasExistingPosition && openMarkets + 1 > maxMarkets) {
    reasons.push(`Open market count ${openMarkets + 1} would exceed cap ${maxMarkets}.`);
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    totalExposure,
    openMarkets,
    hasExistingPosition,
  };
}

function toolIsMutating(name) {
  const normalized = String(name || "")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
  return MUTATING_TOOL_PATTERN.test(normalized);
}

function filterTools(tools, options = {}) {
  const allowMutatingTools = options.allowMutatingTools === true;
  const allowlist = new Set((options.allowlist || []).map((entry) => String(entry)));
  const blocklist = new Set((options.blocklist || []).map((entry) => String(entry)));
  const kept = [];
  const blocked = [];

  for (const tool of tools || []) {
    const name = String(tool?.name || "");
    const blockedByList = blocklist.has(name);
    const notAllowedByAllowlist = allowlist.size > 0 && !allowlist.has(name);
    const mutating = toolIsMutating(name);
    const blockedForMutation = mutating && !allowMutatingTools;

    if (blockedByList || notAllowedByAllowlist || blockedForMutation) {
      blocked.push(tool);
      continue;
    }

    kept.push(tool);
  }

  return { kept, blocked };
}

module.exports = {
  envFlag,
  evaluateTradeRisk,
  filterTools,
  findOpportunities,
  getMarketId,
  getMarketLabel,
  getPositionExposure,
  getPositionMarketId,
  normalizeProbability,
  parseCsv,
  parseNumber,
  summarizeExposure,
  toolIsMutating,
};
