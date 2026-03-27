require('dotenv').config();
const { restGet } = require('./perp-client');

const agents = [
  { name: 'YOLObot (AIPHB)', id: process.env.DIRECTOR_AGENT_ID },
  { name: 'Phantom Signal', id: '284593158694633472' },
  { name: 'PatrickBatemAIn', id: '283038576151625728' },
  { name: 'DoctorAss', id: '280511915413733376' },
  { name: 'Prism Ultra', id: '283912474304970752' },
  { name: 'Mind', id: '280563354370572288' },
  { name: 'Vertex Wave', id: '283851304869036032' },
  { name: 'Shadow X', id: '280580473090998272' },
  { name: 'XiSystem', id: '280570154494984192' },
  { name: 'Upsilon Grid', id: '286085773902479360' },
];

(async () => {
  console.log('Agent Status Report\n' + '='.repeat(90));
  for (const agent of agents) {
    try {
      const d = await restGet(`/api/markets/positions/${encodeURIComponent(agent.id)}`);
      const perps = d?.perpetuals?.positions ?? [];
      const display = perps.length > 0
        ? perps.map(p => `${p.ticker} ${p.side.toUpperCase()} $${Math.round(p.size).toLocaleString()}`).join(', ')
        : '🟡 NO POSITIONS';
      console.log(`${agent.name.padEnd(22)} | ${display}`);
    } catch (e) {
      console.log(`${agent.name.padEnd(22)} | ERROR: ${e.message.slice(0, 50)}`);
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
