const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const sharp = require('sharp');
const {
  slugify,
  createOrchestrator,
  writeFirstTasks,
  writeBedrockConfig,
  writeDjToolingReference,
  DJ_TOOLING_REFERENCE_PATH,
} = require('../profileWriter');

function withTmp(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'circe-pw-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  return tmp;
}

function fakeSpawn(recordedCalls, behavior) {
  return (bin, args, opts) => {
    recordedCalls.push({ bin, args, env: opts && opts.env });
    const handlers = {};
    const child = {
      stdout: { on: (evt, fn) => (handlers[`stdout:${evt}`] = fn) },
      stderr: { on: (evt, fn) => (handlers[`stderr:${evt}`] = fn) },
      on: (evt, fn) => (handlers[evt] = fn),
    };
    setImmediate(() => {
      const b = behavior(args);
      if (b.err) {
        handlers['error'] && handlers['error'](b.err);
        return;
      }
      if (b.stderr) handlers['stderr:data'] && handlers['stderr:data'](Buffer.from(b.stderr));
      if (b.stdout) handlers['stdout:data'] && handlers['stdout:data'](Buffer.from(b.stdout));
      handlers['close'] && handlers['close'](b.code ?? 0);
    });
    return child;
  };
}

test('slugify: basic cases', () => {
  assert.strictEqual(slugify('Jean-Luc Picard'), 'jean-luc-picard');
  assert.strictEqual(slugify('Data'), 'data');
  assert.strictEqual(slugify("Miles O'Brien"), 'miles-obrien');
  assert.strictEqual(slugify('  Q  '), 'q');
});

test('createOrchestrator: happy path — creates profile and writes files', async (t) => {
  const tmp = withTmp(t);
  const bytes = await sharp({
    create: { width: 512, height: 512, channels: 3, background: { r: 0, g: 0, b: 0 } },
  }).png().toBuffer();
  const calls = [];
  const spawnImpl = fakeSpawn(calls, () => {
    // Simulate hermes profile create by making the directory it would.
    fs.mkdirSync(path.join(tmp, 'profiles', 'picard'), { recursive: true });
    return { code: 0 };
  });
  const r = await createOrchestrator({
    slug: 'picard',
    oneLiner: 'Starfleet captain',
    soulMd: '# Picard\n',
    avatarBytes: bytes,
    avatarSource: 'https://en.wikipedia.org/wiki/Jean-Luc_Picard',
    hermesHome: tmp,
    hermesBin: '/fake/hermes',
    spawnImpl,
  });
  assert.strictEqual(r.ok, true);
  const dir = path.join(tmp, 'profiles', 'picard');
  assert.ok(fs.existsSync(path.join(dir, 'SOUL.md')));
  assert.ok(fs.existsSync(path.join(dir, 'avatar.png')));
  assert.ok(fs.existsSync(path.join(dir, 'CHANGELOG.md')));
  const soul = fs.readFileSync(path.join(dir, 'SOUL.md'), 'utf8');
  assert.match(soul, /avatar-source: https:\/\/en\.wikipedia\.org/);
  const changelog = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /^# CHANGELOG/);
  const createCall = calls[0];
  assert.strictEqual(createCall.env.HERMES_HOME, tmp);
  assert.deepStrictEqual(createCall.args.slice(0, 3), ['profile', 'create', 'picard']);
});

test('createOrchestrator: profile create fails → returns error, no rollback', async (t) => {
  const tmp = withTmp(t);
  const bytes = await sharp({
    create: { width: 512, height: 512, channels: 3, background: { r: 0, g: 0, b: 0 } },
  }).png().toBuffer();
  const calls = [];
  const spawnImpl = fakeSpawn(calls, (args) => {
    if (args[1] === 'create') return { code: 1, stderr: 'name in use' };
    return { code: 0 };
  });
  const r = await createOrchestrator({
    slug: 'picard',
    oneLiner: 'x',
    soulMd: '# x\n',
    avatarBytes: bytes,
    avatarSource: null,
    hermesHome: tmp,
    hermesBin: '/fake/hermes',
    spawnImpl,
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /name in use|create/i);
  assert.strictEqual(r.rolledBack, false);
  assert.strictEqual(calls.length, 1);
});

test('createOrchestrator: post-create write failure → rollback via hermes profile delete', async (t) => {
  const tmp = withTmp(t);
  const bytes = await sharp({
    create: { width: 512, height: 512, channels: 3, background: { r: 0, g: 0, b: 0 } },
  }).png().toBuffer();
  const calls = [];
  const spawnImpl = fakeSpawn(calls, (args) => {
    if (args[1] === 'create') {
      // Do NOT create the directory — this forces avatar.png write to fail.
      return { code: 0 };
    }
    if (args[1] === 'delete') return { code: 0 };
    return { code: 0 };
  });
  const hermesHome = path.join(tmp, 'does-not-exist-and-cant-be-made', '\0invalid');
  const r = await createOrchestrator({
    slug: 'picard',
    oneLiner: 'x',
    soulMd: '# x\n',
    avatarBytes: bytes,
    avatarSource: null,
    hermesHome,
    hermesBin: '/fake/hermes',
    spawnImpl,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.rolledBack, true);
  // Should have tried create AND delete.
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(calls[1].args.slice(0, 3), ['profile', 'delete', 'picard']);
  assert.strictEqual(calls[1].env.HERMES_HOME, hermesHome);
});

test('writeFirstTasks: writes file into profile dir', async (t) => {
  const tmp = withTmp(t);
  const dir = path.join(tmp, 'profiles', 'picard');
  fs.mkdirSync(dir, { recursive: true });
  const r = await writeFirstTasks(dir, '# first tasks\n');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'first-tasks.md'), 'utf8'), '# first tasks\n');
});

test('writeDjToolingReference: copies the shipped reference into the profile dir', async (t) => {
  const tmp = withTmp(t);
  const dir = path.join(tmp, 'profiles', 'picard');
  fs.mkdirSync(dir, { recursive: true });
  const r = await writeDjToolingReference({ profileDir: dir });
  assert.strictEqual(r.ok, true);
  const written = fs.readFileSync(path.join(dir, 'dj-tooling.md'), 'utf8');
  // Sanity: matches the shipped source byte-for-byte.
  const shipped = fs.readFileSync(DJ_TOOLING_REFERENCE_PATH, 'utf8');
  assert.strictEqual(written, shipped);
  // Sanity: covers the load-bearing Google Workspace guidance.
  assert.match(written, /gemini-cli-extensions\/workspace/);
  assert.match(written, /DJ org-policy blockers/);
  assert.match(written, /do not apply to this MCP/);
});

test('writeDjToolingReference: honors an override sourcePath', async (t) => {
  const tmp = withTmp(t);
  const dir = path.join(tmp, 'profiles', 'picard');
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(tmp, 'custom-ref.md');
  fs.writeFileSync(src, '# custom reference\n');
  const r = await writeDjToolingReference({ profileDir: dir, sourcePath: src });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(
    fs.readFileSync(path.join(dir, 'dj-tooling.md'), 'utf8'),
    '# custom reference\n',
  );
});

test('writeDjToolingReference: returns error when source cannot be read', async (t) => {
  const tmp = withTmp(t);
  const dir = path.join(tmp, 'profiles', 'picard');
  fs.mkdirSync(dir, { recursive: true });
  const r = await writeDjToolingReference({
    profileDir: dir,
    sourcePath: path.join(tmp, 'does-not-exist.md'),
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /ENOENT|no such file/i);
});

test('writeBedrockConfig: writes config.yaml and .env with correct values', async (t) => {
  const tmp = withTmp(t);
  const dir = path.join(tmp, 'profiles', 'picard');
  fs.mkdirSync(dir, { recursive: true });
  const r = await writeBedrockConfig({ profileDir: dir, apiKey: 'sk-test-abc' });
  assert.strictEqual(r.ok, true);
  const yaml = fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8');
  // Provider block.
  assert.match(yaml, /provider: dj-bedrock/);
  assert.match(yaml, /base_url: https:\/\/bedrock-mantle\.us-east-1\.api\.aws\/anthropic/);
  assert.match(yaml, /default: anthropic\.claude-sonnet-5/);
  assert.match(yaml, /key_env: ANTHROPIC_API_KEY/);
  assert.match(yaml, /api_mode: anthropic_messages/);
  // Toolset: delegation and vision are on by default alongside the base 11.
  assert.match(yaml, /^\s+- delegation$/m);
  assert.match(yaml, /^\s+- vision$/m);
  // Perf defaults from config-defaults.yaml.
  assert.match(yaml, /reasoning_effort: medium/);
  assert.match(yaml, /max_turns: 150/);
  assert.match(yaml, /prompt_caching:/);
  assert.match(yaml, /cache_ttl: 5m/);
  assert.match(yaml, /compression:/);
  assert.match(yaml, /tool_loop_guardrails:/);
  assert.match(yaml, /delegation:\n\s+max_iterations: 50/);
  assert.match(yaml, /group_sessions_per_user: true/);
  const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert.strictEqual(env.trim(), 'ANTHROPIC_API_KEY=sk-test-abc');
  assert.doesNotMatch(env, /AWS_/);
});

test('writeBedrockConfig: returns error when defaults file is unreadable', async (t) => {
  const tmp = withTmp(t);
  const dir = path.join(tmp, 'profiles', 'picard');
  fs.mkdirSync(dir, { recursive: true });
  const r = await writeBedrockConfig({
    profileDir: dir,
    apiKey: 'sk',
    defaultsPath: path.join(tmp, 'nope.yaml'),
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /could not read config defaults/i);
  // Neither file should have been created if we bailed early.
  assert.strictEqual(fs.existsSync(path.join(dir, 'config.yaml')), false);
  assert.strictEqual(fs.existsSync(path.join(dir, '.env')), false);
});
