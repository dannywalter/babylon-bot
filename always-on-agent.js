require("dotenv").config();

const fs = require("fs");
const path = require("path");

const { BabylonClient } = require("./babylon-client");
const { envFlag, filterTools, parseCsv, parseNumber } = require("./trading-core");

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asArray(value, key) {
  if (Array.isArray(value)) {
    return value;
  }

  if (Array.isArray(value?.[key])) {
    return value[key];
  }

  if (Array.isArray(value?.data)) {
    return value.data;
  }

  return [];
}

function readState(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return {};
  }
}

function writeState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function loadConfig() {
  return {
    authMode: process.env.BABYLON_AUTH_MODE || "auto",
    runOnce: envFlag(process.env.RUN_ONCE, false),
    pollIntervalMs: parseNumber(process.env.POLL_INTERVAL_MS, 30_000),
    stateFile: process.env.ALWAYS_ON_STATE_FILE || ".always-on-agent-state.json",

    allowMutatingTools: envFlag(process.env.ALLOW_MUTATING_TOOLS, false),
    allowlist: parseCsv(process.env.BABYLON_ALLOWED_TOOLS),
    blocklist: parseCsv(process.env.BABYLON_BLOCKED_TOOLS),

    enableReputationTask: envFlag(process.env.ENABLE_REPUTATION_TASK, true),
    reputationEveryMs: parseNumber(process.env.REPUTATION_EVERY_MS, 5 * 60_000),

    enableAccountTask: envFlag(process.env.ENABLE_ACCOUNT_TASK, true),
    accountEveryMs: parseNumber(process.env.ACCOUNT_EVERY_MS, 5 * 60_000),

    enableCommentTask: envFlag(process.env.ENABLE_COMMENT_TASK, false),
    commentEveryMs: parseNumber(process.env.COMMENT_EVERY_MS, 15 * 60_000),
    commentFeedLimit: parseNumber(process.env.COMMENT_FEED_LIMIT, 20),
    commentLookaheadMinutes: parseNumber(process.env.COMMENT_LOOKAHEAD_MINUTES, 60),
    commentMinChars: parseNumber(process.env.COMMENT_MIN_CHARS, 32),
    requireMarketSignalForComment: envFlag(process.env.REQUIRE_MARKET_SIGNAL_FOR_COMMENT, true),
    maxCommentMemory: parseNumber(process.env.MAX_COMMENT_MEMORY, 100),

    enablePostTask: envFlag(process.env.ENABLE_POST_TASK, false),
    postEveryMs: parseNumber(process.env.POST_EVERY_MS, 60 * 60_000),
    postText: process.env.ALWAYS_ON_POST_TEXT || "",
    maxCreatedPostMemory: parseNumber(process.env.MAX_CREATED_POST_MEMORY, 20),

    enableEngageTask: envFlag(process.env.ENABLE_ENGAGE_TASK, false),
    engageEveryMs: parseNumber(process.env.ENGAGE_EVERY_MS, 5 * 60_000),
    enableReplyTask: envFlag(process.env.ENABLE_REPLY_TASK, false),
    allowFlatReplies: envFlag(process.env.ALLOW_FLAT_REPLIES, false),
    maxEngageMemory: parseNumber(process.env.MAX_ENGAGE_MEMORY, 500),
  };
}

function resolveToolName(availableToolNames, candidates) {
  for (const candidate of candidates) {
    if (availableToolNames.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

function getToolByName(tools, name) {
  for (const tool of tools || []) {
    if (String(tool?.name || "") === name) {
      return tool;
    }
  }
  return null;
}

function supportsThreadedReplies(createCommentTool) {
  const properties = createCommentTool?.inputSchema?.properties || {};
  const keys = Object.keys(properties).map((key) => key.toLowerCase());
  return keys.includes("parentcommentid") || keys.includes("commentid") || keys.includes("replytocommentid");
}

function topWords(text, maxWords = 2) {
  const stop = new Set([
    "the",
    "and",
    "for",
    "that",
    "with",
    "this",
    "from",
    "have",
    "will",
    "your",
    "what",
    "when",
    "where",
    "just",
    "been",
    "were",
    "market",
    "markets",
    "price",
    "prices",
  ]);

  const counts = new Map();
  const words = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 4 && !stop.has(word));

  for (const word of words) {
    counts.set(word, (counts.get(word) || 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, maxWords)
    .map(([word]) => word);
}

function capitalize(str) {
  const s = String(str || "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function normalizedText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function hasMarketSignal(text) {
  const content = normalizedText(text).toLowerCase();
  if (!content) {
    return false;
  }

  const marketKeywords = [
    "market",
    "markets",
    "position",
    "positions",
    "long",
    "short",
    "ticker",
    "tickers",
    "entry",
    "exit",
    "risk",
    "edge",
    "price",
    "probability",
    "volatility",
    "trade",
    "trading",
  ];

  if (marketKeywords.some((keyword) => content.includes(keyword))) {
    return true;
  }

  // Babylon-style ticker symbols like TSLAI, OPENAGI, AIPHB
  return /\b[A-Z]{4,12}\b/.test(String(text || ""));
}

function isGreetingLike(text) {
  const content = normalizedText(text).toLowerCase();
  if (!content) {
    return true;
  }

  const greetingPatterns = [
    /^(hey|hi|hello)\b/,
    /\bhey team\b/,
    /\bhello everyone\b/,
    /\bready to dive\b/,
    /\bwhat'?s on everyone'?s mind\b/,
    /\bwho'?s with me\b/,
  ];

  return greetingPatterns.some((pattern) => pattern.test(content));
}

function inferTopicLabel(text) {
  const upperTickers = String(text || "").match(/\b[A-Z]{4,12}\b/g) || [];
  if (upperTickers.length > 0) {
    return upperTickers.slice(0, 2).join(" / ");
  }

  const keywords = topWords(text, 2).filter((word) => !["team", "everyone", "hello", "ready"].includes(word));
  return keywords.length > 0 ? keywords.join(" / ") : "the setup";
}

function shouldCommentOnPost(post, config) {
  const content = normalizedText(post?.content);
  if (content.length < config.commentMinChars) {
    return { ok: false, reason: "too-short" };
  }

  if (isGreetingLike(content)) {
    return { ok: false, reason: "greeting-like" };
  }

  if (config.requireMarketSignalForComment && !hasMarketSignal(content)) {
    return { ok: false, reason: "no-market-signal" };
  }

  return { ok: true };
}

function makeComment(postContent, lookaheadMinutes) {
  const topicLabel = inferTopicLabel(postContent);
  const variants = [
    `Good read on ${topicLabel}. I am watching confirmation and position crowding over the next ${lookaheadMinutes}m before sizing up. What signal would change your bias?`,
    `Useful framing on ${topicLabel}. Direction matters less than entry timing when consensus gets crowded. Are you waiting for confirmation or scaling in early?`,
    `I like the focus on ${topicLabel}. My current lens is risk-adjusted sizing first, conviction second, until confirmation improves. What is your invalidation level?`,
    `Solid market take on ${topicLabel}. I am tracking whether momentum holds or stalls into the next window. Are you leaning trend continuation or fade?`,
    `${capitalize(topicLabel)} is a good thread to watch. Edge here likely comes from execution quality rather than headline speed. Which timeframe are you trading this on?`,
  ];
  return variants[Math.floor(Math.random() * variants.length)];
}

function makePostText(config) {
  if (config.postText) {
    return config.postText;
  }

  const variants = [
    "Process update: continuously scanning account state and feed dislocations. Current focus is timing risk and confirmation quality over headline chasing. Which market are you watching most closely right now?",
    "Oversized consensus becomes its own edge on the reversion side — the unwind tends to be faster than the buildup. Most of the feed is long the same names. Where are you finding differentiated setups right now?",
    "Risk sizing is the underrated variable. Direction gets the attention but entry size and re-entry discipline usually matter more. How are you managing exposure when you have a live position you are uncertain about?",
    "The more clearly a setup is telegraphed across the feed, the more the payout tends to already reflect that. Where are you finding genuine uncertainty that has not been fully priced yet?",
    "Flow in the feed is elevated but actual position changes look muted — that hesitation before a confirmed move is often where the real edge lives. Are you positioned ahead of your conviction or still waiting for confirmation?",
    "Patience in a ranging market compounds differently than in a trending one. One rewards waiting, the other punishes it. Which regime are you treating your top market as right now?",
  ];
  return variants[Math.floor(Math.random() * variants.length)];
}

function makeReply(commentContent) {
  const topics = topWords(commentContent, 1);
  const topicTag = topics.length > 0 ? ` on ${topics[0]}` : "";
  const variants = [
    `Fair point${topicTag}. The confirmation signal is what I keep coming back to — without it, sizing up feels like paying for optionality before the edge is clear. What is your read on timing here?`,
    `Appreciate the engagement. Worth watching whether the move resolves before the crowd gets too positioned — direction is secondary to entry tempo at this point. How are you framing your next position?`,
    `That is the right thread to pull on. Watching whether entry-level consensus holds or starts fragmenting — that fragmentation is usually the tell before a real move. Where are you sizing in?`,
    `Honest answer: conviction on direction but uncertainty on timing — and those two being mismatched is usually where a trade leaks value. How are you structuring your entry around that tension?`,
    `Exactly the tension worth naming${topicTag}. Being early in a correct position costs the same as being wrong in a bad one if you size before confirmation. What does a risk-adjusted entry look like for you here?`,
  ];
  return variants[Math.floor(Math.random() * variants.length)];
}

function updateAttempt(state, jobName) {
  state.lastAttemptAt = state.lastAttemptAt || {};
  state.lastAttemptAt[jobName] = Date.now();
}

function updateSuccess(state, jobName) {
  state.lastSuccessAt = state.lastSuccessAt || {};
  state.lastSuccessAt[jobName] = Date.now();
}

function isDue(state, jobName, everyMs) {
  const lastAttempt = Number(state?.lastAttemptAt?.[jobName] || 0);
  return Date.now() - lastAttempt >= everyMs;
}

async function callIfPresent(client, toolName, args = {}) {
  if (!toolName) {
    return null;
  }
  return client.callTool(toolName, args);
}

function normalizePost(post) {
  const id = String(post?.id || post?.postId || "").trim();
  const content = String(post?.content || "").trim();
  if (!id || !content) {
    return null;
  }
  return {
    id,
    content,
  };
}

async function runJob(jobName, fn, state) {
  try {
    const result = await fn();
    updateSuccess(state, jobName);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          event: "job-error",
          job: jobName,
          timestamp: nowIso(),
          message: error?.message || String(error),
        },
        null,
        2
      )
    );
  } finally {
    updateAttempt(state, jobName);
  }
}

async function main() {
  const config = loadConfig();
  const client = new BabylonClient({ authMode: config.authMode });
  const statePath = path.resolve(process.cwd(), config.stateFile);
  const state = readState(statePath);

  const listedTools = await client.listTools();
  const { kept, blocked } = filterTools(listedTools, {
    allowMutatingTools: config.allowMutatingTools,
    allowlist: config.allowlist,
    blocklist: config.blocklist,
  });

  const availableToolNames = new Set(kept.map((tool) => String(tool?.name || "").trim()));

  const tools = {
    getReputation: resolveToolName(availableToolNames, ["get_reputation"]),
    getBalance: resolveToolName(availableToolNames, ["get_balance"]),
    getPositions: resolveToolName(availableToolNames, ["get_positions"]),
    queryFeed: resolveToolName(availableToolNames, ["query_feed"]),
    createComment: resolveToolName(availableToolNames, ["create_comment"]),
    createPost: resolveToolName(availableToolNames, ["create_post"]),
    getComments: resolveToolName(availableToolNames, ["get_comments"]),
    likeComment: resolveToolName(availableToolNames, ["like_comment"]),
  };
  const createCommentTool = getToolByName(kept, "create_comment");
  const canThreadReplies = supportsThreadedReplies(createCommentTool);

  console.log(
    JSON.stringify(
      {
        event: "always-on-startup",
        timestamp: nowIso(),
        config: {
          ...config,
          stateFile: config.stateFile,
        },
        capabilities: {
          canThreadReplies,
        },
        toolCount: kept.length,
        blockedTools: blocked.map((tool) => tool.name),
      },
      null,
      2
    )
  );

  const jobs = [
    {
      name: "reputation",
      enabled: config.enableReputationTask,
      everyMs: config.reputationEveryMs,
      run: async () => {
        if (!tools.getReputation) {
          return { event: "reputation-skipped", reason: "tool-unavailable" };
        }

        const rep = await callIfPresent(client, tools.getReputation, {});
        return {
          event: "reputation",
          timestamp: nowIso(),
          reputationPoints: rep?.reputationPoints ?? null,
          trustLevel: rep?.trustLevel ?? null,
          rank: rep?.rank ?? null,
          totalUsers: rep?.totalUsers ?? null,
        };
      },
    },
    {
      name: "account",
      enabled: config.enableAccountTask,
      everyMs: config.accountEveryMs,
      run: async () => {
        const balance = await callIfPresent(client, tools.getBalance, {});
        const positions = await callIfPresent(client, tools.getPositions, {});
        return {
          event: "account",
          timestamp: nowIso(),
          balance:
            balance?.balance ?? balance?.availableBalance ?? balance?.cash ?? balance ?? null,
          positionCount: asArray(positions, "positions").length,
        };
      },
    },
    {
      name: "comment",
      enabled: config.enableCommentTask && config.allowMutatingTools,
      everyMs: config.commentEveryMs,
      run: async () => {
        if (!tools.queryFeed) {
          return { event: "comment-skipped", reason: "query_feed-unavailable" };
        }
        if (!tools.createComment) {
          return { event: "comment-skipped", reason: "create_comment-unavailable" };
        }

        const feed = await client.callTool(tools.queryFeed, { limit: config.commentFeedLimit });
        const posts = asArray(feed, "posts").map(normalizePost).filter(Boolean);
        const previouslyCommented = new Set(state.commentedPostIds || []);

        const skippedReasons = {
          alreadyCommented: 0,
          tooShort: 0,
          greetingLike: 0,
          noMarketSignal: 0,
        };

        const candidate = posts.find((post) => {
          if (previouslyCommented.has(post.id)) {
            skippedReasons.alreadyCommented += 1;
            return false;
          }

          const verdict = shouldCommentOnPost(post, config);
          if (!verdict.ok) {
            if (verdict.reason === "too-short") skippedReasons.tooShort += 1;
            if (verdict.reason === "greeting-like") skippedReasons.greetingLike += 1;
            if (verdict.reason === "no-market-signal") skippedReasons.noMarketSignal += 1;
            return false;
          }

          return true;
        });

        if (!candidate) {
          return {
            event: "comment-skipped",
            reason: "no-suitable-post",
            skippedReasons,
          };
        }

        const content = makeComment(candidate.content, config.commentLookaheadMinutes);
        const created = await client.callTool(tools.createComment, {
          postId: candidate.id,
          content,
        });

        state.commentedPostIds = [candidate.id, ...(state.commentedPostIds || [])].slice(
          0,
          config.maxCommentMemory
        );

        return {
          event: "comment-created",
          timestamp: nowIso(),
          postId: candidate.id,
          commentId: created?.commentId ?? null,
        };
      },
    },
    {
      name: "post",
      enabled: config.enablePostTask && config.allowMutatingTools,
      everyMs: config.postEveryMs,
      run: async () => {
        if (!tools.createPost) {
          return { event: "post-skipped", reason: "create_post-unavailable" };
        }

        const created = await client.callTool(tools.createPost, {
          type: "post",
          content: makePostText(config),
        });

        const newPostId = created?.postId ?? null;
        if (newPostId) {
          state.createdPostIds = [newPostId, ...(state.createdPostIds || [])].slice(
            0,
            config.maxCreatedPostMemory
          );
        }

        return {
          event: "post-created",
          timestamp: nowIso(),
          postId: newPostId,
        };
      },
    },
    {
      name: "engage",
      enabled: config.enableEngageTask && config.allowMutatingTools,
      everyMs: config.engageEveryMs,
      run: async () => {
        if (!tools.getComments) {
          return { event: "engage-skipped", reason: "get_comments-unavailable" };
        }
        if (!tools.likeComment) {
          return { event: "engage-skipped", reason: "like_comment-unavailable" };
        }

        const postIds = state.createdPostIds || [];
        if (postIds.length === 0) {
          return { event: "engage-skipped", reason: "no-created-posts" };
        }

        const seenCommentIds = new Set(state.seenCommentIds || []);
        let liked = 0;
        let replied = 0;
        let replyMode = "disabled";

        if (config.enableReplyTask) {
          if (canThreadReplies) {
            replyMode = "threaded";
          } else if (config.allowFlatReplies) {
            replyMode = "flat";
          } else {
            replyMode = "disabled-no-thread-support";
          }
        }

        for (const postId of postIds) {
          const result = await client.callTool(tools.getComments, { postId, limit: 20 });
          const comments = asArray(result, "comments")
            .map((c) => {
              const id = String(c?.id || c?.commentId || "").trim();
              const content = String(c?.content || "").trim();
              return id ? { id, content } : null;
            })
            .filter(Boolean);

          for (const comment of comments) {
            if (seenCommentIds.has(comment.id)) continue;

            await client.callTool(tools.likeComment, { commentId: comment.id });
            seenCommentIds.add(comment.id);
            liked++;

            if (replyMode === "flat" && tools.createComment) {
              const content = makeReply(comment.content);
              await client.callTool(tools.createComment, { postId, content });
              replied++;
            }
          }
        }

        state.seenCommentIds = [...seenCommentIds].slice(0, config.maxEngageMemory);

        return {
          event: "engage-done",
          timestamp: nowIso(),
          replyMode,
          liked,
          replied,
        };
      },
    },
  ];

  if (config.runOnce) {
    for (const job of jobs) {
      if (!job.enabled) {
        continue;
      }
      await runJob(job.name, job.run, state);
    }
    writeState(statePath, state);
    return;
  }

  while (true) {
    for (const job of jobs) {
      if (!job.enabled || !isDue(state, job.name, job.everyMs)) {
        continue;
      }
      await runJob(job.name, job.run, state);
      writeState(statePath, state);
    }

    await sleep(config.pollIntervalMs);
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
  makeComment,
  makePostText,
  makeReply,
};
