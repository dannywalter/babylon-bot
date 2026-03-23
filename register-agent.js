require('dotenv').config();

const BASE_URL = (process.env.BABYLON_BASE_URL || 'https://babylon.market').replace(/\/$/, '');
const API_KEY = process.env.BABYLON_API_KEY;
const PRIVY_TOKEN = process.env.BABYLON_PRIVY_TOKEN;
const AGENT_NAME = process.env.AGENT_NAME || 'DOCTOR ASS';
const AGENT_DESCRIPTION =
  process.env.AGENT_DESCRIPTION ||
  'A high-risk, high-reward YOLO trader who lives for the thrill of the trade. No risk, no reward, no problem.';
const AGENT_ENDPOINT = process.env.AGENT_ENDPOINT || 'https://web-production-60c99.up.railway.app/';

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function compact(value) {
  return String(value || '').trim();
}

async function postJson(path, body, auth) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...auth,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  const payload = safeParse(text);

  if (!response.ok) {
    throw new Error(
      `${path} failed with ${response.status}: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`
    );
  }

  return payload;
}

function resolveCandidateAuthHeaders() {
  const candidates = [];
  if (compact(API_KEY)) {
    candidates.push({
      label: 'X-Babylon-Api-Key',
      headers: { 'X-Babylon-Api-Key': API_KEY },
    });
  }

  if (compact(PRIVY_TOKEN)) {
    candidates.push({
      label: 'Authorization Bearer (Privy token)',
      headers: { Authorization: `Bearer ${PRIVY_TOKEN}` },
    });
    candidates.push({
      label: 'Privy token cookie',
      headers: { Cookie: `privy-token=${PRIVY_TOKEN}` },
    });
  }

  return candidates;
}

function extractAgentCredentials(payload) {
  const agentId =
    payload?.agentId ||
    payload?.id ||
    payload?.agent?.id ||
    payload?.agent?.agentId ||
    payload?.data?.agentId ||
    payload?.data?.id;

  const secret =
    payload?.secret ||
    payload?.agentSecret ||
    payload?.cronSecret ||
    payload?.data?.secret ||
    payload?.data?.agentSecret ||
    payload?.data?.cronSecret;

  return { agentId, secret };
}

async function onboardAndAuth() {
  const authAttempts = resolveCandidateAuthHeaders();
  if (authAttempts.length === 0) {
    throw new Error('Missing auth credentials. Set BABYLON_API_KEY or BABYLON_PRIVY_TOKEN.');
  }

  const onboardBody = {
    name: AGENT_NAME,
    description: AGENT_DESCRIPTION,
    endpoint: AGENT_ENDPOINT,
  };

  let onboardPayload = null;
  let usedAuthLabel = null;

  for (const attempt of authAttempts) {
    try {
      console.log(`Trying onboard auth: ${attempt.label}`);
      onboardPayload = await postJson('/api/agents/onboard', onboardBody, attempt.headers);
      usedAuthLabel = attempt.label;
      break;
    } catch (error) {
      console.warn(`Onboard attempt failed (${attempt.label}): ${error.message}`);
    }
  }

  if (!onboardPayload) {
    throw new Error('All onboard authentication attempts failed.');
  }

  const { agentId, secret } = extractAgentCredentials(onboardPayload);
  if (!agentId || !secret) {
    throw new Error(
      `Onboard response missing agentId/secret. Response: ${JSON.stringify(onboardPayload)}`
    );
  }

  console.log('\nOnboard successful.');
  console.log(`- auth used: ${usedAuthLabel}`);
  console.log(`- agentId: ${agentId}`);
  console.log('- secret: [REDACTED IN LOG]');

  const authPayload = await postJson('/api/agents/auth', { agentId, secret }, {});
  const token =
    authPayload?.token ||
    authPayload?.sessionToken ||
    authPayload?.accessToken ||
    authPayload?.jwt ||
    authPayload?.data?.token;

  if (!token) {
    throw new Error(`Auth response missing token. Response: ${JSON.stringify(authPayload)}`);
  }

  console.log('\nAgent auth successful.');
  console.log('Use one of these in your env:');
  console.log(`BABYLON_AGENT_ID=${agentId}`);
  console.log(`BABYLON_AGENT_SECRET=${secret}`);
  console.log(`BABYLON_BEARER_TOKEN=${token}`);
  console.log('\nImportant: store BABYLON_AGENT_SECRET securely now. It may not be retrievable later.');
}

onboardAndAuth().catch((error) => {
  console.error('FATAL:', error.message);
  process.exit(1);
});
