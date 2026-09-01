const test = require('node:test');
const assert = require('node:assert');
const { retryable } = require('../retryUtil');

function fakeClock(t) {
  const originalSetTimeout = global.setTimeout;
  const scheduled = [];
  global.setTimeout = (fn, ms) => {
    scheduled.push({ fn, ms });
    return { unref() {} };
  };
  t.after(() => { global.setTimeout = originalSetTimeout; });
  return {
    scheduled,
    tick() {
      const s = scheduled.shift();
      if (s) s.fn();
    },
  };
}

test('retryable: resolves on first success without waiting', async () => {
  let calls = 0;
  const r = await retryable(async () => (calls++, 'ok'), {
    attempts: 3,
    backoffMs: [500, 1500],
    isRetryable: () => true,
  });
  assert.strictEqual(r, 'ok');
  assert.strictEqual(calls, 1);
});

test('retryable: retries retryable errors up to attempts limit', async (t) => {
  const clock = fakeClock(t);
  let calls = 0;
  const p = retryable(
    async () => {
      calls++;
      if (calls < 3) throw new Error('transient');
      return 'ok';
    },
    { attempts: 3, backoffMs: [10, 20], isRetryable: () => true },
  );
  // Attempt 1 rejects → schedule 10ms.
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(clock.scheduled.length, 1);
  clock.tick();
  await new Promise((r) => setImmediate(r));
  clock.tick();
  const r = await p;
  assert.strictEqual(r, 'ok');
  assert.strictEqual(calls, 3);
});

test('retryable: rejects with final error after exhausting attempts', async (t) => {
  const clock = fakeClock(t);
  let calls = 0;
  const p = retryable(
    async () => {
      calls++;
      throw new Error(`try-${calls}`);
    },
    { attempts: 3, backoffMs: [10, 20], isRetryable: () => true },
  ).catch((e) => e);
  for (let i = 0; i < 2; i++) {
    await new Promise((r) => setImmediate(r));
    clock.tick();
  }
  const err = await p;
  assert.strictEqual(err.message, 'try-3');
  assert.strictEqual(calls, 3);
});

test('retryable: fails immediately on non-retryable error', async () => {
  let calls = 0;
  const err = await retryable(
    async () => {
      calls++;
      const e = new Error('auth');
      e.code = -32601;
      throw e;
    },
    { attempts: 3, backoffMs: [10, 20], isRetryable: (e) => e.code !== -32601 },
  ).catch((e) => e);
  assert.strictEqual(err.message, 'auth');
  assert.strictEqual(calls, 1);
});

test('retryable: disabled runs fn exactly once regardless of retryability', async () => {
  let calls = 0;
  const err = await retryable(
    async () => { calls++; throw new Error('boom'); },
    { attempts: 3, backoffMs: [10], isRetryable: () => true, disabled: true },
  ).catch((e) => e);
  assert.strictEqual(err.message, 'boom');
  assert.strictEqual(calls, 1);
});

test('retryable: onAttempt callback fires between retries', async (t) => {
  const clock = fakeClock(t);
  const attempts = [];
  const p = retryable(
    async () => { throw new Error('x'); },
    {
      attempts: 3,
      backoffMs: [10, 20],
      isRetryable: () => true,
      onAttempt: (n, err) => attempts.push({ n, msg: err.message }),
    },
  ).catch((e) => e);
  for (let i = 0; i < 2; i++) {
    await new Promise((r) => setImmediate(r));
    clock.tick();
  }
  await p;
  // onAttempt called before each RETRY (not before attempt 1, and not after
  // the final failure). With attempts=3 that's onAttempt(2, err), onAttempt(3, err).
  assert.deepStrictEqual(attempts, [
    { n: 2, msg: 'x' },
    { n: 3, msg: 'x' },
  ]);
});
