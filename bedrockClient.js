const BEDROCK_URL =
  'https://bedrock-mantle.us-east-1.api.aws/anthropic/chat/completions';
const MODEL = 'anthropic.claude-sonnet-5';

const AUTH_ERROR_COPY =
  'Bedrock rejected the token (401/403). Get a fresh key from ' +
  'https://dowjones.atlassian.net/wiki/spaces/SFSS/pages/6559957082/Get+your+Amazon+Bedrock+API+Key ' +
  'and try again.';
const NETWORK_ERROR_COPY =
  "Couldn't reach Bedrock — check your network / VPN.";
const UNKNOWN_ERROR_COPY = (status) =>
  `Bedrock returned an unexpected status (${status}). Try again in a moment.`;

async function callBedrock({ apiKey, body, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  return doFetch(BEDROCK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
}

async function verify(apiKey, fetchImpl) {
  const body = {
    model: MODEL,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'ok' }],
  };
  let res;
  try {
    res = await callBedrock({ apiKey, body, fetchImpl });
  } catch (err) {
    return { ok: false, error: NETWORK_ERROR_COPY, kind: 'network' };
  }
  if (res.ok) return { ok: true };
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: AUTH_ERROR_COPY, kind: 'auth' };
  }
  return { ok: false, error: UNKNOWN_ERROR_COPY(res.status), kind: 'unknown' };
}

function buildSystemPrompt(soulTemplate) {
  return (
    `You are helping onboard a user to Circe, a tool for running personal AI\n` +
    `agent fleets. Circe agents are given personalities drawn from fandoms\n` +
    `the user loves.\n\n` +
    `The user is creating their FIRST agent — the Orchestrator. This agent\n` +
    `is the manager of their eventual fleet: it drafts specialized agents,\n` +
    `proposes changes, and helps the user think about their work. Think\n` +
    `project manager, chief of staff, or ship's captain — not a specialist.\n\n` +
    `Your job:\n` +
    `1. Pick ONE character from the user's fandom best suited to be an\n` +
    `   Orchestrator. Prefer characters known for calm judgment, delegation,\n` +
    `   long-horizon thinking, and comfort with authority. Avoid pure\n` +
    `   specialists (the medic, the pilot, the hacker).\n` +
    `2. Write a full SOUL.md for this character. Follow the template below\n` +
    `   EXACTLY. Fill in every section in-voice for the character — their\n` +
    `   phrasing, their concerns, how they'd manage.\n` +
    `3. Return STRICT JSON. No prose before or after. Schema:\n` +
    `   {\n` +
    `     "name": "Character's proper name",\n` +
    `     "oneLiner": "≤120 chars: who they are and why they'd make a good Orchestrator",\n` +
    `     "soulMd": "The full SOUL.md as a single markdown string"\n` +
    `   }\n\n` +
    `If the fandom is too obscure to pick with confidence, OR if no character\n` +
    `in it fits an Orchestrator role, return instead:\n` +
    `   { "error": "brief human-readable reason" }\n\n` +
    `--- SOUL.md TEMPLATE (fill each section in-voice) ---\n` +
    soulTemplate
  );
}

function buildUserPrompt({ fandom, preferences }) {
  const prefs = preferences && preferences.trim()
    ? preferences.trim()
    : 'none provided';
  return `Fandom: ${fandom}\nPreferences: ${prefs}`;
}

function extractTextContent(payload) {
  if (!payload || !Array.isArray(payload.content)) return '';
  for (const block of payload.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      return block.text;
    }
  }
  return '';
}

function parsePickResponse(text) {
  if (!text) return { ok: false };
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') return { ok: true, value: parsed };
  } catch {}
  return { ok: false };
}

async function pickCharacter({
  fandom,
  preferences,
  apiKey,
  soulTemplate,
  fetchImpl,
}) {
  const body = {
    model: MODEL,
    max_tokens: 4000,
    system: buildSystemPrompt(soulTemplate),
    messages: [{ role: 'user', content: buildUserPrompt({ fandom, preferences }) }],
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await callBedrock({ apiKey, body, fetchImpl });
    } catch (err) {
      return { error: NETWORK_ERROR_COPY };
    }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        return { error: AUTH_ERROR_COPY };
      }
      return { error: UNKNOWN_ERROR_COPY(res.status) };
    }
    const payload = await res.json();
    const text = extractTextContent(payload);
    const parsed = parsePickResponse(text);
    if (!parsed.ok) continue; // retry once
    const v = parsed.value;
    if (v.error) return { error: String(v.error) };
    if (v.name && v.oneLiner && v.soulMd) {
      return { name: v.name, oneLiner: v.oneLiner, soulMd: v.soulMd };
    }
    // JSON parsed but missing required fields — treat as retryable.
  }

  return { error: 'Could not parse a valid response from Bedrock after retry.' };
}

module.exports = { verify, pickCharacter };
