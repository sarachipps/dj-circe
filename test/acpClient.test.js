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

// ─── Auto-restart on Hermes auth-rebuild bug ─────────────────────────────

function makeAutoRestartClient({ startImpl, sendImpl } = {}) {
  const events = [];
  const c = new AcpClient({
    profile: 'testp',
    onAutoRestart: (p) => events.push(p),
  });
  // Skip the real spawn — pretend the child is up.
  c._child = { kill: () => {}, stdin: { writable: false, write: () => {} } };
  c._ready = Promise.resolve();
  c.start = startImpl || (() => { c._ready = Promise.resolve(); return c._ready; });
  c._send = sendImpl || (async () => ({}));
  return { c, events };
}

test('acpClient: stderr with auth-rebuild pattern triggers auto-restart', async () => {
  const { c, events } = makeAutoRestartClient();
  c._lastSessionId = 'sess-abc';
  c._onStderr('[acp:testp] ⚠️  API call failed (attempt 1/3)\n');
  c._onStderr('   📝 Error: "Could not resolve authentication method. Expected either api_key or auth_token…"\n');
  // Give the microtask queue time to run the async coroutine.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const phases = events.map((e) => e.phase);
  assert.deepStrictEqual(phases, ['detected', 'restarting', 'restarted']);
  assert.strictEqual(events[0].sessionId, 'sess-abc');
});

test('acpClient: stderr without pattern does NOT trigger auto-restart', async () => {
  const { c, events } = makeAutoRestartClient();
  c._onStderr('[acp:testp] 2026-09-03 11:35:17 [INFO] normal log line\n');
  c._onStderr('[acp:testp] some other error that we do not auto-recover from\n');
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(events, []);
});

test('acpClient: repeat matches within debounce window count as one restart', async () => {
  const { c, events } = makeAutoRestartClient();
  c._onStderr('Error: "Could not resolve authentication method."\n');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  // Same failure spraying stderr — should NOT retrigger.
  c._onStderr('Error: "Could not resolve authentication method."\n');
  c._onStderr('Error: "Could not resolve authentication method."\n');
  await new Promise((r) => setImmediate(r));
  const detected = events.filter((e) => e.phase === 'detected').length;
  assert.strictEqual(detected, 1);
});

test('acpClient: after 3 restarts in the window, further triggers fire givingUp', async () => {
  const { c, events } = makeAutoRestartClient();
  // Directly invoke the coroutine three times bypassing the debounce so
  // we're testing the rate limiter, not the debouncer.
  await c._attemptAutoRestart('t1');
  await c._attemptAutoRestart('t2');
  await c._attemptAutoRestart('t3');
  await c._attemptAutoRestart('t4');
  const givingUp = events.find((e) => e.phase === 'givingUp' && e.reason === 'rate-limit');
  assert.ok(givingUp, 'expected a givingUp/rate-limit event on the 4th attempt');
  assert.strictEqual(givingUp.trigger, 't4');
});

test('acpClient: auto-restart calls session/load when a sessionId is known', async () => {
  const sent = [];
  const { c } = makeAutoRestartClient({
    sendImpl: async (method, params) => {
      sent.push({ method, params });
      return {};
    },
  });
  c._lastSessionId = 'sess-42';
  await c._attemptAutoRestart('unit-test');
  const loadCall = sent.find((s) => s.method === 'session/load');
  assert.ok(loadCall, 'expected session/load after restart');
  assert.strictEqual(loadCall.params.sessionId, 'sess-42');
});

test('acpClient: auto-restart skips session/load when there is no known session', async () => {
  const sent = [];
  const { c } = makeAutoRestartClient({
    sendImpl: async (method, params) => {
      sent.push({ method, params });
      return {};
    },
  });
  c._lastSessionId = null;
  await c._attemptAutoRestart('unit-test');
  assert.strictEqual(sent.find((s) => s.method === 'session/load'), undefined);
});

test('acpClient: stop() prevents future auto-restart attempts', async () => {
  const { c, events } = makeAutoRestartClient();
  c.stop();
  c._onStderr('Error: "Could not resolve authentication method."\n');
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(events, []);
});

test('acpClient: pattern split across two stderr chunks still matches', async () => {
  const { c, events } = makeAutoRestartClient();
  c._onStderr('some prefix ... Could not resolve ');
  c._onStderr('authentication method. Expected either api_key…\n');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.ok(events.find((e) => e.phase === 'detected'));
});

test('acpClient: newSession records the returned sessionId for later resume', async () => {
  const c = new AcpClient({ profile: 'testp' });
  c._ready = Promise.resolve();
  c._send = async (method) => {
    if (method === 'session/new') return { sessionId: 'sess-record' };
    return {};
  };
  const id = await c.newSession();
  assert.strictEqual(id, 'sess-record');
  assert.strictEqual(c._lastSessionId, 'sess-record');
});

test('acpClient: loadSession records the sessionId for later resume', async () => {
  const c = new AcpClient({ profile: 'testp' });
  c._ready = Promise.resolve();
  c._send = async () => ({});
  await c.loadSession('sess-loaded');
  assert.strictEqual(c._lastSessionId, 'sess-loaded');
});

test('acpClient: old child exit after auto-restart does not reject new pending', async () => {
  // Reproduces the race where the OLD child's async 'exit' event fires
  // after the NEW child has already started, walks the shared _pending
  // Map, and rejects the new child's in-flight initialize as
  // "hermes acp exited (null)". Fixed by removing listeners on the old
  // child before killing it inside _attemptAutoRestart.
  const { EventEmitter } = require('node:events');

  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.killed = false;
      this.stdin = { writable: true, write: () => {} };
      this.stdout = new EventEmitter();
      this.stderr = new EventEmitter();
    }
    kill() {
      this.killed = true;
      // Simulate the real Node behavior — 'exit' fires asynchronously.
      setImmediate(() => this.emit('exit', null));
    }
  }

  // Build a client that wires the same exit handler start() uses.
  const c = new AcpClient({ profile: 'testp' });
  const oldChild = new FakeChild();
  c._child = oldChild;
  oldChild.on('exit', (code) => {
    for (const [, p] of c._pending) {
      p.reject(new Error(`hermes acp exited (${code})`));
    }
    c._pending.clear();
    if (c._autoRestarting) return;
    c.onExit(code);
  });
  c._ready = Promise.resolve();
  // Fake start() that installs a fresh pending entry (simulates the new
  // child's initialize call).
  c.start = () => {
    c._child = new FakeChild();
    c._pending.set(999, {
      resolve: () => {},
      reject: (err) => { throw new Error('new initialize should not be rejected: ' + err.message); },
    });
    c._ready = Promise.resolve();
    return c._ready;
  };
  c._send = async () => ({});

  await c._attemptAutoRestart('unit-test');
  // Let the old child's queued 'exit' event fire.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  // The new-child pending entry must still be there — old exit shouldn't touch it.
  assert.ok(c._pending.has(999), 'new child pending entry must survive old child exit');
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
