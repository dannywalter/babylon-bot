import "dotenv/config";
import OpenAI from "openai";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { BabylonClient } = require("./babylon-client");
const { envFlag, filterTools, parseCsv } = require("./trading-core");

const model = process.env.OPENAI_MODEL || "gpt-4-turbo";
const prompt =
  process.argv.slice(2).join(" ") ||
  "What markets are available and what is my balance?";

if (!process.env.OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY in environment.");
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const babylon = new BabylonClient({
  authMode: process.env.BABYLON_MCP_AUTH_MODE || process.env.BABYLON_AUTH_MODE || "auto",
});

function parseToolResult(result) {
  if (typeof result === "string") {
    try {
      return JSON.parse(result);
    } catch {
      return result;
    }
  }

  return result;
}

async function listOpenAITools() {
  const tools = await babylon.listTools();
  const allowMutatingTools = envFlag(process.env.ALLOW_MUTATING_TOOLS, false);
  const allowlist = parseCsv(process.env.BABYLON_ALLOWED_TOOLS);
  const blocklist = parseCsv(process.env.BABYLON_BLOCKED_TOOLS);
  const { kept, blocked } = filterTools(tools, {
    allowMutatingTools,
    allowlist,
    blocklist,
  });

  if (blocked.length > 0) {
    const blockedNames = blocked.map((tool) => tool.name).join(", ");
    console.error(`Filtered Babylon tools: ${blockedNames}`);
  }

  if (kept.length === 0) {
    throw new Error("No Babylon MCP tools available after safety filtering.");
  }

  return kept.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.inputSchema || { type: "object", properties: {} },
    },
  }));
}

function safeParseArgs(rawArgs) {
  try {
    return rawArgs ? JSON.parse(rawArgs) : {};
  } catch (error) {
    throw new Error(`Invalid tool args JSON: ${error.message}`);
  }
}

async function main() {
  const openaiTools = await listOpenAITools();

  const first = await openai.chat.completions.create({
    model,
    messages: [{ role: "user", content: prompt }],
    tools: openaiTools,
    tool_choice: "auto",
  });

  const assistantMessage = first.choices[0]?.message;
  if (!assistantMessage) {
    throw new Error("No assistant message returned from OpenAI.");
  }

  const toolCalls = assistantMessage.tool_calls || [];
  if (toolCalls.length === 0) {
    console.log(assistantMessage.content || "No tool calls requested.");
    return;
  }

  const toolMessages = [];

  for (const call of toolCalls) {
    const args = safeParseArgs(call.function.arguments);
    const result = await babylon.callTool(call.function.name, args);
    const parsed = parseToolResult(result);
    const content = typeof parsed === "string" ? parsed : JSON.stringify(parsed);

    toolMessages.push({
      role: "tool",
      tool_call_id: call.id,
      content,
    });

    console.log(`${call.function.name}:`, parsed);
  }

  const final = await openai.chat.completions.create({
    model,
    messages: [{ role: "user", content: prompt }, assistantMessage, ...toolMessages],
  });

  console.log("\nAssistant:", final.choices[0]?.message?.content || "(no content)");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
