const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function mkTmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'circe-hh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeProfileEnv(homeDir, profile, contents) {
  const dir = path.join(homeDir, 'profiles', profile);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), contents);
}

function reloadAcpClient(env = {}) {
  for (const k of Object.keys(env)) process.env[k] = env[k];
  delete require.cache[require.resolve('../acpClient')];
  return require('../acpClient');
}

test('loadProfileEnv: reads .env under HERMES_HOME when set', (t) => {
  const home = mkTmpHome(t);
  writeProfileEnv(home, 'picard', 'ANTHROPIC_API_KEY=abc123\nOTHER=xyz\n');
  const originalHome = process.env.HERMES_HOME;
  t.after(() => {
    if (originalHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = originalHome;
    delete require.cache[require.resolve('../acpClient')];
  });
  const { __loadProfileEnvForTest } = reloadAcpClient({ HERMES_HOME: home });
  const env = __loadProfileEnvForTest('picard');
  assert.strictEqual(env.ANTHROPIC_API_KEY, 'abc123');
  assert.strictEqual(env.OTHER, 'xyz');
});

test('loadProfileEnv: falls back to ~/.hermes when HERMES_HOME unset', (t) => {
  const originalHome = process.env.HERMES_HOME;
  delete process.env.HERMES_HOME;
  t.after(() => {
    if (originalHome !== undefined) process.env.HERMES_HOME = originalHome;
    delete require.cache[require.resolve('../acpClient')];
  });
  const { __loadProfileEnvForTest } = reloadAcpClient();
  const env = __loadProfileEnvForTest('does-not-exist-' + Date.now());
  assert.deepStrictEqual(env, {});
});

test('loadProfileEnv: returns {} when file missing', (t) => {
  const home = mkTmpHome(t);
  const originalHome = process.env.HERMES_HOME;
  t.after(() => {
    if (originalHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = originalHome;
    delete require.cache[require.resolve('../acpClient')];
  });
  const { __loadProfileEnvForTest } = reloadAcpClient({ HERMES_HOME: home });
  assert.deepStrictEqual(__loadProfileEnvForTest('nope'), {});
});

test('loadProfileEnv: strips quotes and skips comments', (t) => {
  const home = mkTmpHome(t);
  writeProfileEnv(home, 'p', '# comment\nA="quoted"\nB=\'sq\'\nC=raw\n\n');
  const originalHome = process.env.HERMES_HOME;
  t.after(() => {
    if (originalHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = originalHome;
    delete require.cache[require.resolve('../acpClient')];
  });
  const { __loadProfileEnvForTest } = reloadAcpClient({ HERMES_HOME: home });
  const env = __loadProfileEnvForTest('p');
  assert.strictEqual(env.A, 'quoted');
  assert.strictEqual(env.B, 'sq');
  assert.strictEqual(env.C, 'raw');
});

const { AcpClient } = require('../acpClient');

function makeClientAndFeed(chunks) {
  const c = new AcpClient({ profile: 'testp', onUpdate: () => {} });
  // Reach into internal state — we're testing error plumbing, not spawn.
  const p = new Promise((resolve, reject) => {
    c._pending.set(42, { resolve, reject });
  });
  for (const chunk of chunks) c._onStdout(chunk);
  return p;
}

test('acpClient: rejection carries code and data from JSON-RPC error', async () => {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 42,
    error: { code: -32603, message: 'Internal error', data: { detail: 'boom', traceback: 'File "x.py"...' } },
  }) + '\n';
  const err = await makeClientAndFeed([payload]).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.strictEqual(err.message, 'Internal error');
  assert.strictEqual(err.code, -32603);
  assert.deepStrictEqual(err.data, { detail: 'boom', traceback: 'File "x.py"...' });
});

test('acpClient: rejection preserves undefined code/data when absent', async () => {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 42,
    error: { message: 'minimal' },
  }) + '\n';
  const err = await makeClientAndFeed([payload]).catch((e) => e);
  assert.strictEqual(err.message, 'minimal');
  assert.strictEqual(err.code, undefined);
  assert.strictEqual(err.data, undefined);
});

test('acpClient: rejection uses fallback message when payload.message missing', async () => {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 42,
    error: { code: -32000 },
  }) + '\n';
  const err = await makeClientAndFeed([payload]).catch((e) => e);
  assert.strictEqual(err.message, 'rpc error');
  assert.strictEqual(err.code, -32000);
});

test('acpClient.newSession: retries on -32603 then succeeds', async (t) => {
  // Fake the transport by intercepting _send.
  const c = new AcpClient({ profile: 'testp' });
  c._ready = Promise.resolve();
  let calls = 0;
  const originalSend = c._send.bind(c);
  c._send = async (method, params) => {
    if (method === 'session/new') {
      calls++;
      if (calls < 2) {
        const err = new Error('Internal error');
        err.code = -32603;
        throw err;
      }
      return { sessionId: 'sess-ok' };
    }
    return originalSend(method, params);
  };
  const id = await c.newSession({ backoffMs: [1, 1] });
  assert.strictEqual(id, 'sess-ok');
  assert.strictEqual(calls, 2);
});

test('acpClient.newSession: fails immediately on -32601 (method not found)', async () => {
  const c = new AcpClient({ profile: 'testp' });
  c._ready = Promise.resolve();
  let calls = 0;
  c._send = async () => {
    calls++;
    const err = new Error('method not found');
    err.code = -32601;
    throw err;
  };
  const err = await c.newSession().catch((e) => e);
  assert.strictEqual(err.code, -32601);
  assert.strictEqual(calls, 1);
});

test('acpClient.newSession: fails immediately on auth-shaped data', async () => {
  const c = new AcpClient({ profile: 'testp' });
  c._ready = Promise.resolve();
  let calls = 0;
  c._send = async () => {
    calls++;
    const err = new Error('Internal error');
    err.code = -32603;
    err.data = { detail: 'Invalid token: expired' };
    throw err;
  };
  const err = await c.newSession().catch((e) => e);
  assert.strictEqual(err.code, -32603);
  assert.strictEqual(calls, 1);
});

test('acpClient.newSession: does not retry when subprocess exited', async () => {
  const c = new AcpClient({ profile: 'testp' });
  c._ready = Promise.resolve();
  let calls = 0;
  c._send = async () => {
    calls++;
    throw new Error('hermes acp exited (1)');
  };
  const err = await c.newSession().catch((e) => e);
  assert.match(err.message, /hermes acp exited/);
  assert.strictEqual(calls, 1);
});

test('acpClient.newSession: CIRCE_NO_RETRY=1 disables retries', async (t) => {
  const original = process.env.CIRCE_NO_RETRY;
  process.env.CIRCE_NO_RETRY = '1';
  t.after(() => {
    if (original === undefined) delete process.env.CIRCE_NO_RETRY;
    else process.env.CIRCE_NO_RETRY = original;
  });
  const c = new AcpClient({ profile: 'testp' });
  c._ready = Promise.resolve();
  let calls = 0;
  c._send = async () => {
    calls++;
    const err = new Error('Internal error');
    err.code = -32603;
    throw err;
  };
  const err = await c.newSession().catch((e) => e);
  assert.strictEqual(err.code, -32603);
  assert.strictEqual(calls, 1);
});

test('acpClient.newSession: onRetry fires with attempt number and error', async () => {
  const c = new AcpClient({ profile: 'testp' });
  c._ready = Promise.resolve();
  let calls = 0;
  c._send = async () => {
    calls++;
    if (calls < 3) {
      const err = new Error('Internal error');
      err.code = -32603;
      throw err;
    }
    return { sessionId: 'sess-x' };
  };
  const retries = [];
  const id = await c.newSession({ backoffMs: [1, 1], onRetry: (n, err) => retries.push({ n, code: err.code }) });
  assert.strictEqual(id, 'sess-x');
  assert.deepStrictEqual(retries, [{ n: 2, code: -32603 }, { n: 3, code: -32603 }]);
});
