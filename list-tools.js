require("dotenv").config();

const { BabylonClient } = require("./babylon-client");
const { envFlag, filterTools, parseCsv } = require("./trading-core");

async function main() {
  const client = new BabylonClient({
    authMode: process.env.BABYLON_MCP_AUTH_MODE || process.env.BABYLON_AUTH_MODE || "auto",
  });

  const tools = await client.listTools();
  const { kept, blocked } = filterTools(tools, {
    allowMutatingTools: envFlag(process.env.ALLOW_MUTATING_TOOLS, false),
    allowlist: parseCsv(process.env.BABYLON_ALLOWED_TOOLS),
    blocklist: parseCsv(process.env.BABYLON_BLOCKED_TOOLS),
  });

  console.log("Available Babylon tools:\n");

  for (const tool of kept) {
    console.log(`- ${tool.name}`);
    if (tool.description) {
      console.log(`  ${tool.description}`);
    }
  }

  if (blocked.length > 0) {
    console.log("\nFiltered tools:\n");
    for (const tool of blocked) {
      console.log(`- ${tool.name}`);
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
