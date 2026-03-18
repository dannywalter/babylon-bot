require('dotenv').config();
let mid = 0;
const a2a = (op, p = {}) =>
  fetch('https://babylon.market/api/a2a', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Babylon-Api-Key': process.env.BABYLON_API_KEY },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'message/send',
      params: { message: { messageId: `c${++mid}`, parts: [{ kind: 'data', data: { operation: op, params: p } }] } },
      id: mid,
    }),
  }).then(r => r.json()).then(j => j?.result?.artifacts?.[0]?.parts?.[0]?.data ?? j?.result);

const CHAT = process.env.DIRECTOR_CHAT_ID;

async function main() {
  const cmd = '@yolo EXECUTE FLIP_SHORT - close any open LONG on METAI, then open a 1x SHORT using 95% of your available balance.';
  console.log('Sending directive to YOLObot chat', CHAT);
  const sent = await a2a('messaging.send_message', { chatId: CHAT, content: cmd });
  console.log('Sent:', JSON.stringify(sent, null, 2));

  console.log('\nWaiting 12s for response...');
  await new Promise(r => setTimeout(r, 12000));

  const msgs = await a2a('messaging.get_chat_messages', { chatId: CHAT, limit: 4 });
  console.log('\nChat messages:', JSON.stringify(msgs, null, 2));
}

main().catch(e => { console.error(e.message); process.exit(1); });
