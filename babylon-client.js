require("dotenv").config();

const { parseNumber } = require("./trading-core");

class BabylonError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "BabylonError";
    this.details = details;
  }
}

function resolveAuthMode(config = {}) {
  if (config.authMode && config.authMode !== "auto") {
    return config.authMode;
  }

  if (config.bearerToken) {
    return "bearer";
  }

  if (config.sessionToken) {
    return "sessionToken";
  }

  if (config.agentId && (config.cronSecret || config.agentSecret)) {
    return "agentSession";
  }

  if (config.apiKey) {
    return "apiKey";
  }

  throw new BabylonError(
    "No Babylon credentials found. Set BABYLON_API_KEY, BABYLON_SESSION_TOKEN, BABYLON_BEARER_TOKEN, or agent auth env vars."
  );
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return safeJsonParse(text);
  }

  return text;
}

function extractMcpPayload(payload) {
  if (!payload) {
    return null;
  }

  if (payload.error) {
    throw new BabylonError(payload.error.message || "Babylon MCP request failed.", {
      code: payload.error.code,
      data: payload.error.data,
    });
  }

  const textContent = payload?.result?.content?.find((item) => item.type === "text")?.text;
  if (textContent) {
    return safeJsonParse(textContent);
  }

  if (payload.result?.tools) {
    return payload.result.tools;
  }

  if (payload.result) {
    return payload.result;
  }

  if (payload.tools) {
    return payload.tools;
  }

  return payload;
}

class BabylonClient {
  constructor(config = {}) {
    this.baseUrl = (config.baseUrl || process.env.BABYLON_BASE_URL || "https://babylon.market").replace(/\/$/, "");
    this.mcpUrl = config.mcpUrl || process.env.BABYLON_MCP_URL || `${this.baseUrl}/mcp`;
    this.apiBase = config.apiBase || `${this.baseUrl}/api`;
    this.apiKey = config.apiKey || process.env.BABYLON_API_KEY;
    this.sessionToken = config.sessionToken || process.env.BABYLON_SESSION_TOKEN;
    this.bearerToken = config.bearerToken || process.env.BABYLON_BEARER_TOKEN;
    this.agentId = config.agentId || process.env.BABYLON_AGENT_ID;
    this.cronSecret =
      config.cronSecret || process.env.BABYLON_CRON_SECRET || process.env.CRON_SECRET;
    this.agentSecret = config.agentSecret || process.env.BABYLON_AGENT_SECRET;
    this.authMode = resolveAuthMode({
      authMode: config.authMode || process.env.BABYLON_AUTH_MODE || "auto",
      apiKey: this.apiKey,
      sessionToken: this.sessionToken,
      bearerToken: this.bearerToken,
      agentId: this.agentId,
      cronSecret: this.cronSecret,
      agentSecret: this.agentSecret,
    });
    this.cachedAgentSessionToken = null;
    this.cachedAgentSessionExpiry = 0;
  }

  async getAccessToken(forceRefresh = false) {
    if (this.authMode === "apiKey") {
      return null;
    }

    if (this.authMode === "bearer") {
      return this.bearerToken;
    }

    if (this.authMode === "sessionToken") {
      return this.sessionToken;
    }

    if (this.authMode !== "agentSession") {
      throw new BabylonError(`Unsupported Babylon auth mode: ${this.authMode}`);
    }

    const now = Date.now();
    if (!forceRefresh && this.cachedAgentSessionToken && now < this.cachedAgentSessionExpiry - 30_000) {
      return this.cachedAgentSessionToken;
    }

    const response = await fetch(`${this.apiBase}/agents/auth`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agentId: this.agentId,
        ...(this.cronSecret ? { cronSecret: this.cronSecret } : {}),
        ...(this.agentSecret ? { agentSecret: this.agentSecret } : {}),
      }),
    });

    const payload = await parseResponse(response);
    if (!response.ok) {
      throw new BabylonError(`Babylon agent auth failed with status ${response.status}.`, {
        payload,
      });
    }

    const token =
      payload?.token ||
      payload?.sessionToken ||
      payload?.accessToken ||
      payload?.jwt ||
      payload?.data?.token;

    if (!token) {
      throw new BabylonError("Babylon agent auth response did not include a token.", { payload });
    }

    const expiresInSeconds = parseNumber(
      payload?.expiresIn || payload?.expiresInSeconds || payload?.ttl,
      15 * 60
    );

    this.cachedAgentSessionToken = token;
    this.cachedAgentSessionExpiry = Date.now() + expiresInSeconds * 1000;
    return token;
  }

  async buildAuthHeaders({ includeJson = true } = {}) {
    const headers = includeJson ? { "Content-Type": "application/json" } : {};

    if (this.authMode === "apiKey") {
      return {
        ...headers,
        "X-Babylon-Api-Key": this.apiKey,
      };
    }

    const token = await this.getAccessToken();
    return {
      ...headers,
      Authorization: `Bearer ${token}`,
    };
  }

  async request(path, options = {}) {
    const response = await fetch(`${this.apiBase}${path}`, {
      method: options.method || "GET",
      headers: {
        ...(await this.buildAuthHeaders({ includeJson: options.body !== undefined })),
        ...(options.headers || {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const payload = await parseResponse(response);
    if (!response.ok) {
      throw new BabylonError(`Babylon API request failed with status ${response.status}.`, {
        path,
        payload,
      });
    }

    return payload;
  }

  async listTools() {
    const response = await fetch(this.mcpUrl, {
      method: "POST",
      headers: await this.buildAuthHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/list",
        id: Date.now(),
      }),
    });

    const payload = await parseResponse(response);
    if (!response.ok) {
      throw new BabylonError(`Babylon MCP tools/list failed with status ${response.status}.`, {
        payload,
      });
    }

    const tools = extractMcpPayload(payload);
    return Array.isArray(tools) ? tools : tools?.tools || [];
  }

  async callTool(name, args = {}) {
    const response = await fetch(this.mcpUrl, {
      method: "POST",
      headers: await this.buildAuthHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name,
          arguments: args,
        },
        id: Date.now(),
      }),
    });

    const payload = await parseResponse(response);
    if (!response.ok) {
      throw new BabylonError(`Babylon MCP tools/call failed with status ${response.status}.`, {
        name,
        payload,
      });
    }

    return extractMcpPayload(payload);
  }

  async getPredictionMarkets({ status = "ACTIVE", limit = 20 } = {}) {
    const payload = await this.request(
      `/markets/predictions?status=${encodeURIComponent(status)}&limit=${encodeURIComponent(limit)}`
    );

    if (Array.isArray(payload)) {
      return payload;
    }

    return payload?.questions || payload?.markets || payload?.data || [];
  }

  async getPositions() {
    try {
      const payload = await this.request("/markets/positions");
      if (Array.isArray(payload)) {
        return payload;
      }

      return payload?.positions || payload?.data || payload?.questions || [];
    } catch (error) {
      if (!(error instanceof BabylonError)) {
        throw error;
      }

      if (this.authMode === "apiKey") {
        const payload = await this.callTool("get_positions", {});
        return Array.isArray(payload) ? payload : payload?.positions || payload?.data || [];
      }

      throw error;
    }
  }

  async getBalance() {
    if (this.authMode === "apiKey") {
      try {
        const payload = await this.callTool("get_balance", {});
        return (
          payload?.balance ||
          payload?.availableBalance ||
          payload?.cash ||
          payload?.data?.balance ||
          payload ||
          null
        );
      } catch {
        return null;
      }
    }

    try {
      const payload = await this.request("/users/me");
      return (
        payload?.balance ||
        payload?.availableBalance ||
        payload?.walletBalance ||
        payload?.cash ||
        payload?.data?.balance ||
        null
      );
    } catch {
      return null;
    }
  }

  async buyPredictionShares(marketId, side, amount) {
    const normalizedSide = String(side).toUpperCase();
    const candidatePayloads = [
      { outcome: normalizedSide, amount },
      { side: normalizedSide, amount },
      { outcome: normalizedSide, side: normalizedSide, amount },
    ];

    for (const payload of candidatePayloads) {
      try {
        return await this.request(`/markets/predictions/${marketId}/buy`, {
          method: "POST",
          body: payload,
        });
      } catch (error) {
        if (!(error instanceof BabylonError)) {
          throw error;
        }
      }
    }

    if (this.authMode === "apiKey") {
      return this.callTool("buy_shares", { marketId, side: normalizedSide, amount });
    }

    throw new BabylonError(`Unable to buy shares for market ${marketId}.`);
  }
}

module.exports = {
  BabylonClient,
  BabylonError,
  resolveAuthMode,
};
