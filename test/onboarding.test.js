const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { firstRunNeeded } = require('../onboarding/main');

function mkTmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'circe-ob-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeState(stateDir, obj) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify(obj));
}

function mkProfile(hermesHome, name) {
  fs.mkdirSync(path.join(hermesHome, 'profiles', name), { recursive: true });
}

test('firstRunNeeded: returns "skip" when firstRunComplete=true', (t) => {
  const stateDir = mkTmp(t);
  const hermesHome = mkTmp(t);
  writeState(stateDir, { profiles: {}, firstRunComplete: true });
  assert.strictEqual(firstRunNeeded(stateDir, hermesHome), 'skip');
});

test('firstRunNeeded: returns "wizard" when no state and no profiles', (t) => {
  const stateDir = mkTmp(t);
  const hermesHome = mkTmp(t);
  assert.strictEqual(firstRunNeeded(stateDir, hermesHome), 'wizard');
});

test('firstRunNeeded: returns "wizard" when only _scratch profile exists', (t) => {
  const stateDir = mkTmp(t);
  const hermesHome = mkTmp(t);
  mkProfile(hermesHome, '_scratch');
  assert.strictEqual(firstRunNeeded(stateDir, hermesHome), 'wizard');
});

test('firstRunNeeded: returns "adopt" when state lacks flag but profiles exist', (t) => {
  const stateDir = mkTmp(t);
  const hermesHome = mkTmp(t);
  mkProfile(hermesHome, 'picard');
  mkProfile(hermesHome, 'data');
  mkProfile(hermesHome, '_scratch');
  writeState(stateDir, { profiles: { picard: { tabs: [] } } });
  assert.strictEqual(firstRunNeeded(stateDir, hermesHome), 'adopt');
});

test('firstRunNeeded: returns "adopt" when no state file but profiles exist', (t) => {
  const stateDir = mkTmp(t);
  const hermesHome = mkTmp(t);
  mkProfile(hermesHome, 'picard');
  assert.strictEqual(firstRunNeeded(stateDir, hermesHome), 'adopt');
});
