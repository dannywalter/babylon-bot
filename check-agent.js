require('dotenv').config();
const API_KEY = process.env.BABYLON_API_KEY;
const USER_ID = '286736150175940608';

Promise.all([
  fetch('https://play.babylon.market/api/markets/positions/' + encodeURIComponent(USER_ID), {
    headers: { 'X-Babylon-Api-Key': API_KEY }
  }).then(r => r.json()),
  fetch('https://play.babylon.market/api/users/' + USER_ID + '/posts?limit=5', {
    headers: { 'X-Babylon-Api-Key': API_KEY }
  }).then(r => r.json())
]).then(([pos, posts]) => {
  const perps = pos?.perpetuals?.positions ?? [];
  const preds = Array.isArray(pos?.predictions) ? pos.predictions : [];

  console.log('=== PERP POSITIONS ===');
  if (!perps.length) console.log('none');
  perps.forEach(p => console.log(
    p.ticker.padEnd(10), p.side.toUpperCase().padEnd(6),
    '$' + p.size.toLocaleString(),
    ' uPnL: $' + p.unrealizedPnL.toFixed(0),
    '(' + p.unrealizedPnLPercent.toFixed(1) + '%)'
  ));

  console.log('\n=== BINARY POSITIONS (top 10) ===');
  preds.slice(0, 10).forEach(p => console.log(
    (p.marketTitle || p.marketId || '').substring(0, 40).padEnd(42),
    (p.outcome || '').toUpperCase().padEnd(4),
    'shares:' + (p.shares || 0).toFixed(0),
    ' val:$' + (p.currentValue || 0).toFixed(0)
  ));

  console.log('\n=== RECENT POSTS ===');
  const arr = posts?.posts ?? posts?.items ?? posts?.data ?? (Array.isArray(posts) ? posts : []);
  if (!arr.length) console.log('none / unexpected format:', JSON.stringify(posts).substring(0, 200));
  arr.slice(0, 5).forEach(p => console.log('-', (p.content || '').substring(0, 120)));
});
