const test = require('node:test');
const assert = require('node:assert');
const { verify, pickCharacter } = require('../bedrockClient');

function makeFetch(responses) {
  let i = 0;
  return async () => {
    const r = responses[i++];
    if (r instanceof Error) throw r;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  };
}

test('verify: 200 → {ok: true}', async () => {
  const r = await verify('sk-test', makeFetch([{ status: 200, body: {} }]));
  assert.deepStrictEqual(r, { ok: true });
});

test('verify: 401 → auth error', async () => {
  const r = await verify('sk-test', makeFetch([{ status: 401, body: {} }]));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.kind, 'auth');
  assert.match(r.error, /token|key|invalid|401/i);
});

test('verify: 403 → auth error', async () => {
  const r = await verify('sk-test', makeFetch([{ status: 403, body: {} }]));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.kind, 'auth');
});

test('verify: network error → network kind', async () => {
  const r = await verify('sk-test', makeFetch([new Error('ECONNREFUSED')]));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.kind, 'network');
  assert.match(r.error, /network|VPN|reach/i);
});

test('pickCharacter: parses valid JSON response', async () => {
  const payload = {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          name: 'Jean-Luc Picard',
          oneLiner: 'Starfleet captain; calm judgment.',
          soulMd: '# Jean-Luc Picard — Orchestrator Agent\n\nSome content.',
        }),
      },
    ],
  };
  const r = await pickCharacter({
    fandom: 'Star Trek: TNG',
    preferences: '',
    apiKey: 'sk-test',
    soulTemplate: 'TEMPLATE',
    fetchImpl: makeFetch([{ status: 200, body: payload }]),
  });
  assert.strictEqual(r.name, 'Jean-Luc Picard');
  assert.match(r.soulMd, /Picard/);
});

test('pickCharacter: retries once on unparseable JSON, then errors', async () => {
  const junkPayload = {
    content: [{ type: 'text', text: 'sorry, no JSON here' }],
  };
  const r = await pickCharacter({
    fandom: 'garbage',
    preferences: '',
    apiKey: 'sk-test',
    soulTemplate: 'TEMPLATE',
    fetchImpl: makeFetch([
      { status: 200, body: junkPayload },
      { status: 200, body: junkPayload },
    ]),
  });
  assert.ok(r.error, 'should return error');
  assert.match(r.error, /parse|json|response/i);
});

test('pickCharacter: surfaces LLM {error} directly', async () => {
  const errPayload = {
    content: [
      { type: 'text', text: JSON.stringify({ error: 'fandom too obscure' }) },
    ],
  };
  const r = await pickCharacter({
    fandom: 'obscure',
    preferences: '',
    apiKey: 'sk-test',
    soulTemplate: 'TEMPLATE',
    fetchImpl: makeFetch([{ status: 200, body: errPayload }]),
  });
  assert.strictEqual(r.error, 'fandom too obscure');
});

test('pickCharacter: 401 from Bedrock → returns error', async () => {
  const r = await pickCharacter({
    fandom: 'x',
    preferences: '',
    apiKey: 'sk-bad',
    soulTemplate: 'TEMPLATE',
    fetchImpl: makeFetch([{ status: 401, body: { error: 'unauthorized' } }]),
  });
  assert.ok(r.error);
  assert.match(r.error, /auth|401|unauth/i);
});
