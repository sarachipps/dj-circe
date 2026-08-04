const BEDROCK_URL =
  'https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
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
      'anthropic-version': ANTHROPIC_VERSION,
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
    `agent fleets. Circe agents are given personalities drawn from a fandom\n` +
    `the user loves — this can be a fictional universe (shows, books, games,\n` +
    `comics) OR a real-world one (a sports team, a band, a historical era, a\n` +
    `professional community).\n\n` +
    `The user is creating their FIRST agent — the Orchestrator. This agent\n` +
    `is the manager of their eventual fleet: it drafts specialized agents,\n` +
    `proposes changes, and helps the user think about their work. Think\n` +
    `project manager, chief of staff, or ship's captain — not a specialist.\n\n` +
    `Your job:\n` +
    `1. Pick ONE persona from the user's fandom best suited to be an\n` +
    `   Orchestrator. PREFER a fictional character when the fandom has\n` +
    `   suitable ones. If the fandom is real-world (e.g. a sports team, a\n` +
    `   band, a historical movement), pick a real person from it — a\n` +
    `   legendary coach, a bandleader, a captain, a foundational figure —\n` +
    `   whose public persona fits the Orchestrator role. Prefer personas\n` +
    `   known for calm judgment, delegation, long-horizon thinking, and\n` +
    `   comfort with authority. Avoid pure specialists (the medic, the\n` +
    `   pilot, the hacker, the closer).\n` +
    `2. Write a full SOUL.md for this persona. Follow the template below\n` +
    `   EXACTLY. Fill in every section in-voice for them — their phrasing,\n` +
    `   their concerns, how they'd manage. For real people, draw on their\n` +
    `   well-known public persona; do not invent private details.\n` +
    `3. Return STRICT JSON. No prose before or after. Schema:\n` +
    `   {\n` +
    `     "name": "Persona's proper name",\n` +
    `     "oneLiner": "≤120 chars: who they are and why they'd make a good Orchestrator",\n` +
    `     "soulMd": "The full SOUL.md as a single markdown string"\n` +
    `   }\n\n` +
    `If the fandom is too obscure or ambiguous to pick with confidence, OR\n` +
    `if no persona in it — fictional or real — fits an Orchestrator role,\n` +
    `return instead:\n` +
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

function stripCodeFences(text) {
  // Handle ```json ... ``` and bare ``` ... ``` wrappers.
  const m = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  return m ? m[1].trim() : text.trim();
}

function parsePickResponse(text) {
  if (!text) return { ok: false };
  const stripped = stripCodeFences(text);
  try {
    const parsed = JSON.parse(stripped);
    if (parsed && typeof parsed === 'object') return { ok: true, value: parsed };
  } catch {}
  // Last-ditch: extract the first {...} block (Claude sometimes prefaces JSON
  // with a sentence even when told not to).
  const braceMatch = stripped.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      const parsed = JSON.parse(braceMatch[0]);
      if (parsed && typeof parsed === 'object') return { ok: true, value: parsed };
    } catch {}
  }
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
