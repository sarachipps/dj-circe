const test = require('node:test');
const assert = require('node:assert');
const child_process = require('node:child_process');
const { detect, install } = require('../hermesInstall');

function stubSpawn(t, impl) {
  const orig = child_process.spawn;
  child_process.spawn = impl;
  t.after(() => { child_process.spawn = orig; });
}

function fakeChild({ stdout = '', stderr = '', code = 0, err = null } = {}) {
  const handlers = {};
  const child = {
    stdout: { on: (evt, fn) => (handlers[`stdout:${evt}`] = fn) },
    stderr: { on: (evt, fn) => (handlers[`stderr:${evt}`] = fn) },
    on: (evt, fn) => (handlers[evt] = fn),
  };
  setImmediate(() => {
    if (err) {
      handlers['error'] && handlers['error'](err);
      return;
    }
    if (stdout) handlers['stdout:data'] && handlers['stdout:data'](Buffer.from(stdout));
    if (stderr) handlers['stderr:data'] && handlers['stderr:data'](Buffer.from(stderr));
    handlers['close'] && handlers['close'](code);
  });
  return child;
}

test('detect: returns present=true and parses version on success', async (t) => {
  stubSpawn(t, () => fakeChild({ stdout: 'hermes 1.2.3\n', code: 0 }));
  const result = await detect();
  assert.strictEqual(result.present, true);
  assert.strictEqual(result.version, '1.2.3');
});

test('detect: returns present=false when spawn ENOENTs', async (t) => {
  stubSpawn(t, () => fakeChild({ err: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }));
  const result = await detect();
  assert.strictEqual(result.present, false);
});

test('detect: returns present=false when hermes exits nonzero', async (t) => {
  stubSpawn(t, () => fakeChild({ stderr: 'broken\n', code: 1 }));
  const result = await detect();
  assert.strictEqual(result.present, false);
});

test('install: resolves ok:true on exit code 0', async (t) => {
  stubSpawn(t, () => fakeChild({ stdout: 'installed\n', code: 0 }));
  const result = await install(() => {});
  assert.deepStrictEqual(result, { ok: true });
});

test('install: emits each non-empty stdout line to onProgress', async (t) => {
  stubSpawn(t, () => fakeChild({ stdout: 'first\nsecond\n\nthird\n', code: 0 }));
  const lines = [];
  await install((line) => lines.push(line));
  assert.deepStrictEqual(lines, ['first', 'second', 'third']);
});

test('install: emits stderr lines through the same onProgress channel', async (t) => {
  stubSpawn(t, () => fakeChild({ stderr: 'warning\n', code: 0 }));
  const lines = [];
  await install((line) => lines.push(line));
  assert.deepStrictEqual(lines, ['warning']);
});

test('install: resolves ok:false with exit code on nonzero exit', async (t) => {
  stubSpawn(t, () => fakeChild({ stderr: 'boom\n', code: 42 }));
  const result = await install(() => {});
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /42/);
});

test('install: resolves ok:false when spawn emits error event', async (t) => {
  stubSpawn(t, () => fakeChild({ err: new Error('spawn ENOENT bash') }));
  const result = await install(() => {});
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /ENOENT/);
});
