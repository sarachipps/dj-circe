# Circe Reliability Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement six reliability fixes so a colleague on a Zscaler-intercepted DJ machine can complete Circe onboarding, so opaque "Internal error" tiles surface real detail, so latent env divergences don't bite the next non-default-HERMES_HOME launch, so transient session-init failures self-heal in the pre-first-message window, so upgrades over legacy state files skip phantom onboarding, and so Hermes's built-in `default` scaffold never opens as a Circe tile.

**Architecture:** Additive changes to existing modules plus two new small utilities (`retryUtil.js`, `caTrust.js`) and one small extraction (`profileList.js`) so the profile-filter logic becomes testable outside Electron. `onboarding/main.js`'s `firstRunNeeded` gains a second signal (existing-profiles adoption). No renderer restructuring — the existing "error"-class message row absorbs longer strings unchanged. No IPC contract changes visible to the renderer beyond one added error payload field.

**Tech Stack:** Node built-ins (`child_process`, `fs`, `path`, `os`), `electron-log` (already a dep), `node:test`, existing macOS `security` CLI, existing `hermes` CLI.

## Global Constraints

- Node built-ins only for new code — no new npm dependencies (repo currently ships `electron`, `electron-log`, `marked`, `sharp` only).
- Tests use `node:test` and live under `test/*.test.js`; run via `npm test`.
- Every new spawn passes `env: { ...process.env, ... }` so parent env inherits.
- Never log the Bedrock token contents — only "set:Nchars" or "(UNSET)", matching the existing diagnostic pattern at `acpClient.js:122-126`.
- Never touch `~/.hermes` or `~/.hermes-tiles` from tests — set `HERMES_HOME` / `HERMES_TILES_STATE_DIR` to temp dirs.
- Retries are bounded per the spec's Non-goals: (a) never retry after any user activity, (b) never retry auth failures.
- `CIRCE_NO_RETRY=1` env var must disable all retry loops (both ACP and Bedrock).
- `main.js` requires Electron at module top, so it is not loadable in `node:test`. Extract testable logic into standalone modules; main.js becomes a thin wire-up.
- The `default`-filter fix must scope to `name === 'default'` — no other profile name gets the directory-existence check.

---

### Task 1: Honor `HERMES_HOME` in `loadProfileEnv` (Fix 3)

**Files:**
- Modify: `acpClient.js:13-39`
- Test: `test/acpClient.test.js` (new file)

**Interfaces:**
- Consumes: `process.env.HERMES_HOME` (string, optional), `os.homedir()`.
- Produces: `loadProfileEnv(profile: string) → Record<string, string>` — behavior unchanged when `HERMES_HOME` is unset; reads from `<HERMES_HOME>/profiles/<profile>/.env` when set.

- [ ] **Step 1: Create the test file and write four failing tests**

Create `test/acpClient.test.js` with:

```js
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
```

- [ ] **Step 2: Run tests, expect all four to fail**

```
npm test -- --test-name-pattern="loadProfileEnv"
```

Expected: all four fail with `__loadProfileEnvForTest is not a function` (not yet exported).

- [ ] **Step 3: Update `acpClient.js`**

Change `acpClient.js:13-39` from:

```js
const HERMES_BIN = path.join(os.homedir(), '.local', 'bin', 'hermes');

// Parse a Hermes-style .env file (KEY=value per line, no `export` prefix, no
// interpolation, `#` and blank lines ignored). Values may be single- or
// double-quoted. Returns {} on any read/parse failure — spawn continues
// with whatever env is already present.
function loadProfileEnv(profile) {
  const envPath = path.join(os.homedir(), '.hermes', 'profiles', profile, '.env');
  try {
    // …unchanged body…
```

to:

```js
const HERMES_BIN = path.join(os.homedir(), '.local', 'bin', 'hermes');
const HERMES_HOME = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');

// Parse a Hermes-style .env file (KEY=value per line, no `export` prefix, no
// interpolation, `#` and blank lines ignored). Values may be single- or
// double-quoted. Returns {} on any read/parse failure — spawn continues
// with whatever env is already present.
function loadProfileEnv(profile) {
  const envPath = path.join(HERMES_HOME, 'profiles', profile, '.env');
  try {
    // …unchanged body…
```

Add to `module.exports` at `acpClient.js:347`:

```js
module.exports = { AcpClient, __loadProfileEnvForTest: loadProfileEnv };
```

- [ ] **Step 4: Run the four tests and full suite**

```
npm test -- --test-name-pattern="loadProfileEnv"
npm test
```

Expected: four `loadProfileEnv` tests pass; every other existing test still passes.

- [ ] **Step 5: Commit**

```bash
git add acpClient.js test/acpClient.test.js
git commit -m "$(cat <<'EOF'
fix(acp): honor HERMES_HOME in loadProfileEnv

Was hardcoded to ~/.hermes; diverged from main.js:23's env-var-respecting
path. Latent today (default HERMES_HOME matches), but would break any
launch pointing HERMES_HOME elsewhere — profile .env with the Bedrock key
would be silently missed and session/new would fail at auth.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Surface structured ACP error data (Fix 2)

**Files:**
- Modify: `acpClient.js:317-344` (the `_onStdout` error branch)
- Modify: `main.js:426-458` (IPC handlers for `acp:*` — serialize `code`/`data`)
- Modify: `renderer.js:315-320, 429-431` (display extra detail if present)
- Test: `test/acpClient.test.js` (extend the file from Task 1)

**Interfaces:**
- Consumes: JSON-RPC error payload `{ code: number, message: string, data?: any }`.
- Produces: `Error` object with `.message`, `.code`, `.data` attached. `main.js`'s IPC handlers convert this into a plain object `{ message, code, data }` when propagating to the renderer via `throw`; Electron's default serializer only carries `.message`, so we throw a hand-serialized error string.

- [ ] **Step 1: Add failing tests to `test/acpClient.test.js`**

Append to the file:

```js
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
```

- [ ] **Step 2: Run tests, expect three failures**

```
npm test -- --test-name-pattern="acpClient: rejection"
```

Expected: all three fail (either `err.code` is `undefined` or `err.data` is `undefined`).

- [ ] **Step 3: Update `acpClient.js:334`**

Replace `acpClient.js:334` (single line):

```js
        if (msg.error) p.reject(new Error(msg.error.message || 'rpc error'));
```

with:

```js
        if (msg.error) {
          const err = new Error(msg.error.message || 'rpc error');
          err.code = msg.error.code;
          err.data = msg.error.data;
          log.error(`acp rpc error [${this.profile}]`, msg.error);
          p.reject(err);
        }
```

Also confirm `log.error` is available: the module-top `log` shim (lines 6-11) doesn't set an `.error` method. Update the shim to include it:

```js
let log;
try {
  log = require('electron-log/main');
} catch (_) {
  log = {
    info: (...a) => console.log(...a),
    warn: (...a) => console.warn(...a),
    error: (...a) => console.error(...a),
  };
}
```

- [ ] **Step 4: Run the three tests**

```
npm test -- --test-name-pattern="acpClient: rejection"
```

Expected: all three pass.

- [ ] **Step 5: Update `main.js` IPC handlers to serialize `code`/`data`**

Replace `main.js:426-431`:

```js
ipcMain.handle('acp:newSession', async (evt) => {
  const client = tileClients.get(evt.sender.id);
  if (!client) throw new Error('no ACP client for this window');
  const sessionId = await client.newSession();
  return { sessionId };
});
```

with:

```js
function serializeAcpError(err) {
  const payload = { message: err.message || String(err) };
  if (err.code !== undefined) payload.code = err.code;
  if (err.data !== undefined) payload.data = err.data;
  return payload;
}

ipcMain.handle('acp:newSession', async (evt) => {
  const client = tileClients.get(evt.sender.id);
  if (!client) throw new Error('no ACP client for this window');
  try {
    const sessionId = await client.newSession();
    return { sessionId };
  } catch (err) {
    log.error(`acp:newSession failed`, err);
    // Encode structured detail in the thrown message so Electron's default
    // IPC error serializer (which drops non-message fields) still delivers it.
    // Renderer parses via JSON.parse fallback in renderer.js.
    const e = new Error(JSON.stringify(serializeAcpError(err)));
    e.name = 'AcpError';
    throw e;
  }
});
```

Similarly wrap `acp:loadSession` and `acp:prompt` at `main.js:433-450`. For `loadSession` (which already returns `{ ok: false, error }`), extend to also carry `code` and `data`:

Replace `main.js:433-443`:

```js
ipcMain.handle('acp:loadSession', async (evt, { sessionId }) => {
  const client = tileClients.get(evt.sender.id);
  if (!client) throw new Error('no ACP client for this window');
  try {
    await client.loadSession(sessionId);
    return { ok: true, sessionId };
  } catch (err) {
    log.warn(`loadSession(${sessionId}) failed: ${err.message}`);
    return { ok: false, ...serializeAcpError(err) };
  }
});
```

Replace `main.js:445-450`:

```js
ipcMain.handle('acp:prompt', async (evt, { sessionId, text }) => {
  const client = tileClients.get(evt.sender.id);
  if (!client) throw new Error('no ACP client for this window');
  try {
    await client.prompt(sessionId, text);
    return { ok: true };
  } catch (err) {
    log.error(`acp:prompt failed`, err);
    const e = new Error(JSON.stringify(serializeAcpError(err)));
    e.name = 'AcpError';
    throw e;
  }
});
```

- [ ] **Step 6: Update `renderer.js` to display structured detail**

Add a helper near the top of `renderer.js` (right after the `renderMarkdown`/`setMessageContent` block, before `const transcript = ...` at line 28):

```js
function formatAcpError(err) {
  const raw = err && (err.message || String(err));
  if (!raw) return 'ACP error';
  // If main.js wrapped a structured error, message is JSON.
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.message) {
      const parts = [parsed.message];
      const detail =
        (parsed.data && (parsed.data.detail || parsed.data.traceback)) || null;
      if (detail) parts.push(String(detail));
      if (parsed.code !== undefined) parts.push(`(code ${parsed.code})`);
      return parts.join('\n\n');
    }
  } catch {}
  return raw;
}
```

Replace `renderer.js:319`:

```js
    appendMessage(tab, 'agent', err.message || String(err), 'error');
```

with:

```js
    appendMessage(tab, 'agent', formatAcpError(err), 'error');
```

Replace `renderer.js:609`:

```js
      appendMessage(tab, 'agent', err.message || String(err), 'error');
```

with:

```js
      appendMessage(tab, 'agent', formatAcpError(err), 'error');
```

Leave `renderer.js:431` (the `acp:error` event handler at `onError`) as-is — that channel carries only a `message` string today; no structured payload flows through it yet.

- [ ] **Step 7: Run the full suite**

```
npm test
```

Expected: everything green (three new tests plus all pre-existing).

- [ ] **Step 8: Manual smoke test**

Since we can't easily inject a real JSON-RPC error without a broken Hermes config, defer manual verification to Task 3+ real-world runs. This step is a placeholder to remind implementers to visually confirm at the end of the plan that a real error surface looks reasonable.

Run: `npm test` — no manual smoke needed to close this task.

- [ ] **Step 9: Commit**

```bash
git add acpClient.js main.js renderer.js test/acpClient.test.js
git commit -m "$(cat <<'EOF'
fix(acp): surface structured JSON-RPC error data end-to-end

Was: acpClient dropped err.code and err.data on the floor, so a Hermes-side
error reached the tile as "Internal error" with no traceback, no code, no
subsystem name — required a diagnostic-bundle command over Slack.

Now: acpClient attaches code + data to the rejected Error, logs the full
payload via electron-log, main.js serializes {message, code, data} through
the IPC boundary (Electron's default error serializer drops non-message
fields, so we JSON.stringify into message and parse in the renderer), and
renderer.js displays data.detail or data.traceback under the message when
present.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Filter Hermes built-in `default` scaffold (Fix 6)

**Files:**
- Create: `profileList.js`
- Modify: `main.js:97-117` (call the new module) and `main.js:142-151` (remove `hasAvatar` — dead code after filter change)
- Test: `test/profileList.test.js`

**Interfaces:**
- Consumes: raw output of `hermes profile list` (string), `hermesHome` (string).
- Produces:
  - `parseProfilesList(text: string, hermesHome: string) → Array<{ name: string, model: string }>` — pure parser + filter, testable without Electron.
  - `loadProfiles(runHermes: (args: string[]) => Promise<string>, hermesHome: string) → Promise<Array<{ name, model }>>` — spawn wrapper.

- [ ] **Step 1: Write failing tests in `test/profileList.test.js`**

```js
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
```

- [ ] **Step 2: Run tests, expect failure**

```
npm test -- --test-name-pattern="parseProfilesList"
```

Expected: all five fail with `Cannot find module '../profileList'`.

- [ ] **Step 3: Create `profileList.js`**

```js
const fs = require('fs');
const path = require('path');

// Parse `hermes profile list` output into {name, model} entries, filtering
// out Hermes's built-in `default` scaffold unless the user actually has a
// Circe-managed profiles/default/ directory. Non-default names are never
// filtered — presence/absence of their directory doesn't gate them (they
// may be listed by hermes for reasons Circe doesn't track).
function parseProfilesList(text, hermesHome) {
  const profiles = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    if (!/^\s*[◆◇•\s]/.test(line)) continue;
    const m = line.match(/^\s*[◆◇•]?\s*([A-Za-z0-9_-]+)\s+(\S+)/);
    if (!m) continue;
    const name = m[1];
    const model = m[2];
    if (name === 'Profile' || name.startsWith('─')) continue;
    // Hermes ships a built-in `default` entry (marked ◆) as its root config.
    // It has no Circe-written provider block, so hitting `session/new` on it
    // yields "Internal error" / 529 from whatever fallback provider Hermes
    // picks. Only surface `default` if the user has an actual profile dir.
    if (name === 'default') {
      const dir = path.join(hermesHome, 'profiles', 'default');
      if (!fs.existsSync(dir)) continue;
    }
    profiles.push({ name, model });
  }
  return profiles;
}

async function loadProfiles(runHermes, hermesHome) {
  const out = await runHermes(['profile', 'list']);
  return parseProfilesList(out, hermesHome);
}

module.exports = { parseProfilesList, loadProfiles };
```

- [ ] **Step 4: Run tests, expect success**

```
npm test -- --test-name-pattern="parseProfilesList"
```

Expected: all five pass.

- [ ] **Step 5: Wire `main.js` to use `profileList.js` and delete `hasAvatar`**

Replace `main.js:97-117`:

```js
async function loadProfiles() {
  const out = await runHermes(['profile', 'list']);
  const profiles = [];
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    if (!/^\s*[◆◇•\s]/.test(line)) continue;
    const m = line.match(/^\s*[◆◇•]?\s*([A-Za-z0-9_-]+)\s+(\S+)/);
    if (!m) continue;
    const name = m[1];
    const model = m[2];
    if (name === 'Profile' || name.startsWith('─')) continue;
    // Hermes ships a built-in `default` scaffold with a boilerplate SOUL.md
    // but no avatar. Circe onboarding writes avatar.{png,jpg,…} for every
    // profile it creates, so use avatar presence as the "this is a real
    // Circe tile" signal — otherwise a fresh install shows a blank tile
    // next to the real Orchestrator.
    if (name === 'default' && !hasAvatar(name)) continue;
    profiles.push({ name, model });
  }
  return profiles;
}
```

with:

```js
const { loadProfiles: loadProfilesFromList } = require('./profileList');

async function loadProfiles() {
  return loadProfilesFromList(runHermes, HERMES_HOME);
}
```

Delete `main.js:142-151` (the `hasAvatar` function) entirely. Verify no other caller — the grep in Step 6 catches this.

Leave `AVATAR_MIMES` and `loadAvatarDataUrl` (lines 134-168) intact — they're used by the `avatar:get` IPC handler.

- [ ] **Step 6: Verify `hasAvatar` is fully removed**

```
grep -rn "hasAvatar" .
```

Expected: no matches under the working tree (`node_modules` excluded from the grep by default in most setups; run with `--exclude-dir=node_modules` if unsure).

- [ ] **Step 7: Run the full suite**

```
npm test
```

Expected: everything green.

- [ ] **Step 8: Manual on-the-author's-machine test**

```
npm start
```

Expected: exactly five tiles open (`data`, `geordi`, `locutus`, `troi`, `wesley`), NOT six. No `[acp:default]` process in the electron log. No 529 error.

- [ ] **Step 9: Commit**

```bash
git add profileList.js main.js test/profileList.test.js
git commit -m "$(cat <<'EOF'
fix(profiles): filter Hermes built-in default scaffold by directory check

Was: main.js kept the ◆default entry from `hermes profile list` unless
~/.hermes/avatar.{png,jpg,…} was absent. Hermes ships an avatar.png at
that path, so the filter never fired, Circe spawned a [acp:default] tile
against Hermes's root config (which has no Bedrock provider block), and
session/new on that tile returned 529 OverloadedError. That surfaced as
"Internal error" because of the opaque-ACP-error bug (fixed in the previous
commit).

Now: extract loadProfiles into a testable profileList module, filter the
`default` entry only when <HERMES_HOME>/profiles/default/ doesn't exist.
avatar.png presence is no longer load-bearing.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Adopt legacy state files instead of re-onboarding (Fix 5)

**Files:**
- Modify: `onboarding/main.js:19-26` (`firstRunNeeded`)
- Modify: `main.js:352-391` (whenReady handler)
- Test: `test/onboarding.test.js` (new file)

**Interfaces:**
- Consumes: `stateDir` (string), `hermesHome` (string), filesystem state.
- Produces: `firstRunNeeded(stateDir: string, hermesHome: string) → 'wizard' | 'skip' | 'adopt'`
  - `'wizard'` — no `firstRunComplete` AND no non-`_scratch` profiles → user is brand new, run wizard
  - `'skip'` — `firstRunComplete === true` → normal launch
  - `'adopt'` — no `firstRunComplete` but non-`_scratch` profiles exist → user upgraded over legacy state; back-fill and skip wizard
- Adoption also writes `orchestratorProfile` to the first non-`_scratch` profile directory alphabetically.

- [ ] **Step 1: Write failing tests in `test/onboarding.test.js`**

```js
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
```

- [ ] **Step 2: Run tests, expect failures**

```
npm test -- --test-name-pattern="firstRunNeeded"
```

Expected: at least the "adopt" cases fail (current signature returns a boolean, not a mode; missing state.json returns `true` = wizard, which contradicts the new adopt path).

- [ ] **Step 3: Update `onboarding/main.js` `firstRunNeeded`**

Replace `onboarding/main.js:19-26`:

```js
function firstRunNeeded(stateDir) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
    return s.firstRunComplete !== true;
  } catch {
    return true;
  }
}
```

with:

```js
// Returns 'skip' | 'wizard' | 'adopt'.
//   skip   — state.firstRunComplete === true (normal launch)
//   wizard — no completion flag AND no existing user profiles (brand new)
//   adopt  — no completion flag BUT profiles exist (upgrade over legacy state)
function firstRunNeeded(stateDir, hermesHome) {
  let firstRunComplete = false;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
    firstRunComplete = s.firstRunComplete === true;
  } catch {}
  if (firstRunComplete) return 'skip';
  const realProfiles = listRealProfiles(hermesHome);
  if (realProfiles.length > 0) return 'adopt';
  return 'wizard';
}

function listRealProfiles(hermesHome) {
  const dir = path.join(hermesHome, 'profiles');
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && e.name !== '_scratch')
    .map((e) => e.name)
    .sort();
}
```

Also export `listRealProfiles` so main.js can pick the orchestratorProfile:

```js
module.exports = { runOnboarding, firstRunNeeded, listRealProfiles };
```

- [ ] **Step 4: Run tests, expect success**

```
npm test -- --test-name-pattern="firstRunNeeded"
```

Expected: all five pass.

- [ ] **Step 5: Update `main.js` whenReady handler**

Replace `main.js:352-391`:

```js
app.whenReady().then(async () => {
  log.info('app ready');

  if (firstRunNeeded(STATE_DIR)) {
    log.info('First-run: launching onboarding wizard');
    try {
      const result = await runOnboarding({
        hermesHome: HERMES_HOME,
        stateDir: STATE_DIR,
        hermesBin: HERMES_BIN,
        log,
        logFilePath: log.transports.file.getFile().path,
        // Open tiles BEFORE the wizard window closes, otherwise Electron sees
        // zero windows and `window-all-closed` quits the app mid-handoff.
        onBeforeClose: async () => {
          Object.assign(stateCache, loadStateFile());
          await openAllTiles();
        },
      });
      if (!result.completed) {
        log.info('Onboarding closed before completion — quitting.');
        app.quit();
        return;
      }
      log.info(`Onboarding complete. Orchestrator profile: ${result.orchestratorProfile}`);
      return;
    } catch (err) {
      log.error('Onboarding failed:', err.message);
      app.quit();
      return;
    }
  }

  try {
    await openAllTiles();
  } catch (err) {
    log.error('Failed to load profiles:', err.message);
    app.quit();
  }
});
```

with:

```js
const { listRealProfiles } = require('./onboarding/main');

function adoptLegacyState() {
  const real = listRealProfiles(HERMES_HOME);
  const orchestrator = real[0];
  const s = loadStateFile();
  s.firstRunComplete = true;
  s.orchestratorProfile = orchestrator;
  writeStateFile(s);
  Object.assign(stateCache, s);
  log.info(
    `Adopted ${real.length} existing profile(s); wizard skipped. ` +
    `orchestratorProfile=${orchestrator}`,
  );
}

app.whenReady().then(async () => {
  log.info('app ready');

  const mode = firstRunNeeded(STATE_DIR, HERMES_HOME);
  if (mode === 'wizard') {
    log.info('First-run: launching onboarding wizard');
    try {
      const result = await runOnboarding({
        hermesHome: HERMES_HOME,
        stateDir: STATE_DIR,
        hermesBin: HERMES_BIN,
        log,
        logFilePath: log.transports.file.getFile().path,
        onBeforeClose: async () => {
          Object.assign(stateCache, loadStateFile());
          await openAllTiles();
        },
      });
      if (!result.completed) {
        log.info('Onboarding closed before completion — quitting.');
        app.quit();
        return;
      }
      log.info(`Onboarding complete. Orchestrator profile: ${result.orchestratorProfile}`);
      return;
    } catch (err) {
      log.error('Onboarding failed:', err.message);
      app.quit();
      return;
    }
  }

  if (mode === 'adopt') {
    try {
      adoptLegacyState();
    } catch (err) {
      log.error('Adoption failed:', err.message);
      app.quit();
      return;
    }
  }

  try {
    await openAllTiles();
  } catch (err) {
    log.error('Failed to load profiles:', err.message);
    app.quit();
  }
});
```

- [ ] **Step 6: Run full suite**

```
npm test
```

Expected: everything green.

- [ ] **Step 7: Manual test on the author's machine**

Reset to pre-adopt state:

```bash
node -e "const fs=require('fs'),p=require('os').homedir()+'/.hermes-tiles/state.json';const s=JSON.parse(fs.readFileSync(p,'utf8'));delete s.firstRunComplete;delete s.orchestratorProfile;fs.writeFileSync(p,JSON.stringify(s,null,2))"
```

Then:

```
npm start
```

Expected: log shows "Adopted 5 existing profile(s); wizard skipped. orchestratorProfile=data" (or whichever comes first alphabetically). Wizard does NOT fire. Five tiles open normally.

After the test, `state.json` should now contain `firstRunComplete=true` and `orchestratorProfile="data"` (or your first alphabetically-sorted profile name).

- [ ] **Step 8: Commit**

```bash
git add onboarding/main.js main.js test/onboarding.test.js
git commit -m "$(cat <<'EOF'
fix(onboarding): adopt existing profiles instead of firing phantom wizard

Was: firstRunNeeded returned true whenever state.firstRunComplete !== true.
State files predating the wizard (created by Circe versions that just
watched ~/.hermes/profiles/) have neither firstRunComplete nor
orchestratorProfile — so upgrades over that state fired the wizard, which
then wanted to *create* a new Orchestrator despite the user already having
five working profiles.

Now: firstRunNeeded returns 'skip' | 'wizard' | 'adopt'. Adopt fires when
state lacks the flag AND <HERMES_HOME>/profiles/ contains at least one
non-_scratch directory; main.js back-fills firstRunComplete=true and picks
orchestratorProfile as the first non-_scratch profile alphabetically, then
opens tiles normally.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Add `retryUtil.js` helper

**Files:**
- Create: `retryUtil.js`
- Test: `test/retryUtil.test.js`

**Interfaces:**
- Consumes: nothing beyond built-ins.
- Produces:
  - `retryable(fn: () => Promise<T>, opts: { attempts: number, backoffMs: number[], isRetryable: (err) => boolean, onAttempt?: (n: number, err: Error) => void, disabled?: boolean }) → Promise<T>` — awaits `fn`; on rejection, if `isRetryable(err)` and attempts remain, waits `backoffMs[attemptIndex]` and retries. Rejects with the final error if all attempts exhausted or if `!isRetryable(err)`. If `opts.disabled === true`, executes `fn` exactly once.

- [ ] **Step 1: Write failing tests in `test/retryUtil.test.js`**

```js
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
```

- [ ] **Step 2: Run tests, expect failure**

```
npm test -- --test-name-pattern="retryable"
```

Expected: all six fail with `Cannot find module '../retryUtil'`.

- [ ] **Step 3: Create `retryUtil.js`**

```js
// retryable(fn, opts): bounded retry with per-attempt backoff.
//   attempts   — total attempts including the first (must be >= 1)
//   backoffMs  — array of delays in ms; backoffMs[i] applies between attempt
//                i+1 and i+2 (0-indexed). Length must be >= attempts - 1.
//   isRetryable(err) — decides whether to retry after a rejection
//   onAttempt(n, err) — called with n = attempt number ABOUT TO RUN (2, 3, …)
//                       and the error that triggered the retry
//   disabled   — if true, run fn once and bypass retry logic entirely
async function retryable(fn, opts) {
  const { attempts, backoffMs, isRetryable, onAttempt, disabled } = opts;
  if (disabled) return fn();
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLast = i === attempts - 1;
      if (isLast || !isRetryable(err)) throw err;
      const delay = backoffMs[i] || 0;
      if (typeof onAttempt === 'function') {
        try { onAttempt(i + 2, err); } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

module.exports = { retryable };
```

- [ ] **Step 4: Run tests, expect success**

```
npm test -- --test-name-pattern="retryable"
```

Expected: all six pass.

- [ ] **Step 5: Commit**

```bash
git add retryUtil.js test/retryUtil.test.js
git commit -m "$(cat <<'EOF'
feat(retry): add bounded retry helper for ACP and Bedrock reliability

Used by upcoming Fix 4a (ACP session/new retry) and Fix 4b (Bedrock verify
retry). Supports per-attempt backoff arrays, retryability predicate,
per-retry callback for progress UI, and CIRCE_NO_RETRY-style disable flag.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Retry ACP `session/new` on transient failures (Fix 4a)

**Files:**
- Modify: `acpClient.js:1-4` (imports), `acpClient.js:166-173` (`newSession`), `main.js:426-431` (IPC handler wires retry-status callback)
- Test: `test/acpClient.test.js` (extend)

**Interfaces:**
- Consumes: `retryable` from `retryUtil.js`, `process.env.CIRCE_NO_RETRY`.
- Produces: `AcpClient.newSession({ onRetry?: (n, err) => void } = {}) → Promise<string>` — signature extended with optional callback. Existing zero-arg calls still work.

Retry rules (from spec §Fix 4a):
- **attempts:** 3
- **backoffMs:** [500, 1500]
- **retryable errors:** `err.code === -32603` (JSON-RPC "Internal error") OR `err.code === undefined && !/hermes acp exited/.test(err.message)` (network/socket blip surfaced as bare Error)
- **non-retryable:** `err.code === -32601` (method not found), `err.code === -32602` (invalid params), any `err.data` whose `.detail` or `.message` substring-matches `/unauthorized|forbidden|invalid token|expired/i`, `/hermes acp exited/` (subprocess died)
- **precondition:** newSession is only called from `main.js:426` before any user message — no `firstUserText` check needed here because a fresh newSession call by definition precedes the first message. (The spec's `firstUserText === null` precondition applies at the callsite; `acp:newSession` IPC is only invoked for a tab that hasn't sent one yet — verified in `renderer.js:307,311`.)

- [ ] **Step 1: Write failing tests in `test/acpClient.test.js`**

Append to the file:

```js
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
  const id = await c.newSession();
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
  const id = await c.newSession({ onRetry: (n, err) => retries.push({ n, code: err.code }) });
  assert.strictEqual(id, 'sess-x');
  assert.deepStrictEqual(retries, [{ n: 2, code: -32603 }, { n: 3, code: -32603 }]);
});
```

- [ ] **Step 2: Run tests, expect five failures (four retry cases fail; one may pass by accident)**

```
npm test -- --test-name-pattern="acpClient.newSession"
```

Expected: retries do not happen because `newSession` doesn't yet wrap in `retryable`.

**Note on test timing:** these tests use tiny delays (backoffMs is fine as real ms during tests since 500+1500=2s max per test). Faster path: temporarily lower backoff in the tests by making `newSession` accept an override. To keep tests fast without complicating production code, add a private hook:

Edit `newSession` in Step 3 to also accept `{ backoffMs }` in its options object for tests. Update the two tests that trigger retries to pass `{ backoffMs: [1, 1] }` (retest step 2 with these tests updated).

Update the two retrying tests:

```js
// In 'retries on -32603 then succeeds' test:
const id = await c.newSession({ backoffMs: [1, 1] });

// In 'onRetry fires...' test:
const id = await c.newSession({ backoffMs: [1, 1], onRetry: (n, err) => retries.push({ n, code: err.code }) });
```

Re-run Step 2.

- [ ] **Step 3: Wire retry into `AcpClient.newSession`**

Add to `acpClient.js` top imports (after line 4):

```js
const { retryable } = require('./retryUtil');

function isRetryableAcpError(err) {
  if (!err) return false;
  if (/hermes acp exited/.test(err.message || '')) return false;
  if (err.code === -32601 || err.code === -32602) return false;
  const detail = (err.data && (err.data.detail || err.data.message)) || '';
  if (/unauthorized|forbidden|invalid token|expired/i.test(String(detail))) return false;
  if (err.code === -32603) return true;
  if (err.code === undefined) return true; // network/socket blip
  return false;
}
```

Replace `acpClient.js:166-173`:

```js
  async newSession() {
    await this._ready;
    const r = await this._send('session/new', {
      cwd: this.cwd,
      mcpServers: [],
    });
    return r.sessionId;
  }
```

with:

```js
  async newSession(opts = {}) {
    await this._ready;
    const disabled = process.env.CIRCE_NO_RETRY === '1';
    const backoffMs = opts.backoffMs || [500, 1500];
    const r = await retryable(
      () => this._send('session/new', { cwd: this.cwd, mcpServers: [] }),
      {
        attempts: 3,
        backoffMs,
        isRetryable: isRetryableAcpError,
        onAttempt: (n, err) => {
          if (typeof opts.onRetry === 'function') opts.onRetry(n, err);
          try {
            log.warn(`acp newSession retry [${this.profile}] attempt=${n} code=${err.code} msg=${err.message}`);
          } catch {}
        },
        disabled,
      },
    );
    return r.sessionId;
  }
```

- [ ] **Step 4: Wire IPC handler to send retry-status events**

Update the `acp:newSession` handler you wrote in Task 2 Step 5. Replace it in `main.js`:

```js
ipcMain.handle('acp:newSession', async (evt) => {
  const client = tileClients.get(evt.sender.id);
  if (!client) throw new Error('no ACP client for this window');
  try {
    const win = BrowserWindow.fromWebContents(evt.sender);
    const sessionId = await client.newSession({
      onRetry: (n, err) => {
        if (win && !win.isDestroyed()) {
          evt.sender.send('acp:retryStatus', {
            phase: 'newSession',
            attempt: n,
            max: 3,
            code: err.code,
            message: err.message,
          });
        }
      },
    });
    return { sessionId };
  } catch (err) {
    log.error(`acp:newSession failed`, err);
    const e = new Error(JSON.stringify(serializeAcpError(err)));
    e.name = 'AcpError';
    throw e;
  }
});
```

Add `BrowserWindow` to the require at `main.js:1` if not already imported. Confirm at `main.js:1`: it already imports `BrowserWindow`.

- [ ] **Step 5: Add the renderer channel and status display**

Add to `preload.js` after the existing `onExit` (line 33):

```js
  onRetryStatus: (fn) => ipcRenderer.on('acp:retryStatus', (_e, params) => fn(params)),
```

Then in `renderer.js`, after the existing `window.hermes.onError` registration (search for `.onError(`), add a lightweight status handler. Find the block that registers `onError` and `onExit` (around lines 429-437 based on earlier grep):

```js
window.hermes.onError((params) => {
  const tab = activeTab();
  if (tab) appendMessage(tab, 'agent', params.message || 'ACP error', 'error');
});
```

Add immediately after that block:

```js
if (window.hermes.onRetryStatus) {
  window.hermes.onRetryStatus((params) => {
    const tab = activeTab();
    if (!tab) return;
    // Transient status: append but flag as 'retry' so persistState skips it.
    const text = `Retrying session start… (attempt ${params.attempt}/${params.max})`;
    appendMessage(tab, 'agent', text, 'retry');
  });
}
```

Update `persistState` in `renderer.js:325-343` to exclude `retry`-classed messages:

Replace this section in `renderer.js:337`:

```js
        messages: t.messages
          .filter((m) => m.role !== 'tool' && m.role !== 'permission')
          .map((m) => ({ role: m.role, text: m.text, cls: m.cls || '' })),
```

with:

```js
        messages: t.messages
          .filter((m) => m.role !== 'tool' && m.role !== 'permission' && m.cls !== 'retry')
          .map((m) => ({ role: m.role, text: m.text, cls: m.cls || '' })),
```

- [ ] **Step 6: Run tests**

```
npm test
```

Expected: all previous plus six new `acpClient.newSession` tests pass.

- [ ] **Step 7: Commit**

```bash
git add acpClient.js main.js preload.js renderer.js test/acpClient.test.js
git commit -m "$(cat <<'EOF'
fix(acp): retry session/new on transient failures pre-first-message

Was: any ACP session/new failure — including a JSON-RPC -32603 "Internal
error" from a network blip during MCP discovery, an upstream 529 blip,
Bedrock cold-start latency — bricked the tile until a full app restart.

Now: bounded retry (3 attempts, 500ms + 1500ms backoff) on -32603 and
network-shaped errors. Fails immediately on -32601/-32602, auth-shaped
data, or "hermes acp exited" (subprocess died — different problem, not
a retry candidate). Renderer shows "Retrying session start… (attempt N/3)"
as a transient status that isn't persisted to transcript.

CIRCE_NO_RETRY=1 opts out.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Retry Bedrock verify on network failures (Fix 4b)

**Files:**
- Modify: `bedrockClient.js:15-45`
- Modify: `onboarding/main.js:229-231` (pass retry-status callback through IPC)
- Modify: `onboarding/preload.js` (expose the retry-status event) — verify exact path
- Test: extend `test/bedrockClient.test.js`

**Interfaces:**
- Consumes: `retryable` from `retryUtil.js`.
- Produces: `verify(apiKey: string, fetchImpl?: fetch, opts?: { onRetry?: (n, err) => void, backoffMs?: number[] }) → Promise<{ok, error?, kind?}>` — signature extends existing verify with optional callbacks.

Retry rules (from spec §Fix 4b):
- **attempts:** 2 (1 retry)
- **backoffMs:** [1000]
- **retryable:** network errors (`fetchImpl` throws)
- **non-retryable:** any HTTP response (200/401/403/5xx) — verify's existing logic runs

- [ ] **Step 1: Locate onboarding preload**

```
ls /Users/sarachipps/Code/circe-dj/onboarding/
```

Expected: contains `preload.js`. Read `onboarding/preload.js` to confirm the existing shape of the exposed API so the retry-status wiring matches convention.

- [ ] **Step 2: Write failing tests in `test/bedrockClient.test.js`**

Append to the file:

```js
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
```

**Note:** the existing `verify(apiKey, fetchImpl)` call sites won't pass `opts`; the new signature must be `verify(apiKey, fetchImpl, opts)` with `opts = {}` default.

- [ ] **Step 3: Run tests, expect failures**

```
npm test -- --test-name-pattern="verify:"
```

Expected: the new tests fail. Existing 4 verify tests (200/401/403/network) still pass.

- [ ] **Step 4: Update `bedrockClient.js`**

Replace `bedrockClient.js:28-45`:

```js
async function verify(apiKey, fetchImpl) {
  const body = {
    model: MODEL,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'ok' }],
  };
  let res;
  try {
    res = await callBedrock({ apiKey, body, fetchImpl });
  } catch (err) {
    return { ok: false, error: NETWORK_ERROR_COPY, kind: 'network' };
  }
  if (res.ok) return { ok: true };
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: AUTH_ERROR_COPY, kind: 'auth' };
  }
  return { ok: false, error: UNKNOWN_ERROR_COPY(res.status), kind: 'unknown' };
}
```

with:

```js
const { retryable } = require('./retryUtil');

class NetworkError extends Error {
  constructor(cause) {
    super(cause && cause.message ? cause.message : String(cause));
    this.name = 'NetworkError';
  }
}

async function verify(apiKey, fetchImpl, opts = {}) {
  const body = {
    model: MODEL,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'ok' }],
  };
  const disabled = process.env.CIRCE_NO_RETRY === '1';
  const backoffMs = opts.backoffMs || [1000];
  try {
    const res = await retryable(
      async () => {
        try {
          return await callBedrock({ apiKey, body, fetchImpl });
        } catch (err) {
          throw new NetworkError(err);
        }
      },
      {
        attempts: 2,
        backoffMs,
        isRetryable: (err) => err instanceof NetworkError,
        onAttempt: (n, err) => {
          if (typeof opts.onRetry === 'function') opts.onRetry(n, err);
        },
        disabled,
      },
    );
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: AUTH_ERROR_COPY, kind: 'auth' };
    }
    return { ok: false, error: UNKNOWN_ERROR_COPY(res.status), kind: 'unknown' };
  } catch (err) {
    return { ok: false, error: NETWORK_ERROR_COPY, kind: 'network' };
  }
}
```

- [ ] **Step 5: Run tests**

```
npm test -- --test-name-pattern="verify:"
```

Expected: all 9 tests (4 pre-existing + 5 new) pass.

- [ ] **Step 6: Update `onboarding/main.js` IPC handler to plumb retry status**

Replace `onboarding/main.js:229-231`:

```js
  on('onboarding:bedrockVerifyDirect', async (_e, { apiKey }) =>
    bedrockClient.verify(apiKey),
  );
```

with:

```js
  on('onboarding:bedrockVerifyDirect', async (evt, { apiKey }) =>
    bedrockClient.verify(apiKey, undefined, {
      onRetry: (n, err) => {
        if (!win.isDestroyed()) {
          win.webContents.send('onboarding:bedrockVerify:retry', {
            attempt: n,
            max: 2,
            message: err.message,
          });
        }
      },
    }),
  );
```

Note: `_e` becomes `evt` because we now reference `win` via closure (already in scope).

- [ ] **Step 7: Expose the retry-status event to the wizard renderer**

Read `onboarding/preload.js` first to confirm its structure. Then add an `onBedrockRetry` listener following the same pattern used for `onboarding:hermesInstall:progress` (which passes strings from main to renderer). Grep the wizard renderer for `hermesInstall:progress`-style listeners to match the convention.

Find in `onboarding/preload.js`:

```
grep -n "hermesInstall" /Users/sarachipps/Code/circe-dj/onboarding/preload.js
```

If a pattern like `onHermesInstallProgress: (fn) => ipcRenderer.on('onboarding:hermesInstall:progress', ...)` exists, add a matching:

```js
onBedrockVerifyRetry: (fn) => ipcRenderer.on('onboarding:bedrockVerify:retry', (_e, p) => fn(p)),
```

Wire the wizard's Step 3 renderer to display "Retrying Bedrock verification…" between attempts. Locate the wizard's verify UI in `onboarding/renderer.js` (or step-specific renderer) — the existing hermesInstall progress-log box pattern is the model to follow.

**Deferred detail:** since we haven't read `onboarding/preload.js` or the wizard renderer in this plan, an implementer must:

1. Read `onboarding/preload.js` and match its `contextBridge.exposeInMainWorld` pattern for the new listener.
2. Read the wizard renderer file (probably `onboarding/renderer.js` — grep for `bedrockVerifyDirect`) and add a listener that appends "Retrying Bedrock verification…" to whatever status area exists at Step 3 (analogous to how `hermesInstall:progress` events are appended in the wizard).
3. Ensure the listener does NOT show "Retrying" on the initial call — only on retry attempts (`onAttempt` fires with n=2, not n=1, so the natural firing is correct).

- [ ] **Step 8: Run full suite**

```
npm test
```

Expected: everything green.

- [ ] **Step 9: Commit**

```bash
git add bedrockClient.js onboarding/main.js onboarding/preload.js onboarding/renderer.js test/bedrockClient.test.js
git commit -m "$(cat <<'EOF'
fix(bedrock): retry verify once on transient network errors

Was: a single fetch-level failure (dropped VPN packet, transient DNS) at
Step 3 of the wizard forced the user to click "Try again" manually.

Now: retryable(2 attempts, 1000ms backoff) wraps the fetch call. HTTP
responses (200/401/403/5xx) never retry — they're the token's answer,
not the network's. Network errors retry once. Wizard shows "Retrying
Bedrock verification…" between attempts via a new
onboarding:bedrockVerify:retry IPC channel.

CIRCE_NO_RETRY=1 opts out.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Auto-trust corporate CA roots (Fix 1)

**Files:**
- Create: `caTrust.js`
- Modify: `main.js:1-20` (call `setupCaTrust` before `app.whenReady`)
- Test: `test/caTrust.test.js`

**Interfaces:**
- Consumes: `security find-certificate -a -c Zscaler -p /Library/Keychains/System.keychain` (macOS built-in), Node built-ins, optional Hermes `python3` for certifi resolution.
- Produces:
  - `setupCaTrust({ userDataDir: string, hermesBin: string, log }) → Promise<{ ok: boolean, note?: string }>` — main entry. Idempotent; safe to call before whenReady. Never throws — always resolves.
  - `detectZscalerRoot(exec) → Promise<{ present: boolean, pem?: string }>` — internal, exported for tests.
  - `resolveCertifiBundlePath(exec, hermesBin) → Promise<string | null>` — internal, exported for tests.

Behavior (from spec §Fix 1):
1. If `security find-certificate ...` returns non-empty PEM → have Zscaler root.
2. If not → do nothing (skip silently).
3. If yes: write `zscaler-root.pem` and `python-ca-bundle.pem` under `userDataDir`.
4. Set `process.env.NODE_EXTRA_CA_CERTS` to `zscaler-root.pem` path if not already set.
5. Set `process.env.SSL_CERT_FILE` to `python-ca-bundle.pem` path if not already set (or fall back to zscaler-only if certifi resolution fails).
6. Log all decisions.

- [ ] **Step 1: Write failing tests in `test/caTrust.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const caTrust = require('../caTrust');

function mkTmpUD(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'circe-cat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const FAKE_PEM = '-----BEGIN CERTIFICATE-----\nZFake\n-----END CERTIFICATE-----\n';
const FAKE_CERTIFI = '-----BEGIN CERTIFICATE-----\nCertifi1\n-----END CERTIFICATE-----\n';

function fakeExec(map) {
  return async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`;
    if (!(key in map)) throw new Error(`unexpected exec: ${key}`);
    const v = map[key];
    if (v instanceof Error) throw v;
    return v;
  };
}

test('detectZscalerRoot: returns present:true with PEM when security has certs', async () => {
  const exec = fakeExec({
    'security find-certificate -a -c Zscaler -p /Library/Keychains/System.keychain':
      { stdout: FAKE_PEM, code: 0 },
  });
  const r = await caTrust.detectZscalerRoot(exec);
  assert.strictEqual(r.present, true);
  assert.strictEqual(r.pem, FAKE_PEM);
});

test('detectZscalerRoot: returns present:false when security returns empty', async () => {
  const exec = fakeExec({
    'security find-certificate -a -c Zscaler -p /Library/Keychains/System.keychain':
      { stdout: '', code: 0 },
  });
  const r = await caTrust.detectZscalerRoot(exec);
  assert.strictEqual(r.present, false);
});

test('detectZscalerRoot: returns present:false when security fails', async () => {
  const exec = fakeExec({
    'security find-certificate -a -c Zscaler -p /Library/Keychains/System.keychain':
      new Error('command not found'),
  });
  const r = await caTrust.detectZscalerRoot(exec);
  assert.strictEqual(r.present, false);
});

test('setupCaTrust: writes both bundle files and sets env when Zscaler present', async (t) => {
  const originalNode = process.env.NODE_EXTRA_CA_CERTS;
  const originalSsl = process.env.SSL_CERT_FILE;
  delete process.env.NODE_EXTRA_CA_CERTS;
  delete process.env.SSL_CERT_FILE;
  t.after(() => {
    if (originalNode === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = originalNode;
    if (originalSsl === undefined) delete process.env.SSL_CERT_FILE;
    else process.env.SSL_CERT_FILE = originalSsl;
  });
  const ud = mkTmpUD(t);
  const exec = fakeExec({
    'security find-certificate -a -c Zscaler -p /Library/Keychains/System.keychain':
      { stdout: FAKE_PEM, code: 0 },
    'python3 -c import certifi; print(certifi.where())': { stdout: '/fake/certifi.pem\n', code: 0 },
  });
  const readFake = (p) => (p === '/fake/certifi.pem' ? FAKE_CERTIFI : fs.readFileSync(p, 'utf8'));
  const result = await caTrust.setupCaTrust({
    userDataDir: ud,
    hermesBin: '/fake/hermes',
    log: { info: () => {}, warn: () => {}, error: () => {} },
    exec,
    readFile: readFake,
  });
  assert.strictEqual(result.ok, true);
  const zPath = path.join(ud, 'zscaler-root.pem');
  const bPath = path.join(ud, 'python-ca-bundle.pem');
  assert.strictEqual(fs.readFileSync(zPath, 'utf8'), FAKE_PEM);
  assert.strictEqual(fs.readFileSync(bPath, 'utf8'), FAKE_CERTIFI + FAKE_PEM);
  assert.strictEqual(process.env.NODE_EXTRA_CA_CERTS, zPath);
  assert.strictEqual(process.env.SSL_CERT_FILE, bPath);
});

test('setupCaTrust: falls back to zscaler-only bundle when certifi unresolvable', async (t) => {
  const originalNode = process.env.NODE_EXTRA_CA_CERTS;
  const originalSsl = process.env.SSL_CERT_FILE;
  delete process.env.NODE_EXTRA_CA_CERTS;
  delete process.env.SSL_CERT_FILE;
  t.after(() => {
    if (originalNode === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = originalNode;
    if (originalSsl === undefined) delete process.env.SSL_CERT_FILE;
    else process.env.SSL_CERT_FILE = originalSsl;
  });
  const ud = mkTmpUD(t);
  const exec = fakeExec({
    'security find-certificate -a -c Zscaler -p /Library/Keychains/System.keychain':
      { stdout: FAKE_PEM, code: 0 },
    'python3 -c import certifi; print(certifi.where())': new Error('no certifi'),
  });
  const result = await caTrust.setupCaTrust({
    userDataDir: ud,
    hermesBin: '/fake/hermes',
    log: { info: () => {}, warn: () => {}, error: () => {} },
    exec,
  });
  assert.strictEqual(result.ok, true);
  const bPath = path.join(ud, 'python-ca-bundle.pem');
  assert.strictEqual(fs.readFileSync(bPath, 'utf8'), FAKE_PEM);
  assert.strictEqual(process.env.SSL_CERT_FILE, bPath);
});

test('setupCaTrust: skips silently when no Zscaler root', async (t) => {
  const originalNode = process.env.NODE_EXTRA_CA_CERTS;
  const originalSsl = process.env.SSL_CERT_FILE;
  delete process.env.NODE_EXTRA_CA_CERTS;
  delete process.env.SSL_CERT_FILE;
  t.after(() => {
    if (originalNode === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = originalNode;
    if (originalSsl === undefined) delete process.env.SSL_CERT_FILE;
    else process.env.SSL_CERT_FILE = originalSsl;
  });
  const ud = mkTmpUD(t);
  const exec = fakeExec({
    'security find-certificate -a -c Zscaler -p /Library/Keychains/System.keychain':
      { stdout: '', code: 0 },
  });
  const result = await caTrust.setupCaTrust({
    userDataDir: ud,
    hermesBin: '/fake/hermes',
    log: { info: () => {}, warn: () => {}, error: () => {} },
    exec,
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(process.env.NODE_EXTRA_CA_CERTS, undefined);
  assert.strictEqual(process.env.SSL_CERT_FILE, undefined);
});

test('setupCaTrust: does not override user-set NODE_EXTRA_CA_CERTS', async (t) => {
  const originalNode = process.env.NODE_EXTRA_CA_CERTS;
  process.env.NODE_EXTRA_CA_CERTS = '/user/preferred.pem';
  t.after(() => {
    if (originalNode === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = originalNode;
  });
  const ud = mkTmpUD(t);
  const exec = fakeExec({
    'security find-certificate -a -c Zscaler -p /Library/Keychains/System.keychain':
      { stdout: FAKE_PEM, code: 0 },
    'python3 -c import certifi; print(certifi.where())': { stdout: '/fake/certifi.pem\n', code: 0 },
  });
  const readFake = (p) => (p === '/fake/certifi.pem' ? FAKE_CERTIFI : fs.readFileSync(p, 'utf8'));
  await caTrust.setupCaTrust({
    userDataDir: ud,
    hermesBin: '/fake/hermes',
    log: { info: () => {}, warn: () => {}, error: () => {} },
    exec,
    readFile: readFake,
  });
  assert.strictEqual(process.env.NODE_EXTRA_CA_CERTS, '/user/preferred.pem');
});
```

- [ ] **Step 2: Run tests, expect failure**

```
npm test -- --test-name-pattern="detectZscalerRoot|setupCaTrust"
```

Expected: all seven fail with `Cannot find module '../caTrust'`.

- [ ] **Step 3: Create `caTrust.js`**

```js
const fs = require('fs');
const path = require('path');
const child_process = require('child_process');

function defaultExec(cmd, args) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = child_process.spawn(cmd, args, { env: process.env });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}

async function detectZscalerRoot(exec = defaultExec) {
  try {
    const r = await exec('security', [
      'find-certificate',
      '-a',
      '-c',
      'Zscaler',
      '-p',
      '/Library/Keychains/System.keychain',
    ]);
    const pem = (r && r.stdout) || '';
    if (pem.includes('BEGIN CERTIFICATE')) return { present: true, pem };
    return { present: false };
  } catch {
    return { present: false };
  }
}

async function resolveCertifiBundlePath(exec = defaultExec) {
  try {
    const r = await exec('python3', [
      '-c',
      'import certifi; print(certifi.where())',
    ]);
    const p = ((r && r.stdout) || '').trim();
    if (p && fs.existsSync(p)) return p;
    return null;
  } catch {
    return null;
  }
}

async function setupCaTrust(opts) {
  const {
    userDataDir,
    log,
    exec = defaultExec,
    readFile = (p) => fs.readFileSync(p, 'utf8'),
  } = opts;
  const notes = [];
  try {
    const det = await detectZscalerRoot(exec);
    if (!det.present) {
      log.info('caTrust: no Zscaler root found; skipping');
      return { ok: true, note: 'no-zscaler' };
    }
    fs.mkdirSync(userDataDir, { recursive: true });
    const zPath = path.join(userDataDir, 'zscaler-root.pem');
    fs.writeFileSync(zPath, det.pem);
    notes.push(`wrote ${zPath}`);

    const certifiPath = await resolveCertifiBundlePath(exec);
    const bPath = path.join(userDataDir, 'python-ca-bundle.pem');
    if (certifiPath) {
      const certifiPem = readFile(certifiPath);
      fs.writeFileSync(bPath, certifiPem + det.pem);
      notes.push(`wrote ${bPath} (certifi + zscaler)`);
    } else {
      fs.writeFileSync(bPath, det.pem);
      notes.push(`wrote ${bPath} (zscaler only — certifi unresolved)`);
      log.warn('caTrust: certifi.where() unresolvable; SSL_CERT_FILE points to zscaler-only bundle');
    }

    if (process.env.NODE_EXTRA_CA_CERTS) {
      log.info(`caTrust: NODE_EXTRA_CA_CERTS already set (${process.env.NODE_EXTRA_CA_CERTS}); leaving alone`);
    } else {
      process.env.NODE_EXTRA_CA_CERTS = zPath;
      notes.push(`set NODE_EXTRA_CA_CERTS=${zPath}`);
    }
    if (process.env.SSL_CERT_FILE) {
      log.info(`caTrust: SSL_CERT_FILE already set (${process.env.SSL_CERT_FILE}); leaving alone`);
    } else {
      process.env.SSL_CERT_FILE = bPath;
      notes.push(`set SSL_CERT_FILE=${bPath}`);
    }
    log.info(`caTrust: ${notes.join('; ')}`);
    return { ok: true };
  } catch (err) {
    log.error('caTrust setup failed:', err.message);
    return { ok: false, note: err.message };
  }
}

module.exports = { setupCaTrust, detectZscalerRoot, resolveCertifiBundlePath };
```

- [ ] **Step 4: Run tests**

```
npm test -- --test-name-pattern="detectZscalerRoot|setupCaTrust"
```

Expected: all seven pass.

- [ ] **Step 5: Wire `main.js` to call `setupCaTrust` before whenReady**

Insert into `main.js` after line 16 (`log.info(...)`, before `process.on('unhandledRejection')`):

```js
const { setupCaTrust } = require('./caTrust');
```

Then replace the `app.whenReady().then(async () => {` at `main.js:352` with:

```js
app.whenReady().then(async () => {
  log.info('app ready');
  await setupCaTrust({
    userDataDir: app.getPath('userData'),
    hermesBin: HERMES_BIN,
    log,
  });
```

Ensure the `require` line for `caTrust` sits at the top of the file with the other requires. Move the `const { setupCaTrust } = require('./caTrust');` line up to sit next to the other module requires (around lines 7-8).

- [ ] **Step 6: Run full suite**

```
npm test
```

Expected: everything green.

- [ ] **Step 7: Manual smoke on the author's machine (has Zscaler)**

```
npm start
```

Expected: log line "caTrust: wrote ..." at boot. `zscaler-root.pem` and `python-ca-bundle.pem` created under `~/Library/Application Support/Circe/`. `process.env.NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE` set (visible in the log or via a debug print). App boots normally, tiles open.

- [ ] **Step 8: Commit**

```bash
git add caTrust.js main.js test/caTrust.test.js
git commit -m "$(cat <<'EOF'
fix(tls): auto-trust corporate CA roots for Node and Hermes Python

Was: DJ machines run Zscaler, whose root CA is in the system keychain but
not in Node's undici bundle nor in certifi. Node fetch failed with
UNABLE_TO_GET_ISSUER_CERT_LOCALLY at wizard verify; Hermes Python failed
with CERTIFICATE_VERIFY_FAILED on any HTTPS call. Users needed to be
walked through NODE_EXTRA_CA_CERTS + SSL_CERT_FILE over Slack.

Now: on app boot, detect Zscaler via `security find-certificate`; if
present, write zscaler-root.pem and python-ca-bundle.pem (certifi + zscaler
concatenated, or zscaler alone as fallback) under userData; set
NODE_EXTRA_CA_CERTS and SSL_CERT_FILE unless the user has set them
themselves. Silent no-op on non-Zscaler machines.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Manual end-to-end verification

**Files:** none — verification pass.

**Interfaces:** none.

- [ ] **Step 1: Full-suite check**

```
npm test
```

Expected: everything green. Note total test count for the report.

- [ ] **Step 2: Author-machine happy-path smoke**

```
npm start
```

Expected:
- caTrust log line at boot naming the two PEM files
- "Loaded 5 profile(s)" (no `default`, no six)
- All five tiles open; each `[acp:*]` process comes up without error
- Send "test" from `data` tile → response arrives

- [ ] **Step 3: Retry-visibility smoke**

Send "test" from a real tile after network flakes (or `SIGSTOP`/`SIGCONT` the hermes acp child mid-`session/new` if patient). Expected: transient "Retrying session start… (attempt 2/3)" message, then success. Or, if all three fail: final error carries `err.code` and `err.data.detail` visible in the tile.

- [ ] **Step 4: Report results**

Write a one-paragraph summary of what worked and what didn't. Do NOT commit anything from this task.

---

## Self-review notes

- **Spec coverage:** Fix 1 → Task 8. Fix 2 → Task 2. Fix 3 → Task 1. Fix 4 (retry helper + 4a + 4b) → Tasks 5, 6, 7. Fix 5 → Task 4. Fix 6 → Task 3.
- **Placeholder scan:** the deferred detail in Task 7 Step 7 (wizard renderer wiring) requires an implementer to read `onboarding/preload.js` and the wizard renderer before completing. Every other step spells out exact code.
- **Type consistency:**
  - `firstRunNeeded` new signature: `(stateDir, hermesHome) → 'skip' | 'wizard' | 'adopt'` — used consistently in Task 4 Steps 3 and 5.
  - `verify(apiKey, fetchImpl, opts)` — the opts arg is optional; existing three-arg callers unaffected.
  - `AcpClient.newSession(opts = {})` — opts optional; existing zero-arg calls unaffected.
  - `retryable(fn, opts)` — opts fields spelled the same across all callers (`attempts`, `backoffMs`, `isRetryable`, `onAttempt`, `disabled`).
  - `setupCaTrust({ userDataDir, hermesBin, log, exec?, readFile? })` — matches invocation in Task 8 Step 5.
- **Test-file convention:** all new tests use `node:test` + `node:assert`, live under `test/*.test.js`, and are discovered by the existing `npm test` command.
- **Order:** Fix 3 (env fix) → Fix 2 (error surface) → Fix 6 (default filter) → Fix 5 (adoption) → Fix 4 helper → Fix 4a → Fix 4b → Fix 1 (Zscaler). Each task lands complete and independently reviewable; later tasks build on earlier ones only through additive changes.
