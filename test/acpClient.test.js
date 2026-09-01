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
