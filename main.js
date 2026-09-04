const { app, BrowserWindow, ipcMain, dialog, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');
const log = require('electron-log/main');
const { AcpClient } = require('./acpClient');
const { runOnboarding, firstRunNeeded, listRealProfiles } = require('./onboarding/main');
const { loadProfiles: loadProfilesFromList } = require('./profileList');
const { saveAsAvatar } = require('./wikipediaClient');
const { setupCaTrust } = require('./caTrust');
const {
  refreshOrchestratorReferences,
  pruneStaleReferences,
} = require('./profileWriter');

// Bumped when the shipped dj-tooling.md OR the SOUL pointer section changes
// meaningfully enough that already-onboarded profiles should pick it up.
// state.json.referencesVersion tracks per-installation progress; the
// backfill only runs when this constant is higher.
//
// v2: scoped the DJ tooling to the orchestrator profile only, and stripped
// it from every non-orchestrator profile (specialists have their own SOULs
// and never need to run the setup flows).
// v3: back-patched the orchestrator addendum ('Creating an agent', 'The
// network', 'Where you live') onto pre-v2 orchestrator SOULs so existing
// fleets pick up the never-clone-your-SOUL guidance without a re-onboard.
// Fresh orchestrators skip cleanly via the <!-- circe:orchestrator v2 -->
// marker embedded in the template body.
const REFERENCES_VERSION = 3;

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
  return loadProfilesFromList(runHermes, HERMES_HOME);
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
    onAutoRestart: (payload) => {
      if (win.isDestroyed()) return;
      win.webContents.send('acp:autoRestart', payload);
    },
    onMcpAuthNeeded: (payload) => {
      if (win.isDestroyed()) return;
      win.webContents.send('acp:mcpAuthNeeded', payload);
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

if (process.argv.includes('--reset-onboarding')) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const p = STATE_FILE;
    let s = { profiles: {} };
    try { s = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
    s.firstRunComplete = false;
    fs.writeFileSync(p, JSON.stringify(s, null, 2));
    log.info(`--reset-onboarding flipped firstRunComplete=false in ${p}`);
  } catch (err) {
    log.error('--reset-onboarding failed:', err.message);
  }
}

async function openAllTiles() {
  const profiles = await loadProfiles();
  if (!profiles.length) {
    throw new Error('No Hermes profiles found.');
  }
  log.info(`Loaded ${profiles.length} profile(s): ${profiles.map((p) => p.name).join(', ')}`);
  profiles.forEach((p, i) => {
    if (openProfiles.has(p.name)) return;
    openProfiles.add(p.name);
    createTileWindow(p, i);
  });
  watchProfilesDir();
}

function adoptLegacyState() {
  const real = listRealProfiles(HERMES_HOME);
  if (real.length === 0) {
    throw new Error('No profiles found during adoption');
  }
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

// One-time-per-version backfill of the DJ tooling reference and SOUL
// pointer on the ORCHESTRATOR profile, plus cleanup of any stray copies
// on non-orchestrator profiles (fallout from v1's over-broad scope).
// Runs at each startup but no-ops once state.json.referencesVersion has
// caught up. Bump REFERENCES_VERSION (top of file) whenever the shipped
// reference or SOUL pointer changes.
async function backfillReferencesIfNeeded() {
  const current = Number(stateCache.referencesVersion || 0);
  if (current >= REFERENCES_VERSION) return;
  const real = listRealProfiles(HERMES_HOME);
  if (real.length === 0) {
    stateCache.referencesVersion = REFERENCES_VERSION;
    writeStateFile(stateCache);
    return;
  }
  const orchestrator = stateCache.orchestratorProfile;
  const others = real.filter((n) => n !== orchestrator);
  log.info(
    `References backfill: v${current} → v${REFERENCES_VERSION}; ` +
    `orchestrator=${orchestrator || '(unset)'}, others=${others.join(', ') || 'none'}`,
  );
  try {
    if (orchestrator && real.includes(orchestrator)) {
      const r = await refreshOrchestratorReferences({
        hermesHome: HERMES_HOME,
        orchestratorProfile: orchestrator,
      });
      if (r.referenceError) {
        log.warn(`  ${r.profile}: dj-tooling.md write failed: ${r.referenceError}`);
      }
      if (r.soulError) {
        log.warn(`  ${r.profile}: SOUL patch failed: ${r.soulError}`);
      }
      log.info(
        `  orchestrator ${r.profile}: dj-tooling.md=${r.referenceWritten ? 'ok' : 'skip'}, ` +
        `SOUL patched=${r.soulPatched ? 'yes' : 'no'}`,
      );
    } else if (orchestrator) {
      log.warn(
        `state.orchestratorProfile=${orchestrator} but that profile is not ` +
        `on disk; skipping orchestrator reference refresh`,
      );
    } else {
      log.warn('No orchestratorProfile in state; skipping orchestrator refresh');
    }
    if (others.length) {
      const prunes = await pruneStaleReferences({
        hermesHome: HERMES_HOME,
        profileNames: others,
      });
      for (const p of prunes) {
        if (p.referenceError) {
          log.warn(`  ${p.profile}: dj-tooling.md remove failed: ${p.referenceError}`);
        }
        if (p.soulError) {
          log.warn(`  ${p.profile}: SOUL strip failed: ${p.soulError}`);
        }
        if (p.referenceRemoved || p.soulStripped) {
          log.info(
            `  pruned ${p.profile}: dj-tooling.md=${p.referenceRemoved ? 'removed' : 'skip'}, ` +
            `SOUL stripped=${p.soulStripped ? 'yes' : 'no'}`,
          );
        }
      }
    }
    stateCache.referencesVersion = REFERENCES_VERSION;
    writeStateFile(stateCache);
  } catch (err) {
    log.error('References backfill threw:', err.message || String(err));
  }
}

app.whenReady().then(async () => {
  log.info('app ready');
  await setupCaTrust({
    userDataDir: app.getPath('userData'),
    hermesBin: HERMES_BIN,
    log,
  });

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
          // Wizard just wrote a fresh profile with the current reference
          // and SOUL pointer, so stamp the version to skip future backfills.
          await backfillReferencesIfNeeded();
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

  // Version-gated backfill: brings pre-existing profiles up to the current
  // shipped dj-tooling.md and SOUL pointer. Idempotent no-op once caught up.
  await backfillReferencesIfNeeded();

  try {
    await openAllTiles();
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

ipcMain.handle('avatar:pick', async (evt) => {
  const name = tileProfiles.get(evt.sender.id);
  if (!name) return { ok: false, error: 'no profile bound to window' };
  const win = BrowserWindow.fromWebContents(evt.sender);
  const result = await dialog.showOpenDialog(win, {
    title: `Choose a new avatar for ${readDisplayName(name)}`,
    properties: ['openFile'],
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
    ],
  });
  if (result.canceled || !result.filePaths || !result.filePaths.length) {
    return { ok: false, canceled: true };
  }
  const src = result.filePaths[0];
  const profileDir =
    name === 'default' ? HERMES_HOME : path.join(HERMES_HOME, 'profiles', name);
  try {
    const buf = fs.readFileSync(src);
    await saveAsAvatar(buf, profileDir);
    // The wizard writes avatar.png, but earlier or hand-installed profiles
    // may have avatar.jpg/gif/webp on disk. loadAvatarDataUrl picks whichever
    // extension it hits first — leave a stale one behind and the tile will
    // render it instead of the new PNG.
    for (const ext of ['jpg', 'jpeg', 'gif', 'webp']) {
      try {
        fs.unlinkSync(path.join(profileDir, `avatar.${ext}`));
      } catch (err) {
        if (err && err.code !== 'ENOENT') {
          log.warn(`avatar cleanup (${ext}) failed for ${name}: ${err.message}`);
        }
      }
    }
    log.info(`avatar swapped for ${name} from ${src}`);
    return { ok: true, dataUrl: loadAvatarDataUrl(name) };
  } catch (err) {
    log.error(`avatar swap failed for ${name}: ${err.message}`);
    return { ok: false, error: err.message || String(err) };
  }
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
    // Encode structured detail in the thrown message so Electron's default
    // IPC error serializer (which drops non-message fields) still delivers it.
    // Renderer parses via JSON.parse fallback in renderer.js.
    const e = new Error(JSON.stringify(serializeAcpError(err)));
    e.name = 'AcpError';
    throw e;
  }
});

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
