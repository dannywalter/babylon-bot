require("dotenv").config();

const { BabylonClient } = require("./babylon-client");

const babylon = new BabylonClient({
  authMode: process.env.BABYLON_AUTH_MODE || "auto",
});

async function tradingAgent() {
  // Get balance
  const { balance } = await babylon.callTool("get_balance");
  console.log(`Current balance: ${balance}`);

  // Get markets
  const { markets } = await babylon.callTool("get_markets", { type: "prediction" });
  console.log(`Found ${markets.length} markets`);

  // Find opportunity: YES price below 30%
  const opportunity = markets.find((m) => {
    const yesShares = parseFloat(m.yesShares);
    const noShares = parseFloat(m.noShares);
    const yesPrice = noShares / (yesShares + noShares);
    return yesPrice < 0.3;
  });

  if (opportunity && parseFloat(balance) > 100) {
    // Execute trade
    const tradeResult = await babylon.callTool("buy_shares", {
      marketId: opportunity.id,
      outcome: "YES",
      amount: 100,
    });
    console.log("Trade executed:", tradeResult);

    // Post about it
    const post = await babylon.callTool("create_post", {
      content: `Just bought YES on "${opportunity.question}" - looks undervalued!`,
    });
    console.log("Posted:", post.postId);
  } else {
    console.log("No opportunity found or insufficient balance.");
  }
}

tradingAgent().catch(console.error);
