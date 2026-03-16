require('dotenv').config();

const MCP_URL = 'https://babylon.market/mcp';
const API_KEY = process.env.BABYLON_API_KEY;

async function callTool(toolName, params = {}) {
  try {
    const response = await fetch(MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Babylon-Api-Key': API_KEY,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: params,
        },
        id: 1,
      }),
    });

    const data = await response.json();
    if (data.error) {
      throw new Error(data.error.message);
    }
    // Extract text from response and parse JSON
    if (data.result?.content && Array.isArray(data.result.content)) {
      const textContent = data.result.content.find(c => c.type === 'text');
      if (textContent?.text) {
        try {
          return JSON.parse(textContent.text);
        } catch (e) {
          return textContent.text;
        }
      }
    }
    return data.result;
  } catch (error) {
    console.error(`Error calling tool ${toolName}:`, error.message);
    return null;
  }
}

async function main() {
  console.log('Fetching all markets...\n');
  
  // Get all markets
  const marketsResponse = await callTool('get_markets', { type: 'all' });
  
  if (!marketsResponse) {
    console.error('Failed to fetch markets');
    return;
  }
  
  const markets = marketsResponse.markets || [];
  
  if (markets.length === 0) {
    console.log('No markets found');
    return;
  }
  
  console.log(`Found ${markets.length} markets\n`);

  // Fetch detailed data for all markets to find $OPENAGI
  console.log('Searching for $OPENAGI market...\n');
  
  for (const market of markets) {
    const marketId = market.id || market;
    const marketData = await callTool('get_market_data', { marketId });
    
    if (marketData) {
      const name = marketData.symbol || marketData.name || marketData.title || marketId;
      
      if (name.toUpperCase().includes('OPENAGI')) {
        console.log(`Found $OPENAGI! Market ID: ${marketId}\n`);
        console.log('Market Data:');
        console.log(JSON.stringify(marketData, null, 2));
        return;
      }
    }
  }
  
  console.log('$OPENAGI not found in available markets.');
  console.log('\nTrying all market details:');
  for (const market of markets) {
    const marketId = market.id || market;
    const marketData = await callTool('get_market_data', { marketId });
    if (marketData) {
      console.log(`\nMarket ${marketId}:`);
      console.log(JSON.stringify(marketData, null, 2).slice(0, 500));
    }
  }
}

main();
