"use strict";

const { OpenAI } = require("openai");

const MODEL_DEFAULT = "nvidia/nemotron-3-super-120b-a12b:free";
const MAX_POST_CHARS = 280;
const MAX_COMMENT_CHARS = 400;

function getClient() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");
  return new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
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
  const resp = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 350,
    temperature: 0.85,
    reasoning: { enabled: true },
  });

  const raw = resp.choices[0]?.message?.content || "";
  const parsed = extractJson(raw);
  const text = String(parsed?.post_text || "").trim();
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
  const resp = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 250,
    temperature: 0.8,
    reasoning: { enabled: true },
  });

  const raw = resp.choices[0]?.message?.content || "";
  const parsed = extractJson(raw);
  const text = String(parsed?.comment_text || "").trim();
  if (text.length < 30)
    throw new Error(`LLM comment text too short: "${text}"`);
  return text.slice(0, MAX_COMMENT_CHARS);
}

module.exports = { generatePostText, generateCommentText };
