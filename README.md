# babylon-bot

Babylon trading automation scripts for perp flip execution, agent A2A operations, and auxiliary tooling.

## What This Repo Runs

Primary live workflow:
- `.github/workflows/openagi-flip.yml`
- Trigger: `workflow_dispatch` only
- Runtime action: `node openagi-flip.js` (single check per invocation)

Scheduling model:
- GitHub Actions is not self-scheduled in this repo.
- External scheduler (for example `cron-job.org`) dispatches the workflow every 5 minutes.
- Each invocation performs one pass over configured tickers and exits.

## Core Files

- `openagi-flip.js`: Perp flip engine for user tickers + director-only tickers
- `perp-client.js`: Shared Babylon transport helpers
  - REST: `restGet`, `restPost`
  - MCP: `mcpCall`
  - Agent A2A: `a2aAgentCall`
  - Notifications: `notifyDiscord`
- `one-shot-open.js`: Open a single perp position on a target agent
- `yolobot.js`: Autonomous strategy loop for YOLO bot profile
- `trading-core.js`: Generic utility helpers (env parsing, risk helpers, etc.)

## Flip Logic (openagi-flip.js)

For each ticker:
- LONG -> SHORT when price is above `{TICKER}_FLIP_TO_SHORT_ABOVE`
- SHORT -> LONG when price is below `{TICKER}_FLIP_TO_LONG_BELOW`

Director-only tickers:
- Managed via `DIRECTOR_TICKERS`
- Uses per-agent A2A endpoint (`/api/agents/{agentId}/a2a`)
- Supports per-ticker agent ID, thresholds, and trade size overrides

## Scripts

- `npm run flip`: one-shot flip check
- `npm run flip:watch`: local poll mode (`--watch`)
- `npm run flip:dry`: local dry-run watch mode
- `npm run flip:openagi`: watch OPENAGI only
- `npm run flip:spcx`: watch SPCX only
- `npm run flip:spcx:dry`: dry-run SPCX watch
- `npm run positions`: show perp positions
- `npm run yolobot`: run yolobot strategy loop

Note: CI uses one-shot mode (`node openagi-flip.js`), not `--watch`.

## Required Environment Variables

Minimum:
- `BABYLON_API_KEY`
- `BABYLON_USER_ID`

Common optional:
- `TICKERS`
- `POLL_INTERVAL_MS`
- `DRY_RUN`
- `DISCORD_WEBHOOK_URL`

Director optional:
- `DIRECTOR_AGENT_ID`
- `DIRECTOR_TRADE_SIZE`
- `DIRECTOR_TICKERS`
- `{TICKER}_DIRECTOR_AGENT_ID`
- `{TICKER}_DIRECTOR_AGENT_NAME`
- `{TICKER}_DIRECTOR_FLIP_TO_SHORT_ABOVE`
- `{TICKER}_DIRECTOR_FLIP_TO_LONG_BELOW`
- `{TICKER}_DIRECTOR_TRADE_SIZE`

## Safety Notes

- Run `--dry-run` before changing thresholds or ticker sets.
- Keep `DRY_RUN=false` explicit in CI vars only when you intend live execution.
- Director and user positions are intentionally separated; do not reuse IDs blindly.

## Quick Checks

Local syntax checks:

```bash
node --check openagi-flip.js
node --check perp-client.js
node --check one-shot-open.js
node --check yolobot.js
```

Local dry-run:

```bash
node openagi-flip.js --dry-run
```
