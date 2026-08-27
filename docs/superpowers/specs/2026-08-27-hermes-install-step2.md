# Wire up real Hermes install in Step 2 — design

**Status:** draft, awaiting approval
**Date:** 2026-08-27
**Repo:** dj-circe, branch `feat/dj-onboarding`

## Problem

Step 2 of the onboarding wizard (Hermes check) has an "Install Hermes"
button, but `hermesInstall.install()` in `hermesInstall.js` is a stub
that unconditionally returns:

```
'Automated install not yet wired — install Hermes manually and restart Circe.'
```

A colleague opening Circe without Hermes on their machine hits this
error, has to close Circe, run the install command themselves, then
re-launch. The button's copy claims automated install; the code
doesn't deliver it.

## Goal

Make the "Install Hermes" button actually install Hermes, streaming
output into the wizard's existing log box, so a first-time user who
lacks Hermes never has to leave Circe to complete onboarding.

## Non-goals

- Handling non-standard install locations. The Hermes install script
  puts the binary at `~/.local/bin/hermes`; if a colleague has
  overridden that, they'll see the "Restart Circe to pick up the new
  install" branch and can restart. Same behavior as today's manual
  path.
- Supporting install on Linux / Windows. Circe is macOS-only per
  `HOME-MACHINE-SETUP.md`; the same install script works there but
  we're not testing it.
- Detecting failures upstream of the script (network offline, curl
  missing, disk full). The install script's own stderr is streamed
  back and shown to the user; that's sufficient triage for v1.

## Design

Replace the stub in `hermesInstall.js:35-41` with a real spawn.

```js
async function install(onProgress) {
  return new Promise((resolve) => {
    const cmd =
      'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash';
    const child = child_process.spawn('bash', ['-lc', cmd], {
      env: process.env,
    });

    const emit = (line) => {
      if (typeof onProgress === 'function') onProgress(line);
    };

    const handle = (buf) => {
      const text = buf.toString();
      for (const line of text.split(/\r?\n/)) {
        if (line.length) emit(line);
      }
    };

    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
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

Key choices:

1. **`bash -lc`, not raw `curl … | bash`.** The pipe needs a real
   shell to interpret. A login-flavored shell (`-l`) sources the
   user's profile so any custom `PATH` (nvm, brew) is available to
   downstream commands inside the install script.
2. **stdout AND stderr streamed the same way.** The install script
   writes progress to both. The renderer already displays both
   indiscriminately in the log box; no need to distinguish.
3. **Exit code 0 = ok.** No output parsing. The subsequent
   `hermesDetect` call (already wired in `renderer.js:110-122`)
   confirms the binary is actually present and callable.
4. **No env manipulation.** We pass `process.env` through unchanged.
   The install script writes to `~/.local/bin`; if that's not on
   PATH, `hermesDetect` fails and the renderer's existing "Restart
   Circe to pick up the new install" branch fires.

## What the renderer already does (unchanged)

`renderer.js:100-131` — click Install → stream log lines → on `ok`,
re-run `hermesDetect` → on found, advance to Step 3; on missing,
show the restart-Circe prompt.

The IPC channel (`onboarding:hermesInstall:progress`) is already
plumbed in `onboarding/main.js:220-224`. No wiring changes needed.

## Testing

- **Manual, dirty sandbox:** `rm -rf ~/.hermes-dev ~/.local/bin/hermes`,
  then `npm run dev:onboarding`, click Install Hermes at Step 2,
  watch progress stream, verify auto-advance to Step 3.
- **Manual, hermes-already-present:** normal `npm run dev:onboarding`.
  Step 2 detects existing binary and auto-advances without ever
  calling `install()`.
- **Failure path:** temporarily point the URL at a 404. Verify the
  wizard shows the failure state with Retry + Copy log.

## Out of scope

- Progress bar / percentage. The install script's own output is
  informative enough.
- Uninstall. Not a Circe concern.
- Version pinning. Whatever the install script picks is what we
  get. Matches manual install today.
