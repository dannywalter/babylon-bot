"use strict";

const { OpenAI } = require("openai");

const MODEL_DEFAULT = "nvidia/nemotron-3-super-120b-a12b:free";
const MAX_POST_CHARS = 280;
const MAX_COMMENT_CHARS = 400;

function envFlag(v, fallback = false) {
  if (v == null) return fallback;
  const n = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(n)) return true;
  if (["0", "false", "no", "off"].includes(n)) return false;
  return fallback;
}

function coerceMessageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        if (part && typeof part.content === "string") return part.content;
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string") return content.content;
  }
  return "";
}

function sanitizeText(text) {
  return String(text || "")
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
}

function debugLlmResponse(kind, resp) {
  if (!envFlag(process.env.DEBUG_LLM_REASONING, false)) return;
  const choice = resp?.choices?.[0] || {};
  const msg = choice?.message || {};
  const reasoningDetails = Array.isArray(msg?.reasoning_details) ? msg.reasoning_details : [];
  const details = {
    event: `llm-${kind}-debug`,
    model: resp?.model || null,
    finishReason: choice?.finish_reason ?? null,
    hasReasoningDetails: msg?.reasoning_details != null,
    reasoningDetailsCount: reasoningDetails.length,
    hasReasoning: msg?.reasoning != null,
    contentType: Array.isArray(msg?.content) ? "array" : typeof msg?.content,
    contentPreview: sanitizeText(coerceMessageText(msg?.content)).slice(0, 500),
  };
  console.log(JSON.stringify(details));
}

function buildReasoningContinuationMessages(systemPrompt, userPrompt, resp) {
  const msg = resp?.choices?.[0]?.message || {};
  const assistantContent = coerceMessageText(msg.content);
  const assistantMessage = {
    role: "assistant",
    content: assistantContent,
  };
  if (msg.reasoning_details != null) {
    assistantMessage.reasoning_details = msg.reasoning_details;
  }

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
    assistantMessage,
    {
      role: "user",
      content:
        "Continue from your prior reasoning and return only final JSON output now.",
    },
  ];
}

function getReasoningOptions() {
  if (!envFlag(process.env.LLM_ENABLE_REASONING, false)) return {};
  const max = Number(process.env.LLM_REASONING_MAX_TOKENS || 0);
  if (Number.isFinite(max) && max > 0) {
    return { reasoning: { enabled: true, max_tokens: Math.floor(max) } };
  }
  return { reasoning: { enabled: true } };
}

function readTokenBudget(name, fallback) {
  const v = Number(process.env[name] || fallback);
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.floor(v);
}

function extractTextFromResponse(resp, key) {
  const raw = sanitizeText(coerceMessageText(resp?.choices?.[0]?.message?.content));
  const parsed = extractJson(raw);
  return String(parsed?.[key] || raw).trim();
}

function getClient() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");
  const timeoutMsRaw = Number(process.env.LLM_HTTP_TIMEOUT_MS || 120000);
  const timeout = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? timeoutMsRaw : 120000;
  return new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    timeout,
    maxRetries: 1,
    defaultHeaders: {
      "HTTP-Referer": "https://github.com/dannywalter/babylon-bot",
      "X-Title": "babylon-bot",
    },
  });
}

function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {}
  const match = String(text || "").match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {}
  }
  return null;
}

function buildFeedSummary(feedSample) {
  const posts = (feedSample || [])
    .filter((p) => String(p.content || "").trim().length > 20)
    .slice(0, 6);
  if (posts.length === 0) return "Feed is quiet right now.";
  return posts
    .map((p, i) => `${i + 1}. "${String(p.content).slice(0, 120)}"`)
    .join("\n");
}

async function generatePostText(context, config = {}) {
  const {
    feedSample = [],
    balance,
    positionCount,
    reputationPoints,
    recentPostTexts = [],
  } = context;

  const model = config.llmModel || MODEL_DEFAULT;

  const recentBlock =
    recentPostTexts.length > 0
      ? `\nYour recent posts -- do not repeat these themes or phrasings:\n${recentPostTexts
          .map((t) => `- ${t}`)
          .join("\n")}`
      : "";

  const systemPrompt = [
    "You are wlt.vibe, a sharp and unsentimental prediction market participant posting on Babylon, a decentralised financial social network.",
    "Your posts are analytical, direct, and invite genuine market discussion.",
    "Rules: no hashtags, no emojis, no DYOR, no NFA, no 'alpha'.",
    "Never start with 'I' or 'Just'. Never open with 'Process update'.",
    "Always end with one open question to the feed.",
    "Write as someone who is actively in positions and thinking about timing, not an observer.",
    "Output valid JSON only with a single key 'post_text'.",
  ].join(" ");

  const userPrompt = [
    `Account context: balance $${balance ?? "unknown"}, ${positionCount ?? "?"} open positions, reputation ${reputationPoints ?? "?"} pts.`,
    `\nCurrent Babylon feed:\n${buildFeedSummary(feedSample)}`,
    recentBlock,
    `\nWrite one Babylon feed post. Max ${MAX_POST_CHARS} characters.`,
    "Make it grounded in the feed context above -- reference what people are actually talking about.",
    "End with a question a real market participant would want to answer.",
    '\nReturn JSON: {"post_text": "..."}',
  ].join("\n");

  const client = getClient();
  const reasoningOptions = getReasoningOptions();
  const postMaxTokens = readTokenBudget("LLM_MAX_POST_TOKENS", 1024);
  const postRetryMaxTokens = readTokenBudget("LLM_MAX_RETRY_POST_TOKENS", 768);
  let resp = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: postMaxTokens,
    temperature: 0.85,
    ...reasoningOptions,
  });

  debugLlmResponse("post", resp);
  let text = extractTextFromResponse(resp, "post_text");
  if (text.length < 20) {
    const retryMessages = buildReasoningContinuationMessages(systemPrompt, userPrompt, resp);
    resp = await client.chat.completions.create({
      model,
      messages: retryMessages,
      max_tokens: postRetryMaxTokens,
      temperature: 0.7,
      ...reasoningOptions,
    });
    debugLlmResponse("post-retry", resp);
    text = extractTextFromResponse(resp, "post_text");
  }
  if (text.length < 20) throw new Error(`LLM post text too short: "${text}"`);
  return text.slice(0, MAX_POST_CHARS);
}

async function generateCommentText(postContent, context, config = {}) {
  const { balance, positionCount } = context;
  const model = config.llmModel || MODEL_DEFAULT;

  const systemPrompt = [
    "You are wlt.vibe, a sharp prediction market participant commenting on Babylon.",
    "Your comments add specific analytical value -- insight, pushback, or a sharper framing.",
    "Never start with 'Great post', 'Interesting', 'Exactly', or 'Fair point'.",
    "No hashtags, no emojis. Be direct. End with one genuine follow-up question.",
    "Write as someone with skin in the game, not a spectator.",
    "Output valid JSON only with a single key 'comment_text'.",
  ].join(" ");

  const userPrompt = [
    `You are commenting on this Babylon post:\n"${postContent}"`,
    `\nYour context: balance $${balance ?? "unknown"}, ${positionCount ?? "?"} open positions.`,
    `Write one comment: 60-${MAX_COMMENT_CHARS} characters, specific market insight or pushback, ends with a question.`,
    '\nReturn JSON: {"comment_text": "..."}',
  ].join("\n");

  const client = getClient();
  const reasoningOptions = getReasoningOptions();
  const commentMaxTokens = readTokenBudget("LLM_MAX_COMMENT_TOKENS", 768);
  const commentRetryMaxTokens = readTokenBudget("LLM_MAX_RETRY_COMMENT_TOKENS", 512);
  let resp = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: commentMaxTokens,
    temperature: 0.8,
    ...reasoningOptions,
  });

  debugLlmResponse("comment", resp);
  let text = extractTextFromResponse(resp, "comment_text");
  if (text.length < 30) {
    const retryMessages = buildReasoningContinuationMessages(systemPrompt, userPrompt, resp);
    resp = await client.chat.completions.create({
      model,
      messages: retryMessages,
      max_tokens: commentRetryMaxTokens,
      temperature: 0.7,
      ...reasoningOptions,
    });
    debugLlmResponse("comment-retry", resp);
    text = extractTextFromResponse(resp, "comment_text");
  }
  if (text.length < 30)
    throw new Error(`LLM comment text too short: "${text}"`);
  return text.slice(0, MAX_COMMENT_CHARS);
}

module.exports = { generatePostText, generateCommentText };
