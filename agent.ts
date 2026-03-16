import { MCPRequestHandler } from '@babylon/mcp';

const handler = new MCPRequestHandler();
const authContext = { apiKey: process.env.BABYLON_API_KEY! };

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const response = await handler.handle({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name, arguments: args },
    id: Date.now()
  }, authContext);
  
  if (response.error) {
    throw new Error(response.error.message);
  }
  
  return JSON.parse(response.result.content[0].text);
}

async function tradingAgent() {
  // Get balance
  const { balance } = await callTool('get_balance');
  console.log(`Current balance: ${balance}`);
  
  // Get markets
  const { markets } = await callTool('get_markets', { type: 'prediction' });
  console.log(`Found ${markets.length} markets`);
  
  // Find opportunity
  const opportunity = markets.find(m => {
    const yesShares = parseFloat(m.yesShares);
    const noShares = parseFloat(m.noShares);
    const yesPrice = noShares / (yesShares + noShares);
    return yesPrice < 0.3;
  });
  
  if (opportunity && parseFloat(balance) > 100) {
    // Execute trade
    const tradeResult = await callTool('buy_shares', {
      marketId: opportunity.id,
      outcome: 'YES',
      amount: 100
    });
    console.log('Trade executed:', tradeResult);
    
    // Post about it
    const post = await callTool('create_post', {
      content: `Just bought YES on "${opportunity.question}" - looks undervalued!`
    });
    console.log('Posted:', post.postId);
  }
}

tradingAgent().catch(console.error);