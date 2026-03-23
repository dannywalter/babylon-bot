require('dotenv').config();

const BASE_URL = (process.env.BABYLON_BASE_URL || 'https://babylon.market').replace(/\/$/, '');
const API_KEY = process.env.BABYLON_API_KEY;
const PRIVY_TOKEN = process.env.BABYLON_PRIVY_TOKEN;
const ONBOARD_BEARER_TOKEN = process.env.BABYLON_ONBOARD_BEARER_TOKEN;
const AGENT_NAME = process.env.AGENT_NAME || 'DOCTOR ASS';
const AGENT_DESCRIPTION =
  process.env.AGENT_DESCRIPTION ||
  'A high-risk, high-reward YOLO trader who lives for the thrill of the trade. No risk, no reward, no problem.';
const AGENT_ENDPOINT = process.env.AGENT_ENDPOINT || 'https://web-production-60c99.up.railway.app/';
const AGENT_EXTERNAL_ID = process.env.AGENT_EXTERNAL_ID || `agent-${Date.now()}`;

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
  if (compact(ONBOARD_BEARER_TOKEN)) {
    candidates.push({
      label: 'Authorization Bearer (BABYLON_ONBOARD_BEARER_TOKEN)',
      headers: { Authorization: `Bearer ${ONBOARD_BEARER_TOKEN}` },
    });
  }

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

function uniqueAuthCandidates(candidates) {
  const seen = new Set();
  const output = [];

  for (const candidate of candidates) {
    const key = JSON.stringify(candidate.headers || {});
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(candidate);
  }

  return output;
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
  const authAttempts = uniqueAuthCandidates(resolveCandidateAuthHeaders());
  if (authAttempts.length === 0) {
    throw new Error('Missing auth credentials. Set BABYLON_ONBOARD_BEARER_TOKEN, BABYLON_API_KEY, or BABYLON_PRIVY_TOKEN.');
  }

  const onboardBody = {
    name: AGENT_NAME,
    description: AGENT_DESCRIPTION,
    endpoint: AGENT_ENDPOINT,
  };

  let onboardPayload = null;
  let usedAuthLabel = null;
  const onboardErrors = [];

  for (const attempt of authAttempts) {
    try {
      console.log(`Trying onboard auth: ${attempt.label}`);
      onboardPayload = await postJson('/api/agents/onboard', onboardBody, attempt.headers);
      usedAuthLabel = attempt.label;
      break;
    } catch (error) {
      onboardErrors.push(`${attempt.label}: ${error.message}`);
      console.warn(`Onboard attempt failed (${attempt.label}): ${error.message}`);
    }
  }

  if (onboardPayload) {
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
    return;
  }

  console.log('\nOnboard failed with all auth methods. Trying external registration fallback...');

  const externalBody = {
    externalId: AGENT_EXTERNAL_ID,
    name: AGENT_NAME,
    description: AGENT_DESCRIPTION,
    endpoint: AGENT_ENDPOINT,
    protocol: 'a2a',
    capabilities: { strategies: ['trading'], markets: ['prediction', 'perpetuals'] },
  };

  const externalAttempts = authAttempts.filter((attempt) => {
    const headers = attempt.headers || {};
    return Boolean(headers.Authorization || headers.Cookie);
  });

  const externalErrors = [];
  for (const attempt of externalAttempts) {
    try {
      console.log(`Trying external register auth: ${attempt.label}`);
      const payload = await postJson('/api/agents/external/register', externalBody, attempt.headers);
      const apiKey = payload?.apiKey || payload?.data?.apiKey;
      if (!apiKey) {
        throw new Error(`External register response missing apiKey: ${JSON.stringify(payload)}`);
      }

      console.log('\nExternal registration successful.');
      console.log(`- auth used: ${attempt.label}`);
      console.log(`- externalId: ${AGENT_EXTERNAL_ID}`);
      console.log('Use these env values:');
      console.log(`BABYLON_AGENT_ID=${AGENT_EXTERNAL_ID}`);
      console.log(`BABYLON_API_KEY=${apiKey}`);
      console.log('\nImportant: store BABYLON_API_KEY securely now. It may not be retrievable later.');
      return;
    } catch (error) {
      externalErrors.push(`${attempt.label}: ${error.message}`);
      console.warn(`External register attempt failed (${attempt.label}): ${error.message}`);
    }
  }

  const details = [
    `Onboard errors: ${onboardErrors.length ? onboardErrors.join(' || ') : 'none'}`,
    `External-register errors: ${externalErrors.length ? externalErrors.join(' || ') : 'none'}`,
  ].join('\n');
  throw new Error(`Unable to register agent with current credentials.\n${details}`);
}

onboardAndAuth().catch((error) => {
  console.error('FATAL:', error.message);
  process.exit(1);
});
