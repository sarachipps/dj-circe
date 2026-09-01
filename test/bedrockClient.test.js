const test = require('node:test');
const assert = require('node:assert');
const { verify, pickCharacter } = require('../bedrockClient');

function makeFetch(responses) {
  let i = 0;
  const fn = async () => {
    const r = responses[i++];
    if (r instanceof Error) throw r;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  };
  Object.defineProperty(fn, 'calls', {
    get() { return i; }
  });
  return fn;
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
  assert.match(r.error, /token|key|invalid|401|confluence/i);
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
  const fetchImpl = makeFetch([
    { status: 200, body: junkPayload },
    { status: 200, body: junkPayload },
  ]);
  const r = await pickCharacter({
    fandom: 'garbage',
    preferences: '',
    apiKey: 'sk-test',
    soulTemplate: 'TEMPLATE',
    fetchImpl,
  });
  assert.ok(r.error, 'should return error');
  assert.match(r.error, /parse|json|response/i);
  assert.strictEqual(fetchImpl.calls, 2, 'should have made exactly 2 fetch calls');
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

test('pickCharacter: network error → returns network error copy', async () => {
  const r = await pickCharacter({
    fandom: 'x',
    preferences: '',
    apiKey: 'sk-test',
    soulTemplate: 'TEMPLATE',
    fetchImpl: makeFetch([new Error('ECONNREFUSED')]),
  });
  assert.ok(r.error);
  assert.match(r.error, /network|VPN|reach/i);
});

test('pickCharacter: retries on incomplete JSON (missing required fields)', async () => {
  const incompletePayload = {
    content: [{ type: 'text', text: JSON.stringify({ name: 'X' }) }],
  };
  const r = await pickCharacter({
    fandom: 'x',
    preferences: '',
    apiKey: 'sk-test',
    soulTemplate: 'TEMPLATE',
    fetchImpl: makeFetch([
      { status: 200, body: incompletePayload },
      { status: 200, body: incompletePayload },
    ]),
  });
  assert.ok(r.error);
  assert.match(r.error, /parse|valid|response/i);
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

test('verify: retries once on network error then succeeds', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) throw new Error('ECONNRESET');
    return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
  };
  const retries = [];
  const r = await verify('sk-test', fetchImpl, {
    backoffMs: [1],
    onRetry: (n, err) => retries.push({ n, msg: err.message }),
  });
  assert.deepStrictEqual(r, { ok: true });
  assert.strictEqual(calls, 2);
  assert.deepStrictEqual(retries, [{ n: 2, msg: 'ECONNRESET' }]);
});

test('verify: does not retry on 401', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: false, status: 401, json: async () => ({}), text: async () => '{}' };
  };
  const r = await verify('sk-test', fetchImpl, { backoffMs: [1] });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.kind, 'auth');
  assert.strictEqual(calls, 1);
});

test('verify: does not retry on 500', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: false, status: 500, json: async () => ({}), text: async () => '{}' };
  };
  const r = await verify('sk-test', fetchImpl, { backoffMs: [1] });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.kind, 'unknown');
  assert.strictEqual(calls, 1);
});

test('verify: two network errors → returns network error', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('EHOSTUNREACH'); };
  const r = await verify('sk-test', fetchImpl, { backoffMs: [1] });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.kind, 'network');
  assert.strictEqual(calls, 2);
});

test('verify: CIRCE_NO_RETRY=1 disables retries', async (t) => {
  const original = process.env.CIRCE_NO_RETRY;
  process.env.CIRCE_NO_RETRY = '1';
  t.after(() => {
    if (original === undefined) delete process.env.CIRCE_NO_RETRY;
    else process.env.CIRCE_NO_RETRY = original;
  });
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('boom'); };
  const r = await verify('sk-test', fetchImpl, { backoffMs: [1] });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.kind, 'network');
  assert.strictEqual(calls, 1);
});
