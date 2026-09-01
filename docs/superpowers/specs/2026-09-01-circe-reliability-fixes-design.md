# Circe reliability fixes — design

**Status:** draft, awaiting approval
**Date:** 2026-09-01
**Repo:** dj-circe, branch `feat/dj-onboarding`

## Problem

A colleague at DJ hit two distinct failures during Circe onboarding
and first tile use, both traceable to environmental assumptions the
app makes but doesn't enforce.

**Failure 1 — corporate TLS interception.** DJ machines run Zscaler,
which intercepts outbound HTTPS with its own root CA. Node's `fetch`
(via undici) uses its own bundled trust store, not the macOS keychain,
so it doesn't see the Zscaler root and rejects with
`UNABLE_TO_GET_ISSUER_CERT_LOCALLY` when the wizard tries to verify
the Bedrock token at Step 3. Hermes Python has the same problem
independently: it uses `certifi`'s bundle, not the macOS keychain, and
fails with `CERTIFICATE_VERIFY_FAILED` on any HTTPS call that goes
through Zscaler.

The Zscaler footprint on DJ machines isn't uniform — some hosts pass
through un-intercepted (bedrock-mantle wasn't intercepted on the
author's machine but was on the colleague's), so the failure is
non-deterministic across users. The workaround is trivial once you
know the shape (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`) but requires
a Slack thread and copy-paste; nobody's first Circe launch should be
gated on that.

**Failure 2 — opaque errors from Hermes over ACP.** When Hermes
returns a JSON-RPC error to Circe, the tile shows only
`msg.error.message` — usually a generic string like "Internal
error". The actual exception detail (traceback, error code, subsystem
name) lives in `msg.error.data` and `msg.error.code`, and Circe
throws both on the floor at `acpClient.js:334`. When the colleague's
Orchestrator crashed on `session/new`, the tile said "Internal
error" — no clue whether it was TLS, MCP, Bedrock, or a Hermes bug.
Debugging required a diagnostic-bundle command over Slack.

**Failure 3 — `HERMES_HOME` divergence between two code paths.**
`main.js:23` resolves the Hermes root as `process.env.HERMES_HOME ||
~/.hermes`. But `acpClient.js:20`'s `loadProfileEnv` reads
`~/.hermes/profiles/<slug>/.env` verbatim, ignoring `HERMES_HOME`.
When both agree on `~/.hermes` (the default case) nothing breaks,
but any launch with `HERMES_HOME` pointing elsewhere reads state
from one root and the profile's `.env` from another — the
`ANTHROPIC_API_KEY` never reaches Hermes and `session/new` fails at
auth. Latent today; will bite the first colleague who runs a
non-default HERMES_HOME (e.g., dev-sandbox mode with a live profile,
or a machine-wide env override).

**Failure 4 — no retry on transient Hermes failures.** ACP's
`session/new` currently fails hard on the first Hermes-side error.
Transient causes (network blip during MCP discovery, upstream
rate-limit during warm-up, Bedrock cold-start latency) manifest to
the user as a permanent tile crash requiring a full app restart.
Circe never gives Hermes a second chance even in the safe window
before any user message has been sent.

**Failure 5 — legacy state files trigger phantom onboarding.**
The wizard's first-run gate at `onboarding/main.js:22` returns
"needs onboarding" whenever `state.firstRunComplete !== true`.
State files that predate the onboarding wizard (created by earlier
Circe versions that just watched `~/.hermes/profiles/`) have neither
`firstRunComplete` nor `orchestratorProfile` set but do contain
years of tile transcripts. Upgrading Circe on those machines fires
the wizard, which then wants to *create* a new Orchestrator profile
even though the user already has five working ones. Mirror image of
Failure 3: same code, opposite direction — the state-dir side of
the coin. Discovered on the author's own machine while testing
the reliability fixes.

**Failure 6 — Hermes built-in `default` scaffold opened as a
Circe tile.** `hermes profile list` reports a `default` entry marked
`◆` — Hermes's own root-level config at `~/.hermes/config.yaml`,
not a user profile under `~/.hermes/profiles/default/`. `main.js:97-117`
consumes that listing and tries to filter `default` out with
`if (name === 'default' && !hasAvatar(name)) continue;`, where
`hasAvatar` (at `main.js:142-151`) checks whether `~/.hermes/avatar.{png,jpg,jpeg}`
exists. But Hermes ships an `avatar.png` at that path (~2.3MB, dated
Jul 15 on the author's install), so the filter fails and Circe
opens a `[acp:default]` tile against the Hermes-scaffold config.
That config has no Circe-written Bedrock provider block, so its
first `session/new` prompt hits whichever fallback provider Hermes
picks — which returned HTTP 529 OverloadedError on the author's
machine while five real profile tiles (`data`, `geordi`, `locutus`,
`troi`, `wesley`) worked fine against Bedrock-Mantle. The tile
displayed "Internal error" because of Failure 2 (opaque errors).
Confirmed by sending "test" from the `data` tile after diagnosis:
succeeded immediately. This may also be Jessica's underlying failure
mode if her Circe silently spawned a `default` tile alongside
`jessica-pearson` — the diagnostic bundle only captured her
Orchestrator's state, not any additional tiles.

## Goal

Make Circe survive a Zscaler-intercepted DJ machine on first launch
with no environment prep, and make any Hermes-side error that
reaches a tile self-describing enough that a colleague can screenshot
it instead of running diagnostic commands.

## Non-goals

- **Auto-detecting non-Zscaler corporate proxies.** If a future
  colleague is behind a different vendor's MITM, they'll still need
  to point Circe at their PEM manually. Zscaler covers 100% of the
  observed DJ population.
- **A general error-taxonomy system.** We're plumbing structured
  fields through one place — the ACP client — not rebuilding error
  handling app-wide.
- **Retrying after any user activity.** All retries in Fix 4 apply
  only to the pre-first-message window. Once a user has typed
  anything into a tile, we let errors surface immediately — silent
  retries after a message risks double-sends, hidden Hermes bugs,
  and confusing "wait, did it send?" states.
- **Retrying auth failures.** 401/403 responses and JSON-RPC
  code `-32601`/`-32602` (method-not-found / invalid params) never
  self-heal; retrying them is guaranteed waste.

## Design

### Fix 1: Auto-trust corporate CA roots

Two subsystems need the root: Node's `fetch` (used by
`bedrockClient.verify` at `bedrockClient.js:28-45`) and Hermes Python
(spawned by `profileWriter.createOrchestrator` and `acpClient.start`).

**Detection.** At app startup in `main.js` (before `whenReady`), run
`security find-certificate -a -c Zscaler -p /Library/Keychains/System.keychain`.
If it produces PEM output, we have a Zscaler root to trust. If not,
Circe was launched on a machine without Zscaler installed and we
skip everything below — behavior stays exactly as today.

**Building the trust bundle.** Write two files under
`app.getPath('userData')`:

1. `zscaler-root.pem` — the raw output of the `security` command
   above. Used as `NODE_EXTRA_CA_CERTS` for Node.
2. `python-ca-bundle.pem` — the concatenation of `certifi`'s bundle
   and the Zscaler root, in that order. Used as `SSL_CERT_FILE` for
   Hermes Python.

`certifi`'s bundle location isn't fixed on disk (it lives inside
whichever Python site-packages Hermes was installed against). We
resolve it by invoking `python3 -c "import certifi; print(certifi.where())"`
via the same Hermes Python that Hermes itself uses. If that fails
(certifi not installed, python3 not on PATH), we fall back to using
`zscaler-root.pem` alone as `SSL_CERT_FILE` — this trades
"connections to non-Zscaler public hosts might fail" against
"connections to Zscaler-intercepted hosts definitely succeed",
which is the correct trade for a corporate machine.

Rebuild both files on every app start if the Zscaler root's SHA-256
differs from the cached one. Costs nothing (~50ms) and keeps us
current if Zscaler rotates its root.

**Injection.** Both env vars go into `process.env` before any spawn:

- `process.env.NODE_EXTRA_CA_CERTS` — read by Node itself on startup
  for the current process. Set before any `fetch` call runs;
  because we set it in `main.js` at boot, this is guaranteed.
- `process.env.SSL_CERT_FILE` — inherited by every child spawn
  (Hermes Python via `acpClient.js:135` and `profileWriter.js:21`
  already do `env: { ...process.env, … }`).

**Respecting existing env.** If the user has already set either env
var themselves (advanced users, custom CA situations), don't
override. Log a note and skip.

**Failure mode: no Zscaler on the machine.** Skip the whole feature
silently. First-run works exactly as today for anyone off-VPN or on
a non-DJ machine.

**Failure mode: `security` command fails.** Log the error and skip.
Don't block startup on a diagnostic subcommand.

**Failure mode: `certifi.where()` fails.** Fall back to
zscaler-only bundle for `SSL_CERT_FILE`. Log the fallback.

### Fix 2: Surface structured ACP error data

One-line change in `acpClient.js:334` plus a two-line change in the
consuming code path.

Current:

```js
if (msg.error) p.reject(new Error(msg.error.message || 'rpc error'));
```

Replacement:

```js
if (msg.error) {
  const err = new Error(msg.error.message || 'rpc error');
  err.code = msg.error.code;
  err.data = msg.error.data;
  log.error(`acp rpc error [${this.profile}]`, msg.error);
  p.reject(err);
}
```

Three effects:

1. **Full error object always hits the electron log**, regardless of
   whether the caller inspects `err.data`. This is the biggest
   diagnostic win — the traceback is now one `Library/Logs/Circe/main.log`
   grep away, no diagnostic command needed.
2. **Callers can inspect `err.code` and `err.data`.** The one that
   matters is `main.js`'s IPC handler for `acp:newSession`, which
   currently forwards the error to the renderer via Electron's
   default `invoke` failure path. We change that path to serialize
   `data` and `code` alongside `message` so the tile can show them.
3. **The tile UI** in `renderer.js` (the tile renderer, not
   onboarding's — file to be confirmed during implementation) shows
   `err.data.detail` or `err.data.traceback` if present, otherwise
   falls back to today's message-only display.

The change is additive: any consumer that only reads `err.message`
keeps working identically.

### Fix 3: Honor `HERMES_HOME` in `loadProfileEnv`

Change `acpClient.js:20` to compute the profile path from the same
env var `main.js:23` uses. Move the resolution up to the module
scope so `HERMES_HOME` is evaluated once per process (matching
`main.js`'s behavior — env vars aren't re-read after startup).

Current:

```js
function loadProfileEnv(profile) {
  const envPath = path.join(os.homedir(), '.hermes', 'profiles', profile, '.env');
  ...
}
```

Replacement:

```js
const HERMES_HOME = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');

function loadProfileEnv(profile) {
  const envPath = path.join(HERMES_HOME, 'profiles', profile, '.env');
  ...
}
```

Fully backwards-compatible with the default case (`HERMES_HOME`
unset → falls back to `~/.hermes` → identical to today). Fixes the
divergence for anyone running with `HERMES_HOME` set.

### Fix 4: Auto-retry transient Hermes failures pre-first-message

Two failure paths get retries, both narrowly scoped.

**4a. ACP `session/new` retry.** In `acpClient.js`, wrap the
`session/new` request (and any other pre-first-message calls the
`newSession` flow makes) in a bounded retry loop:

- Max **3 attempts** (2 retries after initial failure)
- Backoff: **500ms**, then **1500ms** (fixed, no jitter — we're
  retrying at most once per second and once per 1.5 seconds, low
  enough volume to skip jitter complexity)
- **Retry-eligible errors:**
  - Network/timeout: any error where `err.code` is undefined
    (fetch/socket errors from the Hermes subprocess's outbound
    calls, surfaced as generic Error)
  - JSON-RPC internal error: `err.code === -32603` (the "Internal
    error" the colleague saw)
- **Non-retryable errors (fail fast):**
  - Subprocess died: `hermes acp exited (code)` — Hermes crashed;
    respawning is a different problem, not a retry
  - Method not found / invalid params: `err.code === -32601` or
    `-32602`
  - Any auth-shaped `err.data` (contains "unauthorized",
    "forbidden", "invalid token", "expired") — case-insensitive
    substring match on `err.data.detail` or `err.data.message`
- **Precondition:** the tile's session state must show
  `firstUserText === null` (persisted per-profile in
  `~/.hermes-tiles/state.json`). If the user has typed anything,
  we never retry — even on `-32603`.
- **User feedback:** on attempt 2 and 3, the tile shows "Retrying
  session start... (attempt N/3)" as a transient status message
  (not persisted to transcript). If all 3 fail, the final error
  (with Fix 2's full detail) lands in the transcript.
- **Opt-out:** environment variable `CIRCE_NO_RETRY=1` disables
  retries entirely. Advanced users on truly-broken machines who
  want the shortest feedback loop.
- Every attempt logs to Circe's main.log with attempt number,
  elapsed time since first attempt, and error code.

**4b. Bedrock verify retry.** In `bedrockClient.verify` at
`bedrockClient.js:28-45`, wrap the `fetch` call:

- Max **2 attempts** (1 retry after initial failure)
- Backoff: **1000ms** (single delay, fixed)
- **Retry-eligible errors:**
  - Network errors (`fetch` throws — the `catch` branch that today
    maps to `NETWORK_ERROR_COPY`)
- **Non-retryable errors (fail fast):**
  - HTTP 401/403 (auth) — the token is wrong or expired; retry
    won't help
  - HTTP 5xx or 4xx-non-auth — retrying `-1` time won't tell us
    anything a manual retry wouldn't
- **User feedback:** wizard log box shows "Retrying Bedrock
  verification..." between attempts. Wizard doesn't hang silently.
- **Opt-out:** same `CIRCE_NO_RETRY=1` env var.

Retry helper lives in a new `retryUtil.js` (both call sites use it;
DRY across the two subsystems). Tests cover attempt counts,
backoff timing (via a fake clock), retry-eligibility branching,
and opt-out.

### Fix 5: Adopt legacy state files instead of re-onboarding

Change the first-run gate at `onboarding/main.js:22` from a pure
state-file check into a two-signal check:

- **Signal A (today):** does `state.firstRunComplete === true`?
- **Signal B (new):** does `<HERMES_HOME>/profiles/` contain at
  least one directory whose name isn't `_scratch`?

Rule:

- Signal A true → skip wizard (as today)
- Signal A false, Signal B true → **adopt**: skip wizard, back-fill
  `firstRunComplete=true` and set `orchestratorProfile` to the
  first non-`_scratch` profile alphabetically, then continue to
  `openAllTiles()`. Log a one-liner: "Adopted N existing profile(s);
  wizard skipped."
- Both false → wizard (as today, true first-run case)

The adoption path is a one-time write on next launch. If the user
disagrees with the chosen Orchestrator profile, they can edit
`state.orchestratorProfile` directly or run `reset:onboarding` to
re-do the wizard.

**Why the `_scratch` exclusion:** the sandbox setup script
(`dev-onboarding.sh:10`) creates a `_scratch` profile subdirectory
that isn't a real profile. Diagnostic captures on both machines
confirmed `_scratch` shows up in the profiles listing.

**Rollout risk:** the only case this changes is "wizard would have
fired AND `~/.hermes/profiles/` has real content" — which by
definition is a user with existing profiles being asked to
"complete first-run setup." Adoption is strictly better than
today's behavior for that population.

### Fix 6: Filter Hermes built-in `default` scaffold from the tile list

Replace the avatar-existence heuristic at `main.js:113` with a check
that answers the actual question: does this profile have a directory
under `<HERMES_HOME>/profiles/`?

Current:

```js
if (name === 'default' && !hasAvatar(name)) continue;
```

Replacement:

```js
if (name === 'default' && !fs.existsSync(path.join(HERMES_HOME, 'profiles', 'default'))) {
  continue;
}
```

`hasAvatar` and its call site become dead code — remove both.

**Why this is right.** `hermes profile list` returns Hermes's own
root-level `default` (marked `◆` in the CLI output) alongside user
profiles because Hermes uses that entry as its "no `-p` flag"
fallback config. From Circe's perspective, it's not a profile: no
Circe-written `config.yaml`, no Bedrock provider block, and no
persistent identity. Presence of `~/.hermes/profiles/default/`
is a strictly stronger signal than `~/.hermes/avatar.png` — an
avatar.png can be shipped by Hermes, dropped there manually, or
survive a profile deletion; a `profiles/default/` directory only
exists if the user (or a Circe wizard flow) explicitly created it.

The scoping to `name === 'default'` is deliberate: this is a
Hermes-scaffold-only concern. Every non-`default` profile passes
through unchanged, which preserves today's behavior for
`data`/`geordi`/`locutus`/... and for any future profile a user
might legitimately name.

**Interaction with Fix 5.** Fix 5's adoption path also enumerates
`<HERMES_HOME>/profiles/` and treats non-`_scratch` directories as
real profiles. The same filesystem check is authoritative in both
places — if `profiles/default/` doesn't exist, Fix 6 filters it out
of the tile list AND Fix 5 doesn't consider it an existing profile
for adoption purposes. Consistent semantics across both fixes.

**Non-issue: user *does* have a `profiles/default/`.** If a user
has genuinely created a Circe-managed profile named `default`,
the directory exists, the filter doesn't skip, and Circe opens
a tile against it. That's the correct behavior and matches the
pre-fix intent.

## What the renderer already does (unchanged)

The tile renderer already displays error messages inline in the
transcript with a distinct `cls: 'error'` style
(`.hermes-tiles/state.json` shows `"cls": "error"` on the
colleague's captured "Internal error" message). Adding more text to
the same message field is a no-op UI change — just a longer string.

## Testing

**Fix 1:**

- **Unit-ish:** a test that stubs `child_process.spawn` for
  `security find-certificate`, feeds it a fake PEM, and asserts that
  `zscaler-root.pem` and `python-ca-bundle.pem` land in the expected
  paths with the expected contents.
- **Manual, sandboxed on the author's machine:** `npm run
  dev:onboarding` with an artificially planted fake Zscaler PEM →
  verify both env vars are set in the spawned Hermes subprocess by
  reading the diagnostic marker file (`~/.hermes/circe-last-spawn-*.txt`).
  Add PEM sha256 and cert-count to that file.
- **Manual, on a real DJ machine (colleague's):** `npm start` with
  no env prep → wizard completes end-to-end without any
  `NODE_EXTRA_CA_CERTS` or `SSL_CERT_FILE` in the command line.

**Fix 2:**

- **Unit test:** feed `_onStdout` a JSON-RPC error payload with
  `code`, `message`, and `data` fields. Assert the rejected error
  carries `err.code === payload.code` and `err.data` deep-equal to
  `payload.data`.
- **Manual:** trigger any known-failing ACP call (easiest reproducer:
  spawn Hermes with a broken Bedrock config) → observe that the log
  entry contains the full payload and the tile shows the extra
  detail.

**Fix 3:**

- **Unit test:** with `HERMES_HOME=/tmp/testhermes` set,
  `loadProfileEnv('foo')` reads from `/tmp/testhermes/profiles/foo/.env`,
  not `~/.hermes/profiles/foo/.env`.
- **Regression test:** with `HERMES_HOME` unset, behavior is
  identical to today (reads `~/.hermes/profiles/<slug>/.env`).

**Fix 4:**

- **Unit test (4a):** stub the ACP transport to fail twice with
  `-32603` then succeed; assert the caller sees the success value.
  Stub to fail three times; assert the caller sees the third
  error. Stub to fail with `-32601`; assert the caller sees that
  error immediately with no retry.
- **Unit test (4a precondition):** simulate a tile whose state has
  `firstUserText !== null`; assert no retries happen even on
  `-32603`.
- **Unit test (4b):** stub fetch to throw once then succeed;
  assert verify returns `{ok: true}`. Stub to return 401; assert
  no retry, AUTH_ERROR_COPY returned immediately.
- **Manual:** on the author's machine, artificially kill hermes
  after `session/new` reception but before response
  (`SIGSTOP` the pid mid-call, `SIGCONT` after 800ms) → observe
  the retry succeeds and the tile opens normally.

**Fix 5:**

- **Unit test:** with `HERMES_HOME=/tmp/testhermes` containing
  `profiles/foo/` and `profiles/_scratch/`, and state file with
  no `firstRunComplete`, first-run gate returns false (skip
  wizard) and orchestratorProfile is written as `'foo'`.
- **Unit test:** with only `profiles/_scratch/` present, first-run
  gate returns true (wizard fires) — `_scratch` alone doesn't
  count as onboarded.
- **Regression test:** with `firstRunComplete=true` and no
  profiles dir at all, first-run gate returns false (skip
  wizard). Today's behavior preserved.
- **Manual, on the author's machine:** after resetting live
  state to pre-Fix-5 conditions
  (`node -e "s=…;delete s.firstRunComplete;delete s.orchestratorProfile;fs.writeFileSync(p,JSON.stringify(s))"`),
  `npm start` skips the wizard, opens all five existing profile
  tiles, logs "Adopted 5 existing profile(s); wizard skipped."

**Fix 6:**

- **Unit test:** with `HERMES_HOME=/tmp/testhermes` and no
  `profiles/default/` directory, `loadProfiles()` skips the
  `default` entry from a mocked `hermes profile list` output.
- **Unit test:** with `HERMES_HOME=/tmp/testhermes` containing a
  `profiles/default/` directory, `loadProfiles()` includes `default`
  in the returned list. Rare-but-legal case.
- **Regression test:** non-`default` profile names are always
  included regardless of directory existence check (avoids the
  filter accidentally over-scoping).
- **Manual, on the author's machine:** `npm start` opens exactly
  five tiles (`data`, `geordi`, `locutus`, `troi`, `wesley`), not
  six. No `[acp:default]` process in the logs. No 529.

## Out of scope

- Rebuilding Circe's error UI. The tile just gets a longer message
  string. If we later want an "expand for traceback" affordance,
  that's a follow-up.
- Cert bundle refresh on a schedule. We refresh at every app
  start; that's frequent enough given how rarely a corporate root
  rotates.
- Auto-detecting other Zscaler-adjacent proxies (Netskope, Palo
  Alto, etc.). Add on demand.
- The ergonomic hazard where the README's ordering (`dev:onboarding`
  listed before `npm start`) invited the author's mistake in this
  incident. Handled separately as a docs/UX fix — not a reliability
  fix.

## Open questions

None blocking. Deferred:

- Whether Fix 1 should also pin `NODE_TLS_REJECT_UNAUTHORIZED=1`
  explicitly (defense-in-depth against future env pollution). Add if
  it comes up.
- Whether `err.data.traceback` should be shown *inline* or under a
  "Show details" toggle. Depends on how long real Hermes tracebacks
  are in practice; revisit after we've seen a few.
