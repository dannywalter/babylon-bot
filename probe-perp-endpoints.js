require('dotenv').config();

const TOKEN = process.env.BABYLON_PRIVY_TOKEN;
const USER_ID = process.env.BABYLON_USER_ID || 'did:privy:cmi9b6ko8011djv0czb0ozbvm';
const BASE = 'https://play.babylon.market';

async function tryEndpoint(path) {
  const r = await fetch(BASE + path, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  console.log(`\n[${r.status}] ${path}`);
  if (r.ok) {
    const d = await r.json();
    console.log(JSON.stringify(d, null, 2).slice(0, 3000));
  }
}

(async () => {
  const uid = encodeURIComponent(USER_ID);
  await tryEndpoint(`/api/markets/positions/${uid}`);
  await tryEndpoint(`/api/markets/perps/positions`);
  await tryEndpoint(`/api/markets/perps/positions/${uid}`);
  await tryEndpoint(`/api/users/${uid}/positions`);
  await tryEndpoint(`/api/users/${uid}/perp-positions`);
  await tryEndpoint(`/api/markets/perps`);
})();
