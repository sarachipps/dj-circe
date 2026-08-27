# Hermes install Step 2 wiring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder `install()` in `hermesInstall.js` with a real spawn of the Hermes install script so Step 2 of the onboarding wizard actually installs Hermes for colleagues who don't have it.

**Architecture:** One function change in `hermesInstall.js`, exercised via `child_process.spawn` stubs in an existing test file. No renderer, IPC, or wiring changes — the wizard already handles progress streaming, success, and failure branches; only the underlying `install()` needs to become real.

**Tech Stack:** Node's built-in `child_process.spawn`, `node:test`, existing wizard IPC channel (`onboarding:hermesInstall:progress`).

## Global Constraints

- **Install command:** `bash -lc "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash"` — copied verbatim from spec §Design. Login-flavored shell so nvm/brew PATH is picked up.
- **Streaming:** stdout AND stderr both routed through the same `onProgress(line)` callback — no distinction.
- **Line splitting:** split incoming data on `/\r?\n/` and emit each non-empty line separately. Buffers may arrive coalesced.
- **Success signal:** child exit code `0`. No stdout parsing.
- **Env:** pass `process.env` through unchanged.
- **Test framework:** `node:test`, run via `npm test`. Never dispatch a real network install in tests — stub `child_process.spawn`.

---

### Task 1: Rewrite `install()` in `hermesInstall.js` with real spawn logic (TDD)

**Files:**
- Modify: `hermesInstall.js:35-41`
- Test: `test/hermesInstall.test.js` (replace the existing "actionable placeholder" test; add success + streaming + failure cases)

**Interfaces:**
- Consumes: `child_process.spawn(cmd, args, opts)` — Node built-in.
- Produces:
  - `install(onProgress?: (line: string) => void): Promise<{ok: true} | {ok: false, error: string}>`
  - Same signature as today. Callers in `onboarding/main.js:225` and `onboarding/preload.js:17` need no changes.

- [ ] **Step 1: Delete the placeholder-error test and write four new failing tests**

Replace the existing `test('install: returns actionable placeholder error in v1', ...)` at `test/hermesInstall.test.js:50-54` with the following four tests. Keep the `stubSpawn` and `fakeChild` helpers already in the file (they support the shape we need — the existing `detect` tests use them).

```js
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
```

- [ ] **Step 2: Run tests, expect the five new ones to fail**

```
npm test -- --test-name-pattern="install:"
```

Expected: the three `detect:` tests still pass; the five new `install:` tests fail. Failure modes will vary (assertion mismatches or hangs) because the placeholder returns `{ok: false, error: '…manually…'}` for every call.

- [ ] **Step 3: Rewrite `install()` with real spawn logic**

Replace `hermesInstall.js:35-41` (the current placeholder implementation and its wrapping `install` function) with:

```js
async function install(onProgress) {
  return new Promise((resolve) => {
    const cmd =
      'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash';
    let child;
    try {
      child = child_process.spawn('bash', ['-lc', cmd], {
        env: process.env,
      });
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }

    const emit = (buf) => {
      if (typeof onProgress !== 'function') return;
      const text = buf.toString();
      for (const line of text.split(/\r?\n/)) {
        if (line.length) onProgress(line);
      }
    };

    child.stdout.on('data', emit);
    child.stderr.on('data', emit);
    child.on('error', (err) => {
      resolve({ ok: false, error: err.message });
    });
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: `install exited ${code}` });
    });
  });
}
```

Leave `runVersion()`, `detect()`, and the `module.exports` line unchanged.

- [ ] **Step 4: Run all `hermesInstall` tests, expect all to pass**

```
npm test -- --test-name-pattern="install:|detect:"
```

Expected: all eight tests (three `detect:`, five `install:`) pass.

- [ ] **Step 5: Run the full suite to confirm no regressions**

```
npm test
```

Expected: everything green.

- [ ] **Step 6: Commit**

```
git add hermesInstall.js test/hermesInstall.test.js
git commit -m "$(cat <<'EOF'
feat(onboarding): wire real Hermes install in Step 2

Replaces the placeholder install() that told users to install manually
and restart. Now spawns `bash -lc "curl … | bash"` against the official
install script, streams stdout + stderr line-by-line through the
onProgress callback the wizard already consumes, resolves ok:true on
exit 0 or ok:false with the exit code otherwise.

Renderer, IPC channel, and Bedrock flow downstream are unchanged: the
wizard's post-install re-detect + "Restart Circe" branch handles the
PATH-not-picked-up case as before.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Manual end-to-end verification (no code changes)

**Files:** none — this is a verification pass.

**Interfaces:** none.

- [ ] **Step 1: Test the already-installed happy path**

```
npm run dev:onboarding
```

Expected: Step 2 detects the existing `~/.local/bin/hermes` binary, shows "Hermes is installed. (v0.18.x)" for ~800ms, auto-advances to Step 3. Close the wizard when Step 3 appears.

- [ ] **Step 2: Test the install path against the real install script**

Move the local hermes binary aside so the wizard has to install:

```
mv ~/.local/bin/hermes ~/.local/bin/hermes.bak-$(date +%s)
```

Then:

```
npm run dev:onboarding
```

Expected sequence at Step 2:
- "Circe needs Hermes to run agents…" message
- Click "Install Hermes"
- Log box streams the install script's output (curl progress, tar extraction, etc.)
- On success: "Hermes installed (0.18.x). Continuing…", auto-advance to Step 3

Close the wizard when Step 3 appears. Restore your hermes binary:

```
mv ~/.local/bin/hermes.bak-* ~/.local/bin/hermes
```

- [ ] **Step 3: Test the install-then-restart branch (optional)**

Only run this if you want to exercise the fallback path. Temporarily point PATH away from `~/.local/bin` and repeat Step 2. The renderer should show "Restart Circe to pick up the new install" and offer a Quit button. Restore PATH and hermes binary after.

- [ ] **Step 4: Test the failure path**

Temporarily edit `hermesInstall.js`'s command URL to a 404 (e.g., `.nousresearch.com/does-not-exist`), then:

```
npm run dev:onboarding
```

Expected at Step 2 after Install click: log streams the curl error, "install exited 22" (or similar) shown in red, Retry + Copy log buttons appear. Undo the URL edit before committing anything.

- [ ] **Step 5: Report verification results**

If all three passes work, this task is done. If any fail, capture the log-box output and diagnose. Do NOT commit anything from this task — it's verification only. Any URL/PATH edits during testing must be reverted.

---

## Self-review notes

- **Spec coverage:** All three spec sections (Design, What the renderer already does, Testing) map to tasks. Design → Task 1 Steps 3-5. Renderer-unchanged claim → Task 2 Steps 1-4 (visual confirmation). Testing → Task 1 unit tests + Task 2 manual E2E.
- **Placeholder scan:** No TBDs, no "handle errors appropriately", no "similar to X" — every test body and implementation body is spelled out.
- **Type consistency:** `install(onProgress)` returns `Promise<{ok: true} | {ok: false, error: string}>` in both the code and every test. Matches renderer's `renderer.js:104-129` consumer shape (`res.ok`, `res.error`).
- **Preserves the "Restart Circe" fallback:** Task 1 doesn't touch the renderer, so `renderer.js:118-121` still fires when post-install `hermesDetect()` fails. Verified in Task 2 Step 3.
