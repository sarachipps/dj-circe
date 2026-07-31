# Circe — Home Machine Rebuild Spec

**Audience:** the Hermes instance running on Sara's home Mac. You are being
asked to **rebuild** a small local Electron app called **Circe** from scratch —
there is no repo to clone, no npm package to install, and no git remote. This
document is the complete spec. Everything you need to type is here.

**Why rebuild instead of copy:** Circe lives only on Sara's DJ work laptop and
cannot be published to her personal GitHub. She'd rather you build a fresh copy
from this spec than smuggle a tree across machines.

---

## What Circe is

A local Electron app that presents each of Sara's Hermes **profiles** as its
own side-by-side tile window. Each tile:

- Has its own tab strip, transcript, composer, avatar, display name, and
  colour theme keyed to the profile.
- Talks JSON-RPC over stdio to a dedicated `hermes -p <profile> acp
  --accept-hooks` subprocess (Agent Client Protocol). One subprocess per
  tile, spawned on tile open and killed on tile close.
- Has a per-tile **access-mode gate** in the header: `🔒 locked` (auto-deny
  every tool permission request), `⛔ ask` (surface inline Allow/Deny cards
  in the transcript, block until the user clicks), `🔓 unlocked` (auto-approve
  every request). Cycles on click; persists per-profile.
- Persists tab state, window bounds, and access mode in
  `~/.hermes-tiles/state.json` so tiles restore across restarts.

No framework — bare DOM in the renderer, `marked` for markdown rendering,
`electron-log` for logging. No build step, no bundler, no hot reload.

---

## The home fleet (Hitchhiker's Guide)

**You already have profiles on this machine.** Do NOT rename them, do NOT
create new ones just to match some canonical list. Circe auto-discovers
whatever `hermes profile list` returns.

Sara has said the home profiles are Hitchhiker's-Guide-themed. Your job
during rebuild is to:

1. Run `hermes profile list` and record the exact names + models.
2. Ask Sara which profile (if any) plays the "coding-with-file-writes" role
   — that one goes into `LOCKED_BY_DEFAULT` so it opens in 🔒 mode by
   default.
3. Draft per-profile CSS colour blocks matching the actual names, show them
   to Sara for approval before applying (see §5 Adaptations).

---

## Prerequisites — verify before you write any code

Run these and confirm each one before proceeding.

```
# 1. Hermes CLI on this machine
ls -la ~/.local/bin/hermes || which hermes
# Circe hardcodes ~/.local/bin/hermes. If yours lives elsewhere, either:
#   ln -s $(which hermes) ~/.local/bin/hermes
# or plan to edit HERMES_BIN in both main.js and acpClient.js during build.

# 2. Node.js 18+ and npm
node -v && npm -v

# 3. Hermes profile listing works
hermes profile list
# You should see a table with one row per profile. Circe parses this output
# with the regex: /^\s*[◆◇•]?\s*([A-Za-z0-9_-]+)\s+(\S+)/  — if your CLI
# emits a different format, this regex needs updating.

# 4. ACP mode spawns cleanly
hermes -p <one-of-your-profiles> acp --accept-hooks
# Should print an initialize request or wait on stdin. Ctrl+C to exit.
# If this errors, stop and fix Hermes before building Circe.

# 5. Existing tile state (from your question)
ls -la ~/.hermes-tiles/ 2>/dev/null || echo "no existing state dir — clean start"
# If ~/.hermes-tiles/state.json exists, Circe will pick up saved window
# bounds/tabs/access-modes automatically on first launch. That's fine —
# it's just a default Hermes location that happens to match Circe's.
# Not a real conflict unless something else is writing to it.
```

---

## Directory layout to create

```
~/Code/circe/
├── package.json
├── index.html
├── main.js
├── preload.js
├── acpClient.js
├── renderer.js
├── styles.css
└── node_modules/          (created by `npm install`)
```

No `scripts/`, no `dist/`, no build artifacts. Just seven files.

---

## Build steps

### Step 1: Project init

```
mkdir -p ~/Code/circe && cd ~/Code/circe
```

Write `package.json` with content exactly:

```json
{
  "name": "circe",
  "productName": "Circe",
  "version": "0.1.0",
  "description": "Circe — tiled Electron UI for chatting with multiple Hermes agents",
  "main": "main.js",
  "scripts": {
    "start": "electron ."
  },
  "devDependencies": {
    "electron": "^32.0.0"
  },
  "dependencies": {
    "electron-log": "^5.4.4",
    "marked": "^18.0.6"
  }
}
```

Then:

```
npm install
```

That gives you Electron 32, electron-log, and marked in `node_modules/`.

### Step 2: Write the six source files

Each file is transcribed below in full. Copy them verbatim, then apply the
home-machine adaptations in §5.

**Note on line counts / bytes:** these files together are ~60 KB. Sara's
copy: `main.js` ~12.5 KB / 414 lines, `acpClient.js` ~11 KB / 346 lines,
`preload.js` ~1.8 KB / 42 lines, `renderer.js` ~22 KB / 658 lines,
`index.html` ~1.4 KB / 49 lines, `styles.css` ~13.5 KB / 651 lines. Use
these as sanity checks after writing — if your version is dramatically
smaller/larger, you missed something.

**How to get the file contents:** ask Sara. This spec deliberately
does not include ~60 KB of source dumps — Sara will paste the six files
directly (or point you at a copy she's put on a shared location like a
USB stick or password manager attachment). Each file below has a
"Contract" section describing what it must do; use that as your
acceptance test after writing.

### Step 3: First run

```
cd ~/Code/circe && npm start
```

You should get one Electron window per Hermes profile.

---

## File contracts (what each file must do)

Use these as acceptance criteria. If Sara's pasted source doesn't match a
contract, one of them is wrong — surface the discrepancy, don't silently
paper over it.

### `package.json` — already covered above

- Main entry: `main.js`
- `npm start` runs `electron .`
- Exact deps: `electron ^32.0.0` (devDep), `electron-log ^5.4.4`,
  `marked ^18.0.6`.

### `index.html`

- Single tile shell. Header (h2 name, .model span, access button, avatar
  div), tabs row (tab-strip + new-tab button), transcript div, composer
  form with input + send button.
- Loads `styles.css`, then `node_modules/marked/lib/marked.umd.js`, then
  `renderer.js`. Order matters — renderer expects `window.marked`.

### `main.js` (Electron main process)

Contract:

- `app.setName('Circe')` on startup. Initialize `electron-log`.
- Constants:
  - `HERMES_BIN = ~/.local/bin/hermes` (edit if your Hermes lives elsewhere).
  - `HERMES_HOME = process.env.HERMES_HOME || ~/.hermes`.
  - `STATE_DIR = process.env.HERMES_TILES_STATE_DIR || ~/.hermes-tiles`.
  - `TILE_W=520`, `TILE_H=620`, `GAP=16`, `MARGIN=40`.
- Load `~/.hermes-tiles/state.json` on boot into `stateCache`; write it back
  on every access-mode / bounds / tabs change.
- `ACCESS_MODES = ['locked', 'ask', 'unlocked']`.
- `LOCKED_BY_DEFAULT = new Set([...])` — profiles that open in 🔒 mode by
  default. **On the home machine, populate this with the coding-role
  Hitchhiker profile Sara names in §5, or leave `new Set()` if none.**
- `getAccessMode(profile)` reads from stateCache with LOCKED_BY_DEFAULT
  fallback; `setAccessMode(profile, mode)` validates + persists.
- `loadProfiles()` runs `hermes profile list`, strips ANSI, parses each
  matching line with regex `^\s*[◆◇•]?\s*([A-Za-z0-9_-]+)\s+(\S+)` → `{name,
  model}`. Skips `Profile` header and separator rows.
- `readDisplayName(profile)` reads
  `~/.hermes/profiles/<name>/SOUL.md` (or `~/.hermes/SOUL.md` for
  `default`), returns:
  1. First `# Heading` line (regex `^#\s+([A-Za-z0-9_ '-]+?)(?:\s*[—–-]|$)`),
     stopping at em/en/hyphen dash.
  2. Fallback: capture from `You are <Name>` pattern.
  3. Fallback: the profile name itself.
- `loadAvatarDataUrl(profile)` looks for `avatar.{png,jpg,jpeg,gif,webp}`
  in the profile dir, returns a `data:` URL or empty string.
- `createTileWindow(profile, index)`:
  - `BrowserWindow` sized `520×620`, positioned via `positionFor()`
    (grid tiles across the primary display work area), or restored from
    saved bounds.
  - `title: 'circe · <displayName>'`, transparent, `hiddenInset` titlebar,
    `hasShadow: false`, `backgroundColor: '#00000000'`.
  - `webPreferences`: `preload: preload.js`, `contextIsolation: true`,
    `nodeIntegration: false`, `sandbox: false`,
    `additionalArguments: ['--profile-name=X', '--profile-display=Y',
    '--profile-model=Z']`.
  - External links open in the OS browser (via `setWindowOpenHandler` and
    `will-navigate`).
  - Spawns an `AcpClient` bound to the profile with `onUpdate` /
    `onExit` / `onPermissionRequest` forwarding to
    `win.webContents.send(...)`.
  - Debounced (300ms) save of window bounds on `resize`/`move`.
- `syncTiles()` opens a new tile for any profile in `hermes profile list`
  not already open. Called on boot and from a `fs.watch` (debounced 600ms)
  on `~/.hermes/profiles/`. **Watch-on-create is what makes new profiles
  auto-open a tile without restarting Circe.**
- IPC handlers:
  - `avatar:get` → data URL for the tile's profile.
  - `state:load` → `{tabs, activeIndex}` for the tile.
  - `state:save` → merges tabs+activeIndex into `stateCache.profiles[name]`.
  - `acp:newSession` → `client.newSession()` → `{sessionId}`.
  - `acp:loadSession` → `client.loadSession(id)` → `{ok, sessionId|error}`.
  - `acp:prompt` → `client.prompt(sessionId, text)`.
  - `acp:cancel` → `client.cancelSession(sessionId)`.
  - `access:get` → `{mode}`.
  - `access:set` → validate + persist + push to `AcpClient.setAccessMode`.
  - `access:respond` → `client.resolvePermission(requestKey, optionId)`.

### `acpClient.js` (ACP transport, one per tile)

Contract:

- Exports `class AcpClient`. Constructor takes `{profile, cwd, onUpdate,
  onExit, onPermissionRequest, accessMode}`.
- `HERMES_BIN = ~/.local/bin/hermes` (same caveat as main.js).
- `loadProfileEnv(profile)` parses `~/.hermes/profiles/<name>/.env`:
  - Regex: `^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$`
  - Skip blanks and `#` comments; strip matching single or double quotes.
  - Return `{}` on any read/parse failure (silent — spawn proceeds with
    whatever env is present).
- `start()`:
  - Merge env: `{...process.env, ...loadProfileEnv(profile),
    HERMES_ACCEPT_HOOKS: '1'}`. Per-profile `.env` beats parent shell so
    Finder/Dock launches work without a pre-loaded shell env.
  - Write a diagnostic marker file to
    `~/.hermes/circe-last-spawn-<profile>.txt` containing timestamp,
    `HERMES_HOME`, whether `ANTHROPIC_API_KEY` is set and its length/prefix,
    and whether `PATH` contains `.local/bin`. **Do not skip this** — it's
    Sara's first-line-of-defence for auth debugging.
  - Spawn `hermes -p <profile> acp --accept-hooks` with `stdio: ['pipe',
    'pipe', 'pipe']`.
  - Send `initialize` with:
    ```
    { protocolVersion: 1,
      clientCapabilities: { fs: {readTextFile: true, writeTextFile: true},
                            terminal: false },
      clientInfo: { name: 'hermes-tiles', version: '0.1' } }
    ```
- `newSession()` sends `session/new` `{cwd, mcpServers: []}` → returns
  `sessionId`.
- `loadSession(id)` sends `session/load` `{cwd, sessionId, mcpServers: []}`.
- `prompt(sessionId, text)` sends `session/prompt` `{sessionId, prompt:
  [{type: 'text', text}]}`.
- `cancelSession(sessionId)` sends `session/cancel` `{sessionId}`; swallows
  errors.
- **Permission gate — the heart of Circe.** On incoming
  `session/request_permission` RPC:
  - Mode `unlocked`: reply immediately with the first allow-classified
    option, else `opts[0]`.
  - Mode `locked`: reply with the reject-classified option if one exists,
    else `{outcome: 'cancelled'}`. Also fire
    `onPermissionRequest({resolved: 'locked', toolCall, options})` so the
    renderer can show a "denied" card for provenance.
  - Mode `ask`: park `{rpcId, params}` in `_pendingPermissions` keyed by
    `p<n>`, fire `onPermissionRequest({requestKey, resolved: null,
    toolCall, options})`. Wait for `resolvePermission(requestKey,
    optionId)` from main.
  - Classification helpers `isAllowOption` / `isRejectOption`: check ACP
    `kind` prefix (`allow_*` / `reject_*`) first, then keyword-match on
    `name`/`optionId` (`/allow|approve|yes|accept|permit/i` vs
    `/reject|deny|no|cancel|decline|refuse/i`).
- Handle two incoming server-request methods for filesystem passthrough:
  - `fs/read_text_file` → `fs.readFileSync(params.path, 'utf8')` → reply
    `{content}` or `-32603` on error.
  - `fs/write_text_file` → `fs.writeFileSync(params.path, params.content)`
    → reply `{}` or `-32603`.
  - Anything else → `-32601 method not implemented`.
- On child exit: reject all in-flight `_pending` promises, call `onExit(code)`.
- `stop()` cancels pending permissions and kills the child.

### `preload.js` (contextBridge)

Contract:

- Uses `contextBridge.exposeInMainWorld('hermes', {...})`.
- Reads profile identity from `process.argv` prefixed args
  (`--profile-name=`, `--profile-display=`, `--profile-model=`) into
  `hermes.profile = {name, display, model}`.
- Exposes methods:
  - `getAvatar()`, `loadState()`, `saveState(state)`.
  - `newSession()`, `loadSession(id)`, `prompt(id, text)`, `cancel(id)`.
  - Event subscribers: `onUpdate(fn)`, `onError(fn)`, `onExit(fn)`.
  - Access nested object: `access.get()`, `access.set(mode)`,
    `access.respond(requestKey, optionId)`, `access.onRequest(fn)`.
- Wires `electron-log/renderer` into `console.*` so renderer logs appear
  in Circe's main log file.

### `renderer.js`

Contract:

- Reads `window.hermes.profile` and paints:
  - `#profile-name` text = `profile.display`.
  - `#profile-model` text = `profile.model`.
  - `document.title = 'hermes · <display>'`.
  - `document.body.dataset.profile = profile.name` — **this is the hook
    the CSS uses to apply per-profile theming.**
  - `#avatar`: try `getAvatar()`, else initial-letter fallback with
    `.avatar-fallback` class.
- Tabs are per-tile in-memory list (`tabs[]`, `tabsById`); each has
  `{id, sessionId, defaultLabel, messages, busy, waiting, firstUserText,
  pendingBubble, agentText, toolBubble, starting, replaying}`.
- Tab labels: first 22 chars of the tab's first user message, ellipsised;
  fallback `Tab N`.
- **Access-mode button** (`#access-btn`):
  - Cycles `locked → ask → unlocked → locked` on click.
  - Icon+tooltip via `ACCESS_META` map.
  - Sets `button.dataset.mode` — CSS uses `.access-btn[data-mode='locked']`
    etc. for the coloured ring around the button.
  - On leaving `ask` mode, resolves all open permission cards with
    `null` (cancelled) via `resolveAllPendingPermissionCards()`.
- **Permission cards:** rendered inline in the transcript when access-mode
  is `ask`, with Allow/Deny buttons. On click, disable the whole row
  (prevent double-fire), call `access.respond(requestKey, optionId)`, and
  mutate the card to show `✓ <label>`. Also handles `resolved: 'locked'`
  informational cards. Not persisted (RPC is invalidated on process exit).
- **Streaming:** `onUpdate` handles `agent_message_chunk` (append to a
  live agent bubble, re-render markdown into it as it grows) and
  `tool_call` / `tool_call_update` (render/update a `⚙ <tool>` bubble).
- **Scroll-to-bottom hardening** — reproduce this exactly:
  - Global `transcriptGen` counter, bumped on every `renderTranscript()`.
  - `scrollTranscriptToBottom()` captures `gen`, then snaps 4 ways:
    (1) immediate, (2) `requestAnimationFrame`, (3) `setTimeout(120ms)`,
    (4) `load`/`error` handlers on every not-yet-loaded `<img>` in the
    transcript. All four bail if `gen !== transcriptGen`.
  - `visibilitychange` and `pageshow` listeners call it — this is the fix
    for macOS lid-close/lid-open parking tiles mid-transcript.
  - Boot also awaits `document.fonts.ready` and re-snaps.
- **Persistence:** debounced 250ms `saveState()` on tab changes; strips
  `tool` and `permission` role messages from the payload. `beforeunload`
  also flushes.
- **Composer submit:** if busy, `Send` becomes `Stop` and calls
  `cancel(sessionId)`, appending `⏹ stopped` as an error bubble.

### `styles.css`

Contract:

- `:root` provides default (purple-ish) CSS variables:
  `--tile-bg`, `--tile-border`, `--text`, `--muted`, `--input-bg`,
  `--user-bg`, `--agent-bg`, `--tab-bg`, `--tab-active-bg`,
  `--tab-hover-bg`, `--tab-border`, `--accent`, `--accent-soft`,
  `--accent-glow`.
- **Per-profile overrides** via `body[data-profile='<name>']` — this is
  where each Hitchhiker's-themed profile gets its own colour block.
  Each block overrides `--tile-bg`, `--tile-border`, `--accent`,
  `--accent-soft`, `--accent-glow`. See §5 for the palette.
- Tile chrome: `border-radius: 20px`, `backdrop-filter: blur(24px)
  saturate(140%)`, transparent background, top titlebar area is
  `-webkit-app-region: drag` (so you can move the tile by grabbing the
  top), all interactive children opt back out with `no-drag`.
- Access button ring colours (fixed, independent of profile theme):
  - `data-mode='locked'` → red ring.
  - `data-mode='ask'` → amber ring.
  - `data-mode='unlocked'` → green ring.
- Permission card: full-tile-width, amber-bordered, Allow buttons green,
  Deny buttons red. Resolved cards fade to grey/opaque.

---

## 5. Home-machine adaptations (do this before first run)

### 5a. Pick the `LOCKED_BY_DEFAULT` profile

Ask Sara: **"Which of the home Hitchhiker profiles is the coding /
file-writing one that should open in 🔒 mode by default?"**

Common answers by character:
- `marvin` — depressed but competent, does the work grudgingly.
- `deepthought` — thinks hard before acting.
- `slartibartfast` — actually builds things (planet designer).

Whatever she says, put it in `main.js`:

```js
const LOCKED_BY_DEFAULT = new Set(['<name>']);
```

If she says "none," leave `new Set()`.

### 5b. Draft per-profile CSS colour blocks

**Enumerate first, theme second.** Run `hermes profile list`, note every
name. For each one, propose a colour block that fits the character. Show
the draft to Sara for approval before writing to `styles.css`.

Suggested starting palette (Sara has veto):

| Profile          | Vibe                                    | `--accent`  |
|------------------|-----------------------------------------|-------------|
| `arthur`         | dressing-gown blue, tea-brown accents   | `#93c5fd`   |
| `ford`           | Betelgeusian burnt-orange, towel-tan    | `#fb923c`   |
| `zaphod`         | outrageous magenta+gold, two-headed     | `#e879f9`   |
| `trillian`       | deep navy + stellar white               | `#c7d2fe`   |
| `marvin`         | depressive gunmetal grey, dim glow      | `#94a3b8`   |
| `slartibartfast` | fjord ice blue + coastline green        | `#67e8f9`   |
| `deepthought`    | matte black + cyan 42-lit               | `#22d3ee`   |
| `vogon`          | bureaucratic beige + regulation yellow  | `#facc15`   |
| `default`        | keep the Picard-red? or reassign to     | Sara picks  |
|                  | whichever profile is `default` on home  |             |

For each profile, write a CSS block like:

```css
/* Marvin — depressive gunmetal, dim glow */
body[data-profile='marvin'] {
  --tile-bg: rgba(40, 45, 52, 0.85);
  --tile-border: rgba(148, 163, 184, 0.4);
  --accent: #94a3b8;
  --accent-soft: rgba(148, 163, 184, 0.7);
  --accent-glow: rgba(148, 163, 184, 0.18);
}
```

**The selector name must be exactly the profile name** — Circe sets
`body.dataset.profile` verbatim from `hermes profile list`.

If a profile has no block, it falls back to the `:root` purple defaults.
Harmless but ugly.

### 5c. Profile display names via SOUL.md

For each profile, make sure `~/.hermes/profiles/<name>/SOUL.md` starts
with `# <Display Name> — <tagline>`. Examples:

- `# Marvin — the Paranoid Android`
- `# Deep Thought — 7½-million-year problem solver`
- `# Slartibartfast — planetary coastline engineer`

If SOUL.md still has the boilerplate `You are Hermes Agent…` from
`hermes profile create`, the tile title will read "Hermes" until you
overwrite it. Rewrite SOUL.md immediately after creating any profile
and close/reopen the tile.

### 5d. Avatars (optional)

Drop `avatar.{png,jpg,jpeg,gif,webp}` into each
`~/.hermes/profiles/<name>/` (or `~/.hermes/` for the `default` profile).
Circe will load and embed as a data URL. Missing avatar → shows the
profile's first initial in a coloured circle. No action required if you
don't have artwork.

### 5e. HERMES_BIN path (only if needed)

If `~/.local/bin/hermes` doesn't exist on the home machine:

Either symlink:
```
mkdir -p ~/.local/bin
ln -s "$(which hermes)" ~/.local/bin/hermes
```

Or edit both `main.js` and `acpClient.js`:

```js
const HERMES_BIN = '/opt/homebrew/bin/hermes';  // or wherever
```

---

## 6. First run

```
cd ~/Code/circe
npm start
```

Expected:

- One window per profile from `hermes profile list`.
- Header shows display name (from SOUL.md), model name, avatar (or
  initial fallback), and the access button.
- Typing in the composer streams a response into the transcript.
- Marker file `~/.hermes/circe-last-spawn-<profile>.txt` appears for
  every profile Circe spawned.

---

## 7. Smoke test (in order)

1. **All expected tiles opened?** If not, check `~/Library/Logs/Circe/main.log`.
2. **Display names correct?** If a tile says "Hermes" or the raw profile
   name, SOUL.md is wrong (§5c). Fix SOUL.md, `Cmd+Q`, `npm start`.
3. **Themes applied?** If a tile shows the default purple instead of its
   profile theme, either the `body[data-profile='<name>']` block is
   missing, or the CSS selector doesn't match the profile name exactly.
   Confirm with `document.body.dataset.profile` in the Electron devtools
   (View → Toggle Developer Tools).
4. **Access button cycles?** Click it — should cycle 🔓 → 🔒 → ⛔ → 🔓
   with a coloured ring change. State persists across restart.
5. **Ask a profile to write a file** in 🔒 mode — expect a "denied" card.
   In ⛔ mode — expect an Allow/Deny card, and the file only appears
   after clicking Allow.
6. **Restart persistence** — `Cmd+Q`, `npm start`. Tabs should restore,
   window positions restore, access modes restore.

---

## 8. Runtime file locations (nothing goes back into the source tree)

- `~/.hermes-tiles/state.json` — per-profile tabs, bounds, access modes.
  Safe to delete: everything reverts to defaults.
- `~/.hermes/circe-last-spawn-<profile>.txt` — one-line marker per spawn
  showing env-loading status. First place to look on auth errors.
- `~/Library/Logs/Circe/main.log` — electron-log output.
- `~/.hermes/profiles/<name>/logs/agent.log` — the **Hermes** log for
  each subprocess. Circe doesn't own it, but you'll read it constantly.

---

## 9. Known gotchas (all inherited from the DJ tree)

- **New-profile scaffold collision:** `hermes profile create <name>`
  writes a boilerplate SOUL.md starting `You are Hermes Agent…`. Circe's
  `fs.watch` may fire and open a tile before you've replaced it, showing
  the title as "Hermes". Write the real `# <Name> — <tagline>` line into
  SOUL.md immediately after creating a profile and close/reopen the tile.
- **`HERMES_BIN` is hardcoded.** See §5e.
- **Scroll-anchor on wake:** already fixed via `visibilitychange` and
  `pageshow` handlers, but if you ever wake a tile scrolled mid-transcript
  that's what regressed.
- **Cancelling `ask` mid-card:** if the user cycles the access button
  away from `ask` while cards are open, the renderer must fire
  `resolveAllPendingPermissionCards(null)` so the parked Hermes RPCs
  don't hang.

---

## 10. When you're done, report back with

1. Full profile list Circe discovered (names + models + display names).
2. Which profile you put in `LOCKED_BY_DEFAULT`.
3. The palette table you actually shipped (with Sara's approvals noted).
4. Any deviations from this spec that were necessary — those become
   follow-up patches to this doc.
5. Contents of any `circe-last-spawn-<profile>.txt` that showed
   `ANTHROPIC_API_KEY=(UNSET)` — those profiles have `.env` loading
   issues Sara needs to know about.

Do **not** `git init` this tree, do **not** push to any remote. Circe
stays local, on this machine, forever.

---

## 11. Source files (paste each verbatim into `~/Code/circe/<filename>`)

The seven files below are the complete source. Write them exactly as
shown. After writing each `.js` file run `node --check <file>` to catch
paste errors. Then apply the §5 adaptations and run `npm start`.

**Order to write:** package.json → index.html → styles.css → preload.js
→ acpClient.js → main.js → renderer.js. The first six can go in any
order; renderer.js is longest, save it for last.

### 11.1 `package.json`

Already shown in §Step 1. Repeated here for completeness:

```json
{
  "name": "circe",
  "productName": "Circe",
  "version": "0.1.0",
  "description": "Circe — tiled Electron UI for chatting with multiple Hermes agents",
  "main": "main.js",
  "scripts": {
    "start": "electron ."
  },
  "devDependencies": {
    "electron": "^32.0.0"
  },
  "dependencies": {
    "electron-log": "^5.4.4",
    "marked": "^18.0.6"
  }
}
```

### 11.2 `index.html`

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Hermes Tile</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <div class="tile">
      <header>
        <div class="identity">
          <h2 id="profile-name"></h2>
          <span class="model" id="profile-model"></span>
        </div>
        <div class="header-controls">
          <button
            id="access-btn"
            class="access-btn"
            type="button"
            title="Access mode"
            aria-label="Cycle file-access mode"
          >
            <span class="access-icon" aria-hidden="true">🔓</span>
          </button>
          <div class="avatar" id="avatar" aria-hidden="true"></div>
        </div>
      </header>
      <div class="tabs" id="tabs">
        <div class="tab-strip" id="tab-strip"></div>
        <button
          id="new-tab"
          class="new-tab"
          title="New workstream"
          type="button"
          aria-label="New workstream"
        >
          +
        </button>
      </div>
      <div class="transcript" id="transcript"></div>
      <form id="composer">
        <input id="input" type="text" autocomplete="off" />
        <button id="send" type="submit">Send</button>
      </form>
    </div>
    <script src="node_modules/marked/lib/marked.umd.js"></script>
    <script src="renderer.js"></script>
  </body>
</html>

```

### 11.3 `styles.css`

```css
:root {
  --tile-bg: rgba(88, 28, 135, 0.85);
  --tile-border: rgba(216, 180, 254, 0.4);
  --text: #ffffff;
  --muted: rgba(255, 255, 255, 0.72);
  --input-bg: rgba(255, 255, 255, 0.08);
  --user-bg: rgba(255, 255, 255, 0.14);
  --agent-bg: rgba(0, 0, 0, 0.18);
  --tab-bg: rgba(255, 255, 255, 0.06);
  --tab-active-bg: rgba(255, 255, 255, 0.18);
  --tab-hover-bg: rgba(255, 255, 255, 0.11);
  --tab-border: rgba(216, 180, 254, 0.25);
  --accent: #f0abfc;
  --accent-soft: rgba(240, 171, 252, 0.7);
  --accent-glow: rgba(240, 171, 252, 0.18);
}

/* Picard — Command Red (TNG) */
body[data-profile='default'] {
  --tile-bg: rgba(139, 20, 30, 0.85);
  --tile-border: rgba(252, 165, 165, 0.45);
  --accent: #fca5a5;
  --accent-soft: rgba(252, 165, 165, 0.7);
  --accent-glow: rgba(252, 165, 165, 0.2);
}

/* Data — Operations Amber-Gold (TNG) — warmer, more orange */
body[data-profile='data'] {
  --tile-bg: rgba(120, 65, 8, 0.85);
  --tile-border: rgba(245, 158, 11, 0.5);
  --accent: #f59e0b;
  --accent-soft: rgba(245, 158, 11, 0.75);
  --accent-glow: rgba(245, 158, 11, 0.22);
}

/* Troi — Sciences Blue-Teal (TNG) */
body[data-profile='troi'] {
  --tile-bg: rgba(15, 76, 92, 0.85);
  --tile-border: rgba(125, 211, 252, 0.45);
  --accent: #7dd3fc;
  --accent-soft: rgba(125, 211, 252, 0.7);
  --accent-glow: rgba(125, 211, 252, 0.2);
}

/* Geordi — Engineering Marigold-Yellow (TNG) — matches uniform yellow */
body[data-profile='geordi'] {
  --tile-bg: rgba(133, 96, 12, 0.85);
  --tile-border: rgba(234, 179, 8, 0.55);
  --accent: #eab308;
  --accent-soft: rgba(234, 179, 8, 0.8);
  --accent-glow: rgba(234, 179, 8, 0.25);
}

/* Wesley — Cadet Grey with gold trim (TNG acting ensign) */
body[data-profile='wesley'] {
  --tile-bg: rgba(60, 65, 75, 0.85);
  --tile-border: rgba(251, 191, 36, 0.45);
  --accent: #fbbf24;
  --accent-soft: rgba(251, 191, 36, 0.7);
  --accent-glow: rgba(251, 191, 36, 0.2);
}

/* Locutus — Borg assimilation green over near-black, cold metallic feel */
body[data-profile='locutus'] {
  --tile-bg: rgba(8, 20, 14, 0.88);
  --tile-border: rgba(74, 222, 128, 0.45);
  --accent: #4ade80;
  --accent-soft: rgba(74, 222, 128, 0.75);
  --accent-glow: rgba(74, 222, 128, 0.22);
}

/* Wesley — top-anchored crop of full-body portrait. Face sits around y=30%,
   hair around y=18%. Zoom modestly and anchor around face for a head-and-
   shoulders framing. */
body[data-profile='wesley'] .avatar img {
  object-position: center 30%;
  transform: scale(1.7);
  transform-origin: center 30%;
}

* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  padding: 0;
  height: 100vh;
  background: transparent;
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif;
  overflow: hidden;
}

.tile {
  position: fixed;
  inset: 0;
  background: var(--tile-bg);
  border: 1px solid var(--tile-border);
  border-radius: 20px;
  padding: 44px 16px 16px;
  display: flex;
  flex-direction: column;
  backdrop-filter: blur(24px) saturate(140%);
  -webkit-backdrop-filter: blur(24px) saturate(140%);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
  -webkit-app-region: drag;
}

.tile header,
.tile .tabs,
.tile .transcript,
.tile form {
  -webkit-app-region: no-drag;
}

.tile header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  gap: 10px;
}

.avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  overflow: hidden;
  flex-shrink: 0;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid var(--tile-border);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25),
    inset 0 0 0 1px rgba(255, 255, 255, 0.06);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.5px;
}

.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center 15%;
  display: block;
  image-rendering: -webkit-optimize-contrast;
}

.avatar-fallback {
  background: linear-gradient(135deg, var(--accent-glow), rgba(0, 0, 0, 0.25));
}

.identity {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.tile h2 {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
  letter-spacing: 0.3px;
}

.tile .model {
  font-size: 10px;
  color: var(--muted);
  font-family: 'SF Mono', ui-monospace, monospace;
}

.tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 10px;
  min-height: 28px;
}

.tab-strip {
  display: flex;
  gap: 4px;
  flex: 1;
  overflow-x: auto;
  scrollbar-width: none;
  padding-bottom: 2px;
}

.tab-strip::-webkit-scrollbar {
  display: none;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  background: var(--tab-bg);
  border: 1px solid var(--tab-border);
  color: var(--muted);
  font-size: 11px;
  font-weight: 500;
  padding: 4px 10px;
  border-radius: 999px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
  max-width: 160px;
  position: relative;
}

.tab:hover {
  background: var(--tab-hover-bg);
  color: var(--text);
}

.tab.active {
  background: var(--tab-active-bg);
  color: var(--text);
  border-color: var(--accent-soft);
  box-shadow: 0 1px 6px var(--accent-glow);
}

.tab.busy .tab-label::after {
  content: '';
  margin-left: 6px;
  display: inline-block;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--accent);
  animation: pulse 1.2s ease-in-out infinite;
  vertical-align: middle;
}

.tab-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.tab-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 8px var(--accent-soft);
  animation: pulse 1.6s ease-in-out infinite;
  flex-shrink: 0;
}

.tab.waiting {
  color: var(--text);
  border-color: var(--accent-soft);
}

.tab-close {
  opacity: 0;
  font-size: 13px;
  line-height: 1;
  color: var(--muted);
  padding: 0 2px;
  border-radius: 4px;
  transition: opacity 0.15s, background 0.15s;
}

.tab:hover .tab-close {
  opacity: 1;
}

.tab-close:hover {
  background: rgba(255, 255, 255, 0.15);
  color: var(--text);
}

.new-tab {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid var(--tab-border);
  color: var(--muted);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: background 0.15s, color 0.15s;
}

.new-tab:hover {
  background: var(--accent-glow);
  color: var(--text);
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.45;
    transform: scale(0.75);
  }
}

.transcript {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-right: 4px;
  margin-bottom: 10px;
  font-size: 13px;
  line-height: 1.4;
}

.msg {
  padding: 8px 10px;
  border-radius: 12px;
  max-width: 92%;
  white-space: pre-wrap;
  word-wrap: break-word;
}

.msg.agent {
  white-space: normal;
}

.msg.user {
  background: var(--user-bg);
  align-self: flex-end;
}

.msg.agent {
  background: var(--agent-bg);
  align-self: flex-start;
}

.msg.agent > *:first-child { margin-top: 0; }
.msg.agent > *:last-child { margin-bottom: 0; }

.msg.agent p {
  margin: 0 0 8px;
}

.msg.agent h1,
.msg.agent h2,
.msg.agent h3,
.msg.agent h4 {
  margin: 10px 0 6px;
  font-weight: 600;
  line-height: 1.25;
}
.msg.agent h1 { font-size: 16px; }
.msg.agent h2 { font-size: 14px; }
.msg.agent h3 { font-size: 13px; }
.msg.agent h4 { font-size: 12px; color: var(--muted); }

.msg.agent ul,
.msg.agent ol {
  margin: 4px 0 8px;
  padding-left: 20px;
}
.msg.agent li { margin: 2px 0; }
.msg.agent li > p { margin: 0; }

.msg.agent a {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.msg.agent a:hover { color: #fbcfe8; }

.msg.agent strong { font-weight: 600; }
.msg.agent em { font-style: italic; }

.msg.agent code {
  background: rgba(0, 0, 0, 0.35);
  padding: 1px 5px;
  border-radius: 4px;
  font-family: 'SF Mono', ui-monospace, monospace;
  font-size: 12px;
}

.msg.agent pre {
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  padding: 8px 10px;
  margin: 6px 0;
  overflow-x: auto;
  font-size: 12px;
  line-height: 1.45;
}
.msg.agent pre code {
  background: transparent;
  padding: 0;
  border-radius: 0;
  font-size: inherit;
}

.msg.agent blockquote {
  margin: 6px 0;
  padding: 2px 10px;
  border-left: 2px solid var(--accent-soft);
  color: var(--muted);
}

.msg.agent hr {
  border: none;
  border-top: 1px solid rgba(255, 255, 255, 0.15);
  margin: 8px 0;
}

.msg.agent table {
  border-collapse: collapse;
  margin: 6px 0;
  font-size: 12px;
}
.msg.agent th,
.msg.agent td {
  border: 1px solid rgba(255, 255, 255, 0.12);
  padding: 4px 8px;
  text-align: left;
}
.msg.agent th { background: rgba(255, 255, 255, 0.06); font-weight: 600; }

.msg.pending {
  color: var(--muted);
  font-style: italic;
}

.msg.error {
  background: rgba(220, 38, 38, 0.35);
  color: #ffe4e4;
}

.msg.tool {
  background: rgba(255, 255, 255, 0.06);
  align-self: flex-start;
  color: var(--muted);
  font-family: 'SF Mono', ui-monospace, monospace;
  font-size: 11px;
}

form#composer {
  display: flex;
  gap: 6px;
}

#composer input {
  flex: 1;
  background: var(--input-bg);
  border: 1px solid var(--tile-border);
  border-radius: 10px;
  color: var(--text);
  padding: 8px 12px;
  font-size: 13px;
  outline: none;
}

#composer input::placeholder {
  color: var(--muted);
}

#composer input:focus {
  border-color: var(--accent-soft);
}

#composer button {
  background: var(--accent-glow);
  border: 1px solid var(--tile-border);
  border-radius: 10px;
  color: var(--text);
  padding: 8px 14px;
  font-size: 13px;
  cursor: pointer;
}

#composer button:hover:not(:disabled) {
  background: var(--accent-soft);
}

#composer button.stop {
  background: rgba(0, 0, 0, 0.35);
  border-color: rgba(255, 255, 255, 0.25);
  color: #ffdede;
}

#composer button.stop:hover:not(:disabled) {
  background: rgba(220, 38, 38, 0.55);
  border-color: rgba(252, 165, 165, 0.7);
  color: #fff;
}

#composer button:disabled,
#composer input:disabled {
  opacity: 0.55;
  cursor: default;
}

#composer input:disabled {
  background: rgba(255, 255, 255, 0.04);
}

.transcript::-webkit-scrollbar {
  width: 6px;
}
.transcript::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.2);
  border-radius: 3px;
}

/* ─── Header controls: access button + avatar ────────────────────── */

.header-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.access-btn {
  -webkit-app-region: no-drag;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 1px solid var(--tile-border);
  background: rgba(0, 0, 0, 0.25);
  color: var(--text);
  font-size: 15px;
  line-height: 1;
  padding: 0;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
}

.access-btn:hover {
  background: rgba(0, 0, 0, 0.4);
}

.access-btn[data-mode='locked'] {
  border-color: rgba(248, 113, 113, 0.7);
  box-shadow: 0 0 8px rgba(248, 113, 113, 0.35);
}
.access-btn[data-mode='ask'] {
  border-color: rgba(251, 191, 36, 0.75);
  box-shadow: 0 0 8px rgba(251, 191, 36, 0.3);
}
.access-btn[data-mode='unlocked'] {
  border-color: rgba(74, 222, 128, 0.65);
  box-shadow: 0 0 8px rgba(74, 222, 128, 0.28);
}

.access-icon {
  display: inline-block;
  line-height: 1;
  /* Nudge emoji glyphs so they sit visually centered in the circle. */
  transform: translateY(-0.5px);
}

/* ─── Permission-request card (inline in transcript) ─────────────── */

.msg.permission {
  align-self: stretch;
  max-width: 100%;
  background: rgba(0, 0, 0, 0.32);
  border: 1px solid rgba(251, 191, 36, 0.55);
  box-shadow: 0 0 10px rgba(251, 191, 36, 0.15);
  border-radius: 12px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 12px;
}

.msg.permission.resolved-locked {
  border-color: rgba(248, 113, 113, 0.5);
  box-shadow: none;
  opacity: 0.9;
}

.msg.permission.resolved {
  border-color: rgba(255, 255, 255, 0.15);
  box-shadow: none;
  opacity: 0.7;
}

.permission-head {
  font-weight: 600;
  letter-spacing: 0.2px;
  color: var(--text);
}

.permission-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.permission-btn {
  -webkit-app-region: no-drag;
  border: 1px solid var(--tile-border);
  background: rgba(255, 255, 255, 0.06);
  color: var(--text);
  font-size: 12px;
  padding: 5px 12px;
  border-radius: 999px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.permission-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.14);
}

.permission-btn.allow {
  border-color: rgba(74, 222, 128, 0.6);
  background: rgba(74, 222, 128, 0.14);
}
.permission-btn.allow:hover:not(:disabled) {
  background: rgba(74, 222, 128, 0.28);
}

.permission-btn.deny {
  border-color: rgba(248, 113, 113, 0.55);
  background: rgba(248, 113, 113, 0.12);
}
.permission-btn.deny:hover:not(:disabled) {
  background: rgba(248, 113, 113, 0.24);
}

.permission-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

```

### 11.4 `preload.js`

```js
const { contextBridge, ipcRenderer } = require('electron');
const log = require('electron-log/renderer');

Object.assign(console, log.functions);
window.addEventListener('error', (e) => {
  log.error('renderer error:', e.message, e.error && e.error.stack);
});
window.addEventListener('unhandledrejection', (e) => {
  log.error('renderer unhandledRejection:', e.reason);
});

function argValue(prefix) {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : '';
}

contextBridge.exposeInMainWorld('hermes', {
  profile: {
    name: argValue('--profile-name='),
    display: argValue('--profile-display=') || argValue('--profile-name='),
    model: argValue('--profile-model='),
  },
  getAvatar: () => ipcRenderer.invoke('avatar:get'),
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state) => ipcRenderer.invoke('state:save', state),
  newSession: () => ipcRenderer.invoke('acp:newSession'),
  loadSession: (sessionId) => ipcRenderer.invoke('acp:loadSession', { sessionId }),
  prompt: (sessionId, text) =>
    ipcRenderer.invoke('acp:prompt', { sessionId, text }),
  cancel: (sessionId) => ipcRenderer.invoke('acp:cancel', { sessionId }),
  onUpdate: (fn) => ipcRenderer.on('acp:update', (_e, params) => fn(params)),
  onError: (fn) => ipcRenderer.on('acp:error', (_e, params) => fn(params)),
  onExit: (fn) => ipcRenderer.on('acp:exit', (_e, params) => fn(params)),
  access: {
    get: () => ipcRenderer.invoke('access:get'),
    set: (mode) => ipcRenderer.invoke('access:set', { mode }),
    respond: (requestKey, optionId) =>
      ipcRenderer.invoke('access:respond', { requestKey, optionId }),
    onRequest: (fn) =>
      ipcRenderer.on('acp:permission', (_e, payload) => fn(payload)),
  },
});

```

### 11.5 `acpClient.js`

```js
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

let log;
try {
  log = require('electron-log/main');
} catch (_) {
  log = { info: (...a) => console.log(...a), warn: (...a) => console.warn(...a) };
}

const HERMES_BIN = path.join(os.homedir(), '.local', 'bin', 'hermes');

// Parse a Hermes-style .env file (KEY=value per line, no `export` prefix, no
// interpolation, `#` and blank lines ignored). Values may be single- or
// double-quoted. Returns {} on any read/parse failure — spawn continues
// with whatever env is already present.
function loadProfileEnv(profile) {
  const envPath = path.join(os.homedir(), '.hermes', 'profiles', profile, '.env');
  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    const out = {};
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;                          // skip blanks / comments
      let val = m[2].trim();
      if (val.startsWith('#')) continue;
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      out[m[1]] = val;
    }
    return out;
  } catch (_) {
    return {};
  }
}

// Access modes for the write-gate.
//   'unlocked' — auto-approve every session/request_permission
//   'ask'      — park the request, ask the renderer, wait for the user
//   'locked'   — auto-deny every request
const ACCESS_MODES = ['locked', 'ask', 'unlocked'];

// Classify an ACP option object. `kind` is the strongest signal (per ACP spec
// options carry allow_once / allow_always / reject_once / reject_always);
// fall back to name/optionId keyword matching for less strict servers.
const isAllowOption  = (o) =>
  (o?.kind?.startsWith('allow'))  || /allow|approve|yes|accept|permit/i.test(o?.name || o?.optionId || '');
const isRejectOption = (o) =>
  (o?.kind?.startsWith('reject')) || /reject|deny|no|cancel|decline|refuse/i.test(o?.name || o?.optionId || '');

class AcpClient {
  constructor({ profile, cwd = os.homedir(), onUpdate, onExit, onPermissionRequest, accessMode = 'unlocked' }) {
    this.profile = profile;
    this.cwd = cwd;
    this.onUpdate = onUpdate || (() => {});
    this.onExit = onExit || (() => {});
    this.onPermissionRequest = onPermissionRequest || (() => {});
    this.accessMode = ACCESS_MODES.includes(accessMode) ? accessMode : 'unlocked';
    this._nextId = 1;
    this._pending = new Map();
    this._stdoutBuf = '';
    this._ready = null;
    this._child = null;
    // Outstanding permission requests waiting on the user (mode='ask').
    // key: internal requestKey (string), value: { rpcId, params }
    this._pendingPermissions = new Map();
    this._nextPermKey = 1;
  }

  setAccessMode(mode) {
    if (!ACCESS_MODES.includes(mode)) return;
    this.accessMode = mode;
  }

  /**
   * Called by the main process when the user picks a choice for a pending
   * permission request that was surfaced in 'ask' mode. `optionId` may be
   * null/undefined to indicate cancellation (treated as a reject).
   */
  resolvePermission(requestKey, optionId) {
    const entry = this._pendingPermissions.get(requestKey);
    if (!entry) return false;
    this._pendingPermissions.delete(requestKey);
    const { rpcId, params } = entry;
    const opts = (params && params.options) || [];
    if (optionId) {
      const match = opts.find((o) => (o.optionId || o.name) === optionId);
      this._reply(rpcId, {
        outcome: {
          outcome: 'selected',
          optionId: match ? match.optionId || match.name : optionId,
        },
      });
    } else {
      // Explicit cancel from the user → tell Hermes the request was cancelled.
      this._reply(rpcId, { outcome: { outcome: 'cancelled' } });
    }
    return true;
  }

  /** Cancel any still-pending permission prompts (e.g. tile closing). */
  cancelPendingPermissions() {
    for (const [key, entry] of this._pendingPermissions) {
      try {
        this._reply(entry.rpcId, { outcome: { outcome: 'cancelled' } });
      } catch {}
      this._pendingPermissions.delete(key);
    }
  }

  start() {
    if (this._child) return this._ready;
    const profileEnv = loadProfileEnv(this.profile);
    const spawnEnv = { ...process.env, ...profileEnv, HERMES_ACCEPT_HOOKS: '1' };
    // Diagnostic marker: writes a small file per spawn so auth/env issues
    // are traceable even when logs are misrouted. Does NOT log the key
    // itself — only whether it's set and its length.
    const _k = spawnEnv.ANTHROPIC_API_KEY;
    const diagLine =
      `[circe:spawn:${this.profile}] HERMES_HOME=${spawnEnv.HERMES_HOME || '(unset)'} ` +
      `ANTHROPIC_API_KEY=${_k ? 'set:' + _k.length + 'chars' : '(UNSET)'} ` +
      `PATH_has_local_bin=${(spawnEnv.PATH || '').includes('.local/bin')}`;
    log.info(diagLine);
    // Drop a marker file so we can confirm the spawn happened even if logging is misrouted.
    try {
      fs.writeFileSync(
        path.join(os.homedir(), '.hermes', `circe-last-spawn-${this.profile}.txt`),
        new Date().toISOString() + '\n' + diagLine + '\n',
      );
    } catch (_) {}
    this._child = spawn(
      HERMES_BIN,
      ['-p', this.profile, 'acp', '--accept-hooks'],
      {
        env: spawnEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    this._child.stdout.on('data', (b) => this._onStdout(b.toString()));
    this._child.stderr.on('data', (b) => {
      process.stderr.write(`[acp:${this.profile}] ${b}`);
    });
    this._child.on('exit', (code) => {
      for (const [, p] of this._pending) {
        p.reject(new Error(`hermes acp exited (${code})`));
      }
      this._pending.clear();
      this.onExit(code);
    });

    this._ready = this._send('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
      clientInfo: { name: 'hermes-tiles', version: '0.1' },
    });
    return this._ready;
  }

  async newSession() {
    await this._ready;
    const r = await this._send('session/new', {
      cwd: this.cwd,
      mcpServers: [],
    });
    return r.sessionId;
  }

  async loadSession(sessionId) {
    await this._ready;
    return this._send('session/load', {
      cwd: this.cwd,
      sessionId,
      mcpServers: [],
    });
  }

  async prompt(sessionId, text) {
    await this._ready;
    return this._send('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    });
  }

  async cancelSession(sessionId) {
    try {
      await this._send('session/cancel', { sessionId });
    } catch {}
  }

  async closeSession(sessionId) {
    try {
      await this._send('session/close', { sessionId });
    } catch {}
  }

  stop() {
    this.cancelPendingPermissions();
    if (this._child) {
      this._child.kill();
      this._child = null;
    }
  }

  _reply(id, result) {
    const line = JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n';
    if (this._child && this._child.stdin.writable) this._child.stdin.write(line);
  }

  _replyError(id, code, message) {
    const line =
      JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n';
    if (this._child && this._child.stdin.writable) this._child.stdin.write(line);
  }

  _handlePermissionRequest(rpcId, params) {
    const opts = (params && params.options) || [];
    const mode = this.accessMode;

    if (mode === 'unlocked') {
      const allow = opts.find(isAllowOption) || opts[0];
      this._reply(rpcId, {
        outcome: {
          outcome: 'selected',
          optionId: allow ? allow.optionId || allow.name : 'allow',
        },
      });
      return;
    }

    if (mode === 'locked') {
      // Prefer an explicit reject option if the agent offered one; else outcome:'cancelled'.
      const reject = opts.find(isRejectOption);
      if (reject) {
        this._reply(rpcId, {
          outcome: {
            outcome: 'selected',
            optionId: reject.optionId || reject.name,
          },
        });
      } else {
        this._reply(rpcId, { outcome: { outcome: 'cancelled' } });
      }
      // Still surface it to the renderer for visibility (as an already-resolved event),
      // so the user sees *why* the agent said it couldn't do the thing.
      try {
        this.onPermissionRequest({
          requestKey: null,
          resolved: 'locked',
          toolCall: (params && params.toolCall) || null,
          options: opts,
        });
      } catch {}
      return;
    }

    // mode === 'ask' → park the request, tell the renderer, wait for resolvePermission().
    const requestKey = `p${this._nextPermKey++}`;
    this._pendingPermissions.set(requestKey, { rpcId, params });
    try {
      this.onPermissionRequest({
        requestKey,
        resolved: null,
        toolCall: (params && params.toolCall) || null,
        options: opts,
      });
    } catch (err) {
      // If we couldn't hand off to the UI, don't leave Hermes hanging forever.
      this._pendingPermissions.delete(requestKey);
      this._reply(rpcId, { outcome: { outcome: 'cancelled' } });
    }
  }

  _handleServerRequest(msg) {
    const { id, method, params } = msg;
    if (method === 'session/request_permission') {
      this._handlePermissionRequest(id, params);
      return;
    }
    if (method === 'fs/read_text_file') {
      try {
        const content = fs.readFileSync(params.path, 'utf8');
        this._reply(id, { content });
      } catch (err) {
        this._replyError(id, -32603, err.message);
      }
      return;
    }
    if (method === 'fs/write_text_file') {
      try {
        fs.writeFileSync(params.path, params.content);
        this._reply(id, {});
      } catch (err) {
        this._replyError(id, -32603, err.message);
      }
      return;
    }
    this._replyError(id, -32601, `method not implemented: ${method}`);
  }

  _send(method, params) {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      this._pending.set(id, { resolve, reject });
      const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      this._child.stdin.write(line);
    });
  }

  _onStdout(chunk) {
    this._stdoutBuf += chunk;
    let idx;
    while ((idx = this._stdoutBuf.indexOf('\n')) >= 0) {
      const line = this._stdoutBuf.slice(0, idx).trim();
      this._stdoutBuf = this._stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && msg.method === undefined) {
        const p = this._pending.get(msg.id);
        if (!p) continue;
        this._pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || 'rpc error'));
        else p.resolve(msg.result);
      } else if (msg.method === 'session/update' && msg.params) {
        try {
          this.onUpdate(msg.params);
        } catch {}
      } else if (msg.method && msg.id !== undefined) {
        this._handleServerRequest(msg);
      }
    }
  }
}

module.exports = { AcpClient };

```

### 11.6 `main.js`

```js
const { app, BrowserWindow, ipcMain, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');
const log = require('electron-log/main');
const { AcpClient } = require('./acpClient');

app.setName('Circe');
log.initialize();
log.transports.file.level = 'info';
log.transports.console.level = 'info';
log.errorHandler.startCatching({ showDialog: false });
log.eventLogger.startLogging();
log.info(`Circe starting — logs at ${log.transports.file.getFile().path}`);

process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection', reason);
});

const HERMES_BIN = path.join(os.homedir(), '.local', 'bin', 'hermes');
const HERMES_HOME = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
const STATE_DIR = process.env.HERMES_TILES_STATE_DIR || path.join(os.homedir(), '.hermes-tiles');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

function loadStateFile() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { profiles: {} };
  }
}

function writeStateFile(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log.error('Failed to save state:', err.message);
  }
}

const stateCache = loadStateFile();

// Circe write-gate: per-profile access mode. Enforcement lives in acpClient.js
// (`_handlePermissionRequest`); this file just persists the choice and seeds
// the default. Profiles listed in LOCKED_BY_DEFAULT open in 'locked'; all
// others open in 'unlocked' so existing workflows don't regress.
const ACCESS_MODES = ['locked', 'ask', 'unlocked'];
const LOCKED_BY_DEFAULT = new Set(['locutus']);

function defaultAccessMode(profileName) {
  return LOCKED_BY_DEFAULT.has(profileName) ? 'locked' : 'unlocked';
}

function getAccessMode(profileName) {
  const saved =
    stateCache.profiles[profileName] &&
    stateCache.profiles[profileName].accessMode;
  if (ACCESS_MODES.includes(saved)) return saved;
  return defaultAccessMode(profileName);
}

function setAccessMode(profileName, mode) {
  if (!ACCESS_MODES.includes(mode)) return null;
  if (!stateCache.profiles[profileName]) stateCache.profiles[profileName] = {};
  stateCache.profiles[profileName].accessMode = mode;
  writeStateFile(stateCache);
  return mode;
}

const TILE_W = 520;
const TILE_H = 620;
const GAP = 16;
const MARGIN = 40;

const tileClients = new Map();

function runHermes(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(HERMES_BIN, args, {
      env: { ...process.env, HERMES_ACCEPT_HOOKS: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`hermes exited ${code}: ${stderr || stdout}`));
    });
  });
}

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
    profiles.push({ name, model });
  }
  return profiles;
}

function readDisplayName(profileName) {
  const soulPath =
    profileName === 'default'
      ? path.join(HERMES_HOME, 'SOUL.md')
      : path.join(HERMES_HOME, 'profiles', profileName, 'SOUL.md');
  try {
    const text = fs.readFileSync(soulPath, 'utf8');
    const heading = text.match(/^#\s+([A-Za-z0-9_ '-]+?)(?:\s*[—–-]|$)/m);
    if (heading) return heading[1].trim();
    const youAre = text.match(/You are\s+([A-Za-z][A-Za-z0-9'_-]*)/);
    if (youAre) return youAre[1];
  } catch {}
  return profileName;
}

const AVATAR_MIMES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

function loadAvatarDataUrl(profileName) {
  const roots =
    profileName === 'default'
      ? [HERMES_HOME]
      : [path.join(HERMES_HOME, 'profiles', profileName)];
  for (const root of roots) {
    for (const ext of Object.keys(AVATAR_MIMES)) {
      const p = path.join(root, `avatar.${ext}`);
      try {
        const buf = fs.readFileSync(p);
        return `data:${AVATAR_MIMES[ext]};base64,${buf.toString('base64')}`;
      } catch {}
    }
  }
  return '';
}

const tileProfiles = new Map();

function positionFor(index, workArea) {
  const cols = Math.max(
    1,
    Math.floor((workArea.width - 2 * MARGIN + GAP) / (TILE_W + GAP)),
  );
  const col = index % cols;
  const row = Math.floor(index / cols);
  return {
    x: workArea.x + MARGIN + col * (TILE_W + GAP),
    y: workArea.y + MARGIN + row * (TILE_H + GAP),
  };
}

function createTileWindow(profile, index) {
  const workArea = screen.getPrimaryDisplay().workArea;
  const auto = positionFor(index, workArea);
  const displayName = readDisplayName(profile.name);
  const savedBounds =
    (stateCache.profiles[profile.name] &&
      stateCache.profiles[profile.name].bounds) ||
    null;

  const win = new BrowserWindow({
    width: (savedBounds && savedBounds.width) || TILE_W,
    height: (savedBounds && savedBounds.height) || TILE_H,
    x: savedBounds ? savedBounds.x : auto.x,
    y: savedBounds ? savedBounds.y : auto.y,
    title: `circe · ${displayName}`,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    titleBarStyle: 'hiddenInset',
    resizable: true,
    minWidth: 340,
    minHeight: 380,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: [
        `--profile-name=${profile.name}`,
        `--profile-display=${displayName}`,
        `--profile-model=${profile.model || ''}`,
      ],
    },
  });

  const wcId = win.webContents.id;
  tileProfiles.set(wcId, profile.name);
  log.info(`Opened tile for profile "${profile.name}" (wcId=${wcId})`);

  const openExternally = (url) => {
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) {
      shell.openExternal(url);
    }
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url === win.webContents.getURL()) return;
    e.preventDefault();
    openExternally(url);
  });
  const client = new AcpClient({
    profile: profile.name,
    cwd: os.homedir(),
    accessMode: getAccessMode(profile.name),
    onUpdate: (params) => {
      if (win.isDestroyed()) return;
      win.webContents.send('acp:update', params);
    },
    onExit: (code) => {
      if (win.isDestroyed()) return;
      win.webContents.send('acp:exit', { code });
    },
    onPermissionRequest: (payload) => {
      if (win.isDestroyed()) return;
      win.webContents.send('acp:permission', payload);
    },
  });
  tileClients.set(wcId, client);
  client.start().catch((err) => {
    if (!win.isDestroyed()) {
      win.webContents.send('acp:error', { message: err.message });
    }
  });

  let boundsTimer = null;
  const saveBounds = () => {
    if (win.isDestroyed()) return;
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (win.isDestroyed()) return;
      const b = win.getBounds();
      if (!stateCache.profiles[profile.name]) stateCache.profiles[profile.name] = {};
      stateCache.profiles[profile.name].bounds = {
        x: b.x, y: b.y, width: b.width, height: b.height,
      };
      writeStateFile(stateCache);
    }, 300);
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);

  win.on('closed', () => {
    log.info(`Closed tile for profile "${profile.name}" (wcId=${wcId})`);
    if (boundsTimer) clearTimeout(boundsTimer);
    const c = tileClients.get(wcId);
    if (c) {
      c.stop();
      tileClients.delete(wcId);
    }
    tileProfiles.delete(wcId);
    openProfiles.delete(profile.name);
  });

  win.loadFile('index.html');
}

const openProfiles = new Set();
let watchDebounce = null;

async function syncTiles() {
  try {
    const profiles = await loadProfiles();
    let idx = openProfiles.size;
    for (const p of profiles) {
      if (openProfiles.has(p.name)) continue;
      openProfiles.add(p.name);
      createTileWindow(p, idx++);
    }
  } catch (err) {
    log.error('Failed to sync tiles:', err.message);
  }
}

function watchProfilesDir() {
  const dir = path.join(HERMES_HOME, 'profiles');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.watch(dir, { persistent: true }, () => {
      if (watchDebounce) clearTimeout(watchDebounce);
      watchDebounce = setTimeout(syncTiles, 600);
    });
  } catch (err) {
    log.error('Could not watch profiles dir:', err.message);
  }
}

app.whenReady().then(async () => {
  log.info('app ready');
  try {
    const profiles = await loadProfiles();
    if (!profiles.length) {
      log.error('No Hermes profiles found.');
      app.quit();
      return;
    }
    log.info(`Loaded ${profiles.length} profile(s): ${profiles.map((p) => p.name).join(', ')}`);
    profiles.forEach((p, i) => {
      openProfiles.add(p.name);
      createTileWindow(p, i);
    });
    watchProfilesDir();
  } catch (err) {
    log.error('Failed to load profiles:', err.message);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  log.info('all windows closed — quitting');
  for (const c of tileClients.values()) c.stop();
  tileClients.clear();
  app.quit();
});

ipcMain.handle('avatar:get', (evt) => {
  const name = tileProfiles.get(evt.sender.id);
  if (!name) return '';
  return loadAvatarDataUrl(name);
});

ipcMain.handle('state:load', (evt) => {
  const name = tileProfiles.get(evt.sender.id);
  if (!name) return null;
  const p = stateCache.profiles[name];
  if (!p) return null;
  return { tabs: p.tabs || [], activeIndex: p.activeIndex || 0 };
});

ipcMain.handle('state:save', (evt, tabsState) => {
  const name = tileProfiles.get(evt.sender.id);
  if (!name) return;
  const existing = stateCache.profiles[name] || {};
  stateCache.profiles[name] = {
    ...existing,
    tabs: tabsState.tabs,
    activeIndex: tabsState.activeIndex,
  };
  writeStateFile(stateCache);
});

ipcMain.handle('acp:newSession', async (evt) => {
  const client = tileClients.get(evt.sender.id);
  if (!client) throw new Error('no ACP client for this window');
  const sessionId = await client.newSession();
  return { sessionId };
});

ipcMain.handle('acp:loadSession', async (evt, { sessionId }) => {
  const client = tileClients.get(evt.sender.id);
  if (!client) throw new Error('no ACP client for this window');
  try {
    await client.loadSession(sessionId);
    return { ok: true, sessionId };
  } catch (err) {
    log.warn(`loadSession(${sessionId}) failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('acp:prompt', async (evt, { sessionId, text }) => {
  const client = tileClients.get(evt.sender.id);
  if (!client) throw new Error('no ACP client for this window');
  await client.prompt(sessionId, text);
  return { ok: true };
});

ipcMain.handle('acp:cancel', async (evt, { sessionId } = {}) => {
  const client = tileClients.get(evt.sender.id);
  if (!client) return { ok: false };
  if (sessionId) await client.cancelSession(sessionId);
  return { ok: true };
});

ipcMain.handle('access:get', (evt) => {
  const name = tileProfiles.get(evt.sender.id);
  if (!name) return null;
  return { mode: getAccessMode(name) };
});

ipcMain.handle('access:set', (evt, { mode } = {}) => {
  const name = tileProfiles.get(evt.sender.id);
  if (!name) return { ok: false, error: 'no profile bound to window' };
  const applied = setAccessMode(name, mode);
  if (!applied) return { ok: false, error: `invalid mode: ${mode}` };
  const client = tileClients.get(evt.sender.id);
  if (client) client.setAccessMode(applied);
  return { ok: true, mode: applied };
});

ipcMain.handle('access:respond', (evt, { requestKey, optionId } = {}) => {
  const client = tileClients.get(evt.sender.id);
  if (!client) return { ok: false, error: 'no ACP client' };
  const ok = client.resolvePermission(requestKey, optionId || null);
  return { ok };
});

```

### 11.7 `renderer.js`

```js
const profile = window.hermes.profile;

const md = (window.marked && window.marked.marked) || window.marked;
if (md && typeof md.setOptions === 'function') {
  md.setOptions({ gfm: true, breaks: true });
}

function renderMarkdown(text) {
  if (!md) return null;
  try {
    return md.parse(text || '');
  } catch {
    return null;
  }
}

function setMessageContent(el, role, text) {
  if (role === 'agent' && md) {
    const html = renderMarkdown(text);
    if (html != null) {
      el.innerHTML = html;
      return;
    }
  }
  el.textContent = text;
}

const transcript = document.getElementById('transcript');
const input = document.getElementById('input');
const form = document.getElementById('composer');
const sendBtn = document.getElementById('send');
const tabStrip = document.getElementById('tab-strip');
const newTabBtn = document.getElementById('new-tab');
const accessBtn = document.getElementById('access-btn');
const accessIcon = accessBtn ? accessBtn.querySelector('.access-icon') : null;

// ─── Access-mode gate ──────────────────────────────────────────────
// Three-state cycle: locked → ask → unlocked → locked. Icon + tooltip
// reflect current state; server-side enforcement lives in main.js /
// acpClient.js. This is the ONLY user-facing control for the gate.
const ACCESS_STATES = ['locked', 'ask', 'unlocked'];
const ACCESS_META = {
  locked:   { icon: '🔒', label: 'Locked — file changes auto-denied' },
  ask:      { icon: '⛔', label: 'Ask — choose per request' },
  unlocked: { icon: '🔓', label: 'Unlocked — file changes auto-allowed' },
};
let accessMode = 'unlocked'; // hydrated from main on boot

function paintAccessButton() {
  if (!accessBtn || !accessIcon) return;
  const meta = ACCESS_META[accessMode] || ACCESS_META.unlocked;
  accessIcon.textContent = meta.icon;
  accessBtn.title = `${meta.label} — click to cycle`;
  accessBtn.dataset.mode = accessMode;
}

async function cycleAccessMode() {
  const idx = ACCESS_STATES.indexOf(accessMode);
  const next = ACCESS_STATES[(idx + 1) % ACCESS_STATES.length];
  try {
    const res = await window.hermes.access.set(next);
    if (res && res.ok) {
      accessMode = res.mode;
      paintAccessButton();
      // If we just moved AWAY from 'ask' and there were open cards, cancel them.
      if (accessMode !== 'ask') resolveAllPendingPermissionCards(null);
    }
  } catch (err) {
    console.error('failed to set access mode', err);
  }
}

if (accessBtn) accessBtn.addEventListener('click', cycleAccessMode);

document.getElementById('profile-name').textContent = profile.display;
document.getElementById('profile-model').textContent = profile.model;
document.title = `hermes · ${profile.display}`;
document.body.dataset.profile = profile.name;

const avatarEl = document.getElementById('avatar');
function setInitialAvatar() {
  avatarEl.innerHTML = '';
  avatarEl.textContent = (profile.display || '?').charAt(0).toUpperCase();
  avatarEl.classList.add('avatar-fallback');
}
window.hermes.getAvatar().then((dataUrl) => {
  if (!dataUrl) {
    setInitialAvatar();
    return;
  }
  const img = document.createElement('img');
  img.src = dataUrl;
  img.alt = '';
  img.addEventListener('error', setInitialAvatar);
  avatarEl.append(img);
});

const tabs = [];
const tabsById = new Map();
let activeTabId = null;
let tabCounter = 0;

function updateComposer() {
  const tab = tabsById.get(activeTabId);
  if (!tab) {
    input.disabled = true;
    sendBtn.disabled = true;
    sendBtn.textContent = 'Send';
    sendBtn.classList.remove('stop');
    input.placeholder = 'Starting session…';
    return;
  }
  input.disabled = tab.busy;
  if (tab.busy) {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Stop';
    sendBtn.classList.add('stop');
    sendBtn.title = 'Stop this agent';
    input.placeholder = `${profile.display} is thinking…`;
  } else {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
    sendBtn.classList.remove('stop');
    sendBtn.title = '';
    input.placeholder = `Message ${profile.display}…`;
  }
}

function firstUserPreview(tab) {
  if (!tab.firstUserText) return null;
  const trimmed = tab.firstUserText.trim();
  if (!trimmed) return null;
  return trimmed.length > 22 ? trimmed.slice(0, 22) + '…' : trimmed;
}

function renderTabs() {
  tabStrip.innerHTML = '';
  for (const tab of tabs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab';
    if (tab.id === activeTabId) btn.classList.add('active');
    if (tab.waiting && tab.id !== activeTabId) btn.classList.add('waiting');
    if (tab.busy) btn.classList.add('busy');

    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = firstUserPreview(tab) || tab.defaultLabel;
    btn.append(label);

    if (tab.waiting && tab.id !== activeTabId) {
      const dot = document.createElement('span');
      dot.className = 'tab-dot';
      btn.append(dot);
    }

    if (tabs.length > 1) {
      const close = document.createElement('span');
      close.className = 'tab-close';
      close.textContent = '×';
      close.title = 'Close workstream';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(tab.id);
      });
      btn.append(close);
    }

    btn.addEventListener('click', () => activateTab(tab.id));
    tabStrip.append(btn);
  }
}

// Bumped every time the transcript DOM is wiped (renderTranscript). Queued
// scroll snapshots capture this at schedule time and bail if it has moved on
// — prevents a late setTimeout/RAF/img-load/font-ready callback from an
// earlier tab's render from clobbering the current tab's scroll position.
let transcriptGen = 0;

// Scroll to bottom, but wait for layout to settle. `renderTranscript`
// runs synchronously while markdown/images/fonts are still resolving, so
// a single `scrollTop = scrollHeight` snapshots a stale (too-small)
// scrollHeight and lands us in the middle of the transcript on restore.
// We schedule two follow-up scrolls (next frame, and 120ms later) to
// catch the most common late-layout cases, and also re-anchor if any
// <img> inside the transcript finishes loading afterwards.
//
// Every deferred snap is gated on `transcriptGen` so that when the user
// switches tabs (or boot activates a different tab than the one whose
// scroll was queued), stale callbacks no-op instead of scrolling the
// wrong DOM.
function scrollTranscriptToBottom() {
  const gen = transcriptGen;
  const snap = () => {
    if (gen !== transcriptGen) return;
    transcript.scrollTop = transcript.scrollHeight;
  };
  snap();
  requestAnimationFrame(() => {
    snap();
    // Second settle: covers marked-rendered content, web fonts, avatar
    // images that inflate height after the initial paint.
    setTimeout(snap, 120);
  });
  // Any image that loads later (e.g. inline markdown image) grows the
  // scrollHeight — re-anchor to bottom on each load. Guarded by `gen`
  // so an image finishing after a tab switch doesn't scroll the new tab.
  for (const img of transcript.querySelectorAll('img')) {
    if (!img.complete) {
      img.addEventListener('load', snap, { once: true });
      img.addEventListener('error', snap, { once: true });
    }
  }
}

// On macOS lid-close → lid-open, the renderer is suspended and layout
// re-computes on wake. Chromium's scroll anchoring can lock onto a
// mid-transcript element and leave us parked there. Re-anchor to bottom
// whenever the tile becomes visible again. Uses the hardened
// scrollTranscriptToBottom() path (RAF + 120ms + img re-anchor + gen guard).
function reanchorOnWake() {
  if (document.hidden) return;
  if (!tabsById.get(activeTabId)) return;
  scrollTranscriptToBottom();
}
document.addEventListener('visibilitychange', reanchorOnWake);
window.addEventListener('pageshow', reanchorOnWake);

function renderTranscript() {
  transcriptGen += 1;
  transcript.innerHTML = '';
  const tab = tabsById.get(activeTabId);
  if (!tab) return;
  for (const m of tab.messages) {
    const el = document.createElement('div');
    el.className = `msg ${m.role} ${m.cls || ''}`.trim();
    if (m.cls === 'error' || m.role !== 'agent') el.textContent = m.text;
    else setMessageContent(el, m.role, m.text);
    transcript.append(el);
  }
  scrollTranscriptToBottom();
}

function appendMessage(tab, role, text, cls = '') {
  tab.messages.push({ role, text, cls });
  if (tab.id === activeTabId) {
    const el = document.createElement('div');
    el.className = `msg ${role} ${cls}`.trim();
    if (cls === 'error' || role !== 'agent') el.textContent = text;
    else setMessageContent(el, role, text);
    transcript.append(el);
    transcript.scrollTop = transcript.scrollHeight;
    return el;
  }
  return null;
}

function activateTab(id) {
  if (activeTabId === id) return;
  activeTabId = id;
  const tab = tabsById.get(id);
  if (tab) tab.waiting = false;
  renderTabs();
  renderTranscript();
  updateComposer();
  if (!input.disabled) input.focus();
}

async function createTab({
  activate = true,
  restored = null,
} = {}) {
  tabCounter += 1;
  const localId = `t${tabCounter}`;
  const tab = {
    id: localId,
    sessionId: null,
    defaultLabel: restored
      ? restored.defaultLabel || `Tab ${tabCounter}`
      : `Tab ${tabCounter}`,
    messages: restored && Array.isArray(restored.messages) ? [...restored.messages] : [],
    busy: false,
    waiting: false,
    firstUserText: restored ? restored.firstUserText || null : null,
    pendingBubble: null,
    pendingBubbleEl: null,
    agentText: '',
    toolBubbleEl: null,
    toolBubble: null,
    starting: true,
    replaying: false,
  };
  tabs.push(tab);
  tabsById.set(localId, tab);
  if (activate) activateTab(localId);
  else renderTabs();

  const priorSessionId = restored && restored.sessionId ? restored.sessionId : null;

  try {
    if (priorSessionId) {
      tab.sessionId = priorSessionId;
      tab.replaying = true;
      const res = await window.hermes.loadSession(priorSessionId);
      tab.replaying = false;
      if (!res || !res.ok) {
        const { sessionId } = await window.hermes.newSession();
        tab.sessionId = sessionId;
      }
    } else {
      const { sessionId } = await window.hermes.newSession();
      tab.sessionId = sessionId;
    }
    tab.starting = false;
    if (tab.id === activeTabId) updateComposer();
  } catch (err) {
    tab.replaying = false;
    tab.starting = false;
    appendMessage(tab, 'agent', err.message || String(err), 'error');
  }
  persistState();
  return tab;
}

let persistTimer = null;
function persistState() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const payload = {
      activeIndex: Math.max(0, tabs.findIndex((t) => t.id === activeTabId)),
      tabs: tabs.map((t) => ({
        sessionId: t.sessionId,
        defaultLabel: t.defaultLabel,
        firstUserText: t.firstUserText,
        messages: t.messages
          .filter((m) => m.role !== 'tool' && m.role !== 'permission')
          .map((m) => ({ role: m.role, text: m.text, cls: m.cls || '' })),
      })),
    };
    window.hermes.saveState(payload).catch(() => {});
  }, 250);
}

function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const tab = tabs[idx];
  if (tab.sessionId) window.hermes.cancel(tab.sessionId).catch(() => {});
  tabs.splice(idx, 1);
  tabsById.delete(id);
  if (activeTabId === id) {
    const next = tabs[idx] || tabs[idx - 1] || tabs[0];
    activeTabId = next ? next.id : null;
  }
  renderTabs();
  renderTranscript();
  updateComposer();
  persistState();
}

function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(extractText).join('');
  if (content.text) return content.text;
  if (content.type === 'text' && content.text) return content.text;
  return '';
}

function tabForSession(sessionId) {
  if (!sessionId) return null;
  for (const t of tabs) if (t.sessionId === sessionId) return t;
  return null;
}

window.hermes.onUpdate((params) => {
  const u = params && params.update;
  if (!u) return;
  const tab = tabForSession(params.sessionId);
  if (!tab) return;
  if (tab.replaying) return;

  const kind = u.sessionUpdate;
  if (kind === 'agent_message_chunk') {
    const piece = extractText(u.content);
    if (!piece) return;
    if (!tab.pendingBubble) {
      tab.pendingBubble = { role: 'agent', text: '', cls: '' };
      tab.messages.push(tab.pendingBubble);
      tab.agentText = '';
      if (tab.id === activeTabId) {
        const el = document.createElement('div');
        el.className = 'msg agent';
        el.textContent = '';
        transcript.append(el);
        tab.pendingBubbleEl = el;
      }
    }
    tab.agentText += piece;
    tab.pendingBubble.text = tab.agentText;
    if (tab.id === activeTabId && tab.pendingBubbleEl) {
      setMessageContent(tab.pendingBubbleEl, 'agent', tab.agentText);
      transcript.scrollTop = transcript.scrollHeight;
    }
  } else if (kind === 'tool_call' || kind === 'tool_call_update') {
    const name = u.title || u.toolCallId || '';
    if (!name) return;
    const label = `⚙ ${name}`;
    if (!tab.toolBubble) {
      tab.toolBubble = { role: 'tool', text: label, cls: '' };
      tab.messages.push(tab.toolBubble);
      if (tab.id === activeTabId) {
        const el = document.createElement('div');
        el.className = 'msg tool';
        el.textContent = label;
        transcript.append(el);
        tab.toolBubbleEl = el;
      }
    } else {
      tab.toolBubble.text = label;
      if (tab.id === activeTabId && tab.toolBubbleEl) {
        tab.toolBubbleEl.textContent = label;
      }
    }
  }
});

window.hermes.onError(({ message }) => {
  const tab = tabsById.get(activeTabId) || tabs[0];
  if (tab) appendMessage(tab, 'agent', message || 'ACP error', 'error');
});

window.hermes.onExit(({ code }) => {
  for (const tab of tabs) {
    appendMessage(tab, 'agent', `agent exited (${code})`, 'error');
    tab.busy = false;
  }
  updateComposer();
  persistState();
});

// ─── Permission-request cards ──────────────────────────────────────
// Rendered inline in the transcript when access mode is 'ask' (and
// also as an informational note when 'locked' auto-denies something).
// Cards are ephemeral — we don't persist them across restarts because
// the underlying RPC is already invalidated when hermes exits.

const pendingCards = new Map(); // requestKey → { el, tabId }

function toolCallSummary(toolCall) {
  if (!toolCall) return 'a tool call';
  const kind = toolCall.kind || toolCall.type || '';
  const title = toolCall.title || toolCall.name || toolCall.toolCallId || 'tool';
  return kind ? `${title} (${kind})` : title;
}

function buildPermissionCard({ requestKey, resolved, toolCall, options }, tab) {
  const el = document.createElement('div');
  el.className = 'msg permission';
  if (resolved === 'locked') el.classList.add('resolved-locked');

  const head = document.createElement('div');
  head.className = 'permission-head';
  head.textContent = resolved === 'locked'
    ? `🔒 denied: ${toolCallSummary(toolCall)}`
    : `⛔ approve: ${toolCallSummary(toolCall)}?`;
  el.append(head);

  if (resolved !== 'locked' && requestKey) {
    const row = document.createElement('div');
    row.className = 'permission-actions';
    const opts = Array.isArray(options) ? options : [];
    if (!opts.length) {
      // Synthesize a minimal allow/deny pair if the agent didn't send any.
      opts.push({ optionId: 'allow', name: 'Allow', kind: 'allow_once' });
      opts.push({ optionId: 'reject', name: 'Deny', kind: 'reject_once' });
    }
    for (const opt of opts) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'permission-btn';
      const kind = (opt.kind || '').toLowerCase();
      if (kind.startsWith('reject') || /reject|deny|no|cancel/i.test(opt.name || opt.optionId || '')) {
        btn.classList.add('deny');
      } else {
        btn.classList.add('allow');
      }
      btn.textContent = opt.name || opt.optionId || 'ok';
      btn.addEventListener('click', async () => {
        // Disable everything in this card so double-click doesn't double-fire.
        for (const b of row.querySelectorAll('button')) b.disabled = true;
        try {
          await window.hermes.access.respond(requestKey, opt.optionId || opt.name);
        } catch (err) {
          console.error('permission respond failed', err);
        }
        markCardResolved(requestKey, opt.name || opt.optionId);
      });
      row.append(btn);
    }
    el.append(row);
  }

  return el;
}

function markCardResolved(requestKey, label) {
  const rec = pendingCards.get(requestKey);
  if (!rec) return;
  const { el } = rec;
  el.classList.add('resolved');
  const head = el.querySelector('.permission-head');
  if (head) head.textContent = `✓ ${label || 'resolved'}`;
  const row = el.querySelector('.permission-actions');
  if (row) row.remove();
  pendingCards.delete(requestKey);
}

function resolveAllPendingPermissionCards(optionId) {
  // Fire-and-forget respond() for each; leave the cards visible but marked.
  for (const [key] of pendingCards) {
    window.hermes.access.respond(key, optionId).catch(() => {});
    markCardResolved(key, optionId ? optionId : 'cancelled');
  }
}

window.hermes.access.onRequest((payload) => {
  if (!payload) return;
  // Which tab does this belong to? Prefer the active tab (there's usually
  // only one prompt in flight per tile). Fall back to first tab.
  const tab = tabsById.get(activeTabId) || tabs[0];
  if (!tab) return;
  const card = buildPermissionCard(payload, tab);
  tab.messages.push({
    role: 'permission',
    text: '',
    cls: payload.resolved === 'locked' ? 'resolved-locked' : '',
  });
  if (tab.id === activeTabId) {
    transcript.append(card);
    transcript.scrollTop = transcript.scrollHeight;
  }
  if (payload.requestKey && payload.resolved !== 'locked') {
    pendingCards.set(payload.requestKey, { el: card, tabId: tab.id });
  }
});

window.addEventListener('beforeunload', () => {
  const payload = {
    activeIndex: Math.max(0, tabs.findIndex((t) => t.id === activeTabId)),
    tabs: tabs.map((t) => ({
      defaultLabel: t.defaultLabel,
      firstUserText: t.firstUserText,
      messages: t.messages
        .filter((m) => m.role !== 'tool' && m.role !== 'permission')
        .map((m) => ({ role: m.role, text: m.text, cls: m.cls || '' })),
    })),
  };
  window.hermes.saveState(payload);
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const tab = tabsById.get(activeTabId);
  if (!tab) return;

  if (tab.busy) {
    if (!tab.sessionId) return;
    tab.cancelling = true;
    sendBtn.disabled = true;
    try {
      await window.hermes.cancel(tab.sessionId);
    } catch {}
    tab.busy = false;
    tab.cancelling = false;
    appendMessage(tab, 'agent', '⏹ stopped', 'error');
    tab.pendingBubble = null;
    tab.pendingBubbleEl = null;
    tab.toolBubble = null;
    tab.toolBubbleEl = null;
    if (tab.id !== activeTabId) tab.waiting = true;
    renderTabs();
    updateComposer();
    if (tab.id === activeTabId) input.focus();
    persistState();
    return;
  }

  const text = input.value.trim();
  if (!text || !tab.sessionId) return;

  input.value = '';
  tab.busy = true;
  if (!tab.firstUserText) tab.firstUserText = text;
  appendMessage(tab, 'user', text);
  tab.pendingBubble = null;
  tab.pendingBubbleEl = null;
  tab.agentText = '';
  tab.toolBubble = null;
  tab.toolBubbleEl = null;
  renderTabs();
  updateComposer();

  try {
    await window.hermes.prompt(tab.sessionId, text);
  } catch (err) {
    if (!tab.cancelling) {
      appendMessage(tab, 'agent', err.message || String(err), 'error');
    }
  } finally {
    if (!tab.cancelling) {
      tab.busy = false;
      tab.pendingBubble = null;
      tab.pendingBubbleEl = null;
      tab.toolBubble = null;
      tab.toolBubbleEl = null;
      if (tab.id !== activeTabId) tab.waiting = true;
      renderTabs();
      updateComposer();
      if (tab.id === activeTabId) input.focus();
      persistState();
    }
  }
});

newTabBtn.addEventListener('click', () => createTab({ activate: true }));

(async function boot() {
  // Hydrate access mode from main before anything else so the button paints correctly.
  try {
    const res = await window.hermes.access.get();
    if (res && res.mode) accessMode = res.mode;
  } catch {}
  paintAccessButton();

  let saved = null;
  try {
    saved = await window.hermes.loadState();
  } catch {}
  const restoredTabs = saved && Array.isArray(saved.tabs) ? saved.tabs : [];
  if (restoredTabs.length) {
    for (let i = 0; i < restoredTabs.length; i++) {
      await createTab({ activate: i === (saved.activeIndex || 0), restored: restoredTabs[i] });
    }
    if (tabs.length && !tabsById.get(activeTabId)) activateTab(tabs[0].id);
  } else {
    await createTab({ activate: true });
  }
  updateComposer();
  // Final safety net: after all restore async work has flushed, force one
  // more scroll-to-bottom once fonts are ready. Fonts loading late is a
  // common cause of the "restored session parked mid-transcript" bug.
  scrollTranscriptToBottom();
  if (document.fonts && typeof document.fonts.ready?.then === 'function') {
    document.fonts.ready.then(scrollTranscriptToBottom).catch(() => {});
  }
})();

```

---

## Appendix: acquisition fallbacks

If pasting from the notes app into home Hermes goes wrong (dropped
characters, smart-quote substitution, wrapped-line corruption), fall
back to one of these:

1. **AirDrop / USB** — `tar czf circe-src.tgz main.js acpClient.js
   preload.js renderer.js index.html styles.css package.json` on the
   work laptop, move the tarball manually.
2. **Password-manager attachment** — 1Password / Bitwarden accepts
   60 KB text attachments fine.
3. **Reconstruct from the contracts in §File contracts** — slowest,
   but always available; use §7 smoke tests to catch bugs.

After writing the files by any route, run `node --check <file.js>` on
each JavaScript file before `npm start`.
