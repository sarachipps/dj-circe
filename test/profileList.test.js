const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parseProfilesList } = require('../profileList');

function mkTmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'circe-pl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const HERMES_LIST_OUTPUT = [
  '  Profile             Model',
  '  ─────────────────   ─────────────────',
  '◆ default             anthropic.claude-opus-4-7',
  '  data                anthropic.claude-sonnet-5',
  '  picard              anthropic.claude-opus-4-7',
  '',
].join('\n');

test('parseProfilesList: filters default when no profiles/default/ exists', (t) => {
  const home = mkTmpHome(t);
  fs.mkdirSync(path.join(home, 'profiles', 'data'), { recursive: true });
  fs.mkdirSync(path.join(home, 'profiles', 'picard'), { recursive: true });
  const result = parseProfilesList(HERMES_LIST_OUTPUT, home);
  assert.deepStrictEqual(
    result.map((p) => p.name),
    ['data', 'picard'],
  );
});

test('parseProfilesList: includes default when profiles/default/ exists', (t) => {
  const home = mkTmpHome(t);
  fs.mkdirSync(path.join(home, 'profiles', 'default'), { recursive: true });
  fs.mkdirSync(path.join(home, 'profiles', 'data'), { recursive: true });
  const result = parseProfilesList(HERMES_LIST_OUTPUT, home);
  const names = result.map((p) => p.name).sort();
  assert.deepStrictEqual(names, ['data', 'default', 'picard'].sort());
});

test('parseProfilesList: non-default profiles are never filtered by directory check', (t) => {
  const home = mkTmpHome(t);
  // Intentionally do NOT create profiles/picard/ — picard should still appear.
  const result = parseProfilesList(HERMES_LIST_OUTPUT, home);
  const names = result.map((p) => p.name);
  assert.ok(names.includes('picard'), 'picard should be in list even without dir');
});

test('parseProfilesList: strips ANSI color codes', (t) => {
  const home = mkTmpHome(t);
  fs.mkdirSync(path.join(home, 'profiles', 'data'), { recursive: true });
  const colored =
    '  \x1b[36mdata\x1b[0m                \x1b[33manthropic.claude-sonnet-5\x1b[0m\n';
  const result = parseProfilesList(colored, home);
  assert.deepStrictEqual(result, [{ name: 'data', model: 'anthropic.claude-sonnet-5' }]);
});

test('parseProfilesList: skips header rows', (t) => {
  const home = mkTmpHome(t);
  const result = parseProfilesList(HERMES_LIST_OUTPUT, home);
  assert.ok(result.every((p) => p.name !== 'Profile' && !p.name.startsWith('─')));
});
